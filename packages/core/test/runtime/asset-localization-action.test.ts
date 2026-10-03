import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Egress } from "@arforge-ai/core/egress"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"

const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(typeof value === "string" ? new TextEncoder().encode(value) : value).digest("hex")

const clone = (value: Uint8Array) => new Uint8Array(value)

const makeFixture = (options: { readonly failTarget?: string } = {}) => {
  const worktree = process.cwd()
  const htmlResource = "src/index.html"
  const html = '<script src="https://cdn.example.test/app.js"></script>'
  const htmlBytes = new TextEncoder().encode(html)
  const appBytes = new TextEncoder().encode("console.log('ok')")
  const filesByCanonical = new Map<string, Uint8Array>()
  const records: Array<{ phase: AgentRuntime.MutationIntentPhase; entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> }> = []
  const fetched: string[] = []
  const progress: AssetLocalizationAction.AssetLocalizationProgress[] = []
  const egressRequests: Array<{ url: string; redirectFrom?: string }> = []
  let observedInput: ActionGateway.Input | undefined
  let observedAuthorization: ActionGateway.AuthorizationPlan | undefined
  let mutateHTMLDuringFetch = false

  const target = (resource: string): FileMutation.Target => ({
    canonical: path.resolve(worktree, resource.split("/").join(path.sep)),
    resource,
  })
  filesByCanonical.set(target(htmlResource).canonical, clone(htmlBytes))

  const readFile = (value: FileMutation.Target) => Effect.succeed(filesByCanonical.get(value.canonical)?.slice())
  const files: Pick<FileMutation.Interface, "create" | "writeIfUnchanged" | "rollback"> = {
    create: (input) =>
      Effect.gen(function* () {
        if (options.failTarget === input.target.resource)
          return yield* new FileMutation.TargetExistsError({ path: input.target.canonical })
        if (filesByCanonical.has(input.target.canonical))
          return yield* new FileMutation.TargetExistsError({ path: input.target.canonical })
        filesByCanonical.set(input.target.canonical, clone(typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content))
        return { operation: "write" as const, target: input.target.canonical, resource: input.target.resource, existed: false }
      }),
    writeIfUnchanged: (input) =>
      Effect.gen(function* () {
        if (options.failTarget === input.target.resource)
          return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
        const current = filesByCanonical.get(input.target.canonical)
        if (!current || digest(current) !== digest(input.expected))
          return yield* new FileMutation.StaleContentError({
            path: input.target.canonical,
            observedVersion: digest(input.expected),
            ...(current ? { currentVersion: digest(current) } : {}),
          })
        filesByCanonical.set(
          input.target.canonical,
          clone(typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content),
        )
        return { operation: "write" as const, target: input.target.canonical, resource: input.target.resource, existed: true }
      }),
    rollback: (input) =>
      Effect.gen(function* () {
        const current = filesByCanonical.get(input.target.canonical)
        if (input.kind === "remove-created") {
          if (!current || digest(current) !== digest(input.expected))
            return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
          filesByCanonical.delete(input.target.canonical)
          return { operation: "remove" as const, target: input.target.canonical, resource: input.target.resource, existed: true }
        }
        if (input.kind === "restore") {
          if (!current || digest(current) !== digest(input.expected))
            return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
          filesByCanonical.set(input.target.canonical, clone(input.content))
          return { operation: "write" as const, target: input.target.canonical, resource: input.target.resource, existed: true }
        }
        if (filesByCanonical.has(input.target.canonical))
          return yield* new FileMutation.TargetExistsError({ path: input.target.canonical })
        filesByCanonical.set(input.target.canonical, clone(input.content))
        return { operation: "write" as const, target: input.target.canonical, resource: input.target.resource, existed: false }
      }),
  }

  const gateway = {
    execute: (input: ActionGateway.Input, operation: ActionGateway.Operation<AssetLocalizationAction.AssetLocalizationActionResult, unknown, never>) => {
      observedInput = input
      observedAuthorization = operation.authorization
      return operation.execute({} as ActionGateway.AuthorizationGrantCapability)
    },
    recordMutationIntent: (input: Parameters<NonNullable<ActionGateway.Interface["recordMutationIntent"]>>[0]) => {
      records.push({ phase: input.phase, entries: input.entries })
      return Effect.succeed({} as never)
    },
  } as unknown as Pick<ActionGateway.Interface, "execute" | "recordMutationIntent">

  const discoveryAction = (discovery: AssetLocalization.AssetDiscovery): ActionGateway.Input => {
    const subject = {
      sessionID: SessionSchema.ID.make("ses_asset_localization"),
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make("msg_asset_localization"),
      toolCallID: "call_asset_localization",
    }
    const semantics = AgentRuntime.EffectSemantics.make({
      riskTier: "L2",
      authority: "scoped_grant",
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "compensatable",
      filesystemScope: [discovery.htmlResource, AssetLocalizationAction.filesystemPrefixResource(discovery)],
      networkScope: discovery.networkScope,
      secretScope: [],
      externalServices: ["HTTP origin from asset references"],
      expectedArtifacts: [discovery.htmlResource],
      successCriteria: ["every staged asset and the HTML rewrite commit or roll back atomically"],
    })
    return {
      ...subject,
      actionID: ActionGateway.stableActionID(subject),
      name: AssetLocalizationAction.ACTION_NAME,
      resources: AssetLocalizationAction.actionResources(discovery),
      semantics,
      reasonSummary: "Localize external frontend assets into the workspace",
      inputDigest: discovery.requestDigest,
    }
  }

  const input: AssetLocalizationAction.AssetLocalizationActionInput = {
    gateway,
    worktree,
    htmlResource,
    assetRoot: "vendor",
    action: discoveryAction,
    readFile,
    files,
    egress: () => ({
      assert: (request) =>
        Effect.sync(() => {
          egressRequests.push({ url: request.url, ...(request.redirectFrom ? { redirectFrom: request.redirectFrom } : {}) })
        }),
    }),
    fetchAsset: ({ url }) =>
      Effect.sync(() => {
        fetched.push(url)
        if (mutateHTMLDuringFetch) filesByCanonical.set(target(htmlResource).canonical, new TextEncoder().encode("<html changed>"))
        return {
          url,
          contentType: "text/javascript",
          bytes: clone(appBytes),
        }
      }),
    storeRollbackArtifact: (bytes) => {
      const value = digest(bytes)
      return Effect.succeed({ version: 1 as const, artifactID: `rollback-${value}`, digest: value, byteLength: bytes.byteLength })
    },
    onProgress: (update) => Effect.sync(() => progress.push(update)),
  }

  return {
    input,
    appBytes,
    htmlBytes,
    target,
    filesByCanonical,
    records,
    fetched,
    egressRequests,
    progress,
    get observedInput() {
      return observedInput
    },
    get observedAuthorization() {
      return observedAuthorization
    },
    set mutateHTMLDuringFetch(value: boolean) {
      mutateHTMLDuringFetch = value
    },
  }
}

describe("AssetLocalizationAction", () => {
  test("authorizes the discovery snapshot, fetches through one egress seam, and commits a durable CAS transaction", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(AssetLocalizationAction.execute(fixture.input))

    expect(result.changed).toBe(true)
    expect(result.discoveryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.targets).toHaveLength(2)
    expect(fixture.fetched).toEqual(["https://cdn.example.test/app.js"])
    expect(fixture.egressRequests).toEqual([{ url: "https://cdn.example.test/app.js" }])
    expect(fixture.observedInput?.name).toBe(AssetLocalizationAction.ACTION_NAME)
    expect(fixture.observedInput?.inputDigest).toBe(result.discoveryDigest)
    expect(fixture.observedAuthorization?.requests).toEqual([
      {
        action: AssetLocalizationAction.ACTION_NAME,
        resources: [
          "file-prefix:src/vendor",
          "file:src/index.html",
          "https://cdn.example.test/app.js",
        ],
      },
    ])
    expect(fixture.records.map((record) => record.phase)).toEqual(["prepared", "committed", "settled"])
    const html = new TextDecoder().decode(fixture.filesByCanonical.get(fixture.target("src/index.html").canonical)!)
    expect(html).toContain(`vendor/js/${digest(fixture.appBytes)}.js`)
    expect(fixture.filesByCanonical.has(fixture.target(`src/vendor/js/${digest(fixture.appBytes)}.js`).canonical)).toBe(true)
    expect(fixture.progress.map((item) => item.phase)).toContain("fetching")
    expect(fixture.progress.map((item) => item.phase)).toContain("committing")
    expect(fixture.progress.at(-1)).toMatchObject({ phase: "settled", completed: 2, total: 2 })
    expect(fixture.progress.every((item) => item.completed <= item.total)).toBe(true)
  })

  test("cancels an in-flight fetch without writing files and emits a bounded cancellation state", async () => {
    const fixture = makeFixture()
    const input: AssetLocalizationAction.AssetLocalizationActionInput = {
      ...fixture.input,
      fetchAsset: () => Effect.never,
    }
    const fiber = Effect.runFork(AssetLocalizationAction.execute(input))
    for (let attempt = 0; attempt < 100 && !fixture.progress.some((item) => item.phase === "fetching"); attempt += 1)
      await Bun.sleep(5)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fixture.progress.some((item) => item.phase === "cancelled")).toBe(true)
    expect(fixture.records).toEqual([])
    expect(fixture.filesByCanonical.size).toBe(1)
  })

  test("rolls back staged files when the final HTML CAS commit fails", async () => {
    const fixture = makeFixture({ failTarget: "src/index.html" })
    const exit = await Effect.runPromiseExit(AssetLocalizationAction.execute(fixture.input))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.records.map((record) => record.phase)).toEqual(["prepared", "rollback_required", "rolled_back"])
    expect(new TextDecoder().decode(fixture.filesByCanonical.get(fixture.target("src/index.html").canonical)!)).toBe(
      '<script src="https://cdn.example.test/app.js"></script>',
    )
    expect(fixture.filesByCanonical.has(fixture.target(`src/vendor/js/${digest(fixture.appBytes)}.js`).canonical)).toBe(false)
  })

  test("re-plans after fetching and refuses a source drift before recording or writing", async () => {
    const fixture = makeFixture()
    fixture.mutateHTMLDuringFetch = true
    const exit = await Effect.runPromiseExit(AssetLocalizationAction.execute(fixture.input))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.records).toEqual([])
    expect(fixture.filesByCanonical.size).toBe(1)
    expect(new TextDecoder().decode(fixture.filesByCanonical.get(fixture.target("src/index.html").canonical)!)).toBe(
      "<html changed>",
    )
  })

  test("rejects a redirect outside the pre-authorized egress origin before planning writes", async () => {
    const fixture = makeFixture()
    const strictEgress = Egress.make({
      action: AssetLocalizationAction.ACTION_NAME,
      networkScope: ["https://cdn.example.test/app.js"],
      secretScope: [],
      allowedMethods: ["GET"],
      grantedResources: ["https://cdn.example.test/app.js"],
    })
    const input: AssetLocalizationAction.AssetLocalizationActionInput = {
      ...fixture.input,
      egress: () => strictEgress,
      fetchAsset: ({ url }) =>
        Effect.succeed({
          url,
          redirects: ["https://evil.example.test/app.js"],
          finalURL: "https://evil.example.test/app.js",
          contentType: "text/javascript",
          bytes: fixture.appBytes,
        }),
    }
    const exit = await Effect.runPromiseExit(AssetLocalizationAction.execute(input))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fixture.records).toEqual([])
    expect(fixture.filesByCanonical.size).toBe(1)
  })
})
