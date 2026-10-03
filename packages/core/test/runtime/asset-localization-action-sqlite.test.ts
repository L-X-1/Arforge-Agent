import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { asc, eq } from "drizzle-orm"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventTable } from "@arforge-ai/core/event/sql"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Egress } from "@arforge-ai/core/egress"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { PermissionV2 } from "@arforge-ai/core/permission"
import * as AssetLocalization from "@arforge-ai/core/runtime/asset-localization"
import * as AssetLocalizationAction from "@arforge-ai/core/runtime/asset-localization-action"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { EventV2 } from "@arforge-ai/core/event"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { tmpdir as makeTmpdir } from "../fixture/tmpdir"

type PermissionMode = "allow" | "deny" | "wait"

const testSecrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(11), "asset-localization-sqlite-secret")

const makePermissionLayer = (mode: PermissionMode, counters: { assertions: number }) =>
  Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      ask: (input) =>
        Effect.succeed({
          id: input.id ?? PermissionV2.ID.create(),
          effect: mode === "allow" ? ("allow" as const) : ("deny" as const),
        }),
      assert: () => {
        counters.assertions += 1
        if (mode === "allow") return Effect.void
        if (mode === "wait") return Effect.never
        return Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
      },
      reply: () => Effect.void,
      get: () => Effect.succeed(undefined),
      forSession: () => Effect.succeed([]),
      list: () => Effect.succeed([]),
    }),
  )

const makeRuntimeLayer = (databasePath: string, permission: Layer.Layer<PermissionV2.Service>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableAction.node,
      DurableRun.node,
      Authorizer.node,
      ActionGateway.node,
    ]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [PermissionV2.node, permission],
      [SecretProvider.node, Layer.succeed(SecretProvider.Service, testSecrets)],
    ],
  )

const digest = (value: Uint8Array | string) =>
  createHash("sha256")
    .update(typeof value === "string" ? new TextEncoder().encode(value) : value)
    .digest("hex")

const clone = (value: Uint8Array) => new Uint8Array(value)

const makeFixture = () => {
  const worktree = process.cwd()
  const htmlResource = "src/index.html"
  const html = '<script src="https://cdn.example.test/app.js"></script>'
  const htmlBytes = new TextEncoder().encode(html)
  const appBytes = new TextEncoder().encode("console.log('sqlite')")
  const filesByCanonical = new Map<string, Uint8Array>()
  const fetched: string[] = []

  const target = (resource: string): FileMutation.Target => ({
    canonical: path.resolve(worktree, resource.split("/").join(path.sep)),
    resource,
  })
  filesByCanonical.set(target(htmlResource).canonical, clone(htmlBytes))

  const readFile = (value: FileMutation.Target) => Effect.succeed(filesByCanonical.get(value.canonical)?.slice())
  const files: Pick<FileMutation.Interface, "create" | "writeIfUnchanged" | "rollback"> = {
    create: (input) =>
      Effect.gen(function* () {
        if (filesByCanonical.has(input.target.canonical))
          return yield* new FileMutation.TargetExistsError({ path: input.target.canonical })
        filesByCanonical.set(
          input.target.canonical,
          clone(typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content),
        )
        return {
          operation: "write" as const,
          target: input.target.canonical,
          resource: input.target.resource,
          existed: false,
        }
      }),
    writeIfUnchanged: (input) =>
      Effect.gen(function* () {
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
        return {
          operation: "write" as const,
          target: input.target.canonical,
          resource: input.target.resource,
          existed: true,
        }
      }),
    rollback: (input) =>
      Effect.gen(function* () {
        const current = filesByCanonical.get(input.target.canonical)
        if (input.kind === "remove-created") {
          if (!current || digest(current) !== digest(input.expected))
            return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
          filesByCanonical.delete(input.target.canonical)
          return {
            operation: "remove" as const,
            target: input.target.canonical,
            resource: input.target.resource,
            existed: true,
          }
        }
        if (input.kind === "restore") {
          if (!current || digest(current) !== digest(input.expected))
            return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
          filesByCanonical.set(input.target.canonical, clone(input.content))
          return {
            operation: "write" as const,
            target: input.target.canonical,
            resource: input.target.resource,
            existed: true,
          }
        }
        if (filesByCanonical.has(input.target.canonical))
          return yield* new FileMutation.TargetExistsError({ path: input.target.canonical })
        filesByCanonical.set(input.target.canonical, clone(input.content))
        return {
          operation: "write" as const,
          target: input.target.canonical,
          resource: input.target.resource,
          existed: false,
        }
      }),
  }

  const action = (discovery: AssetLocalization.AssetDiscovery): ActionGateway.Input => {
    const subject = {
      sessionID: SessionSchema.ID.make("ses_asset_sqlite"),
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make("msg_asset_sqlite"),
      toolCallID: "call_asset_sqlite",
    }
    return {
      ...subject,
      actionID: ActionGateway.stableActionID(subject),
      name: AssetLocalizationAction.ACTION_NAME,
      resources: AssetLocalizationAction.actionResources(discovery),
      semantics: AgentRuntime.EffectSemantics.make({
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
      }),
      reasonSummary: "Localize external frontend assets into the workspace",
      inputDigest: discovery.requestDigest,
    }
  }

  const input = (gateway: AssetLocalizationAction.AssetLocalizationActionInput["gateway"], failDownload = false) =>
    ({
      gateway,
      worktree,
      htmlResource,
      assetRoot: "vendor",
      action,
      readFile,
      files,
      egress: (capability) => {
        const requests = ActionGateway.capabilityRequests(capability)
        const networkScope = requests
          .flatMap((request) => request.resources)
          .filter((resource) => resource.startsWith("http"))
        return Egress.make({
          action: AssetLocalizationAction.ACTION_NAME,
          networkScope,
          secretScope: [],
          allowedMethods: ["GET"],
          grantedResources: requests.flatMap((request) => request.resources),
        })
      },
      fetchAsset: ({ url, egress }) =>
        Effect.gen(function* () {
          fetched.push(url)
          yield* egress.assert({ url, method: "GET" })
          if (failDownload) return yield* Effect.fail(new Error("CDN download failed in isolated acceptance"))
          return { url, contentType: "text/javascript", bytes: clone(appBytes) }
        }),
      storeRollbackArtifact: (bytes) => {
        const value = digest(bytes)
        return Effect.succeed({
          version: 1 as const,
          artifactID: `rollback-${value}`,
          digest: value,
          byteLength: bytes.byteLength,
        })
      },
    }) satisfies AssetLocalizationAction.AssetLocalizationActionInput

  return { input, action, appBytes, htmlBytes, target, filesByCanonical, fetched }
}

const runWith = <A, E, R>(effect: Effect.Effect<A, E, R>, layer: Layer.Layer<R, never>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)))

describe("AssetLocalizationAction SQLite acceptance", () => {
  test("persists one approval, one action aggregate, and settled mutation metadata", async () => {
    const temporary = await makeTmpdir()
    const root = temporary.path
    try {
      const counters = { assertions: 0 }
      const databasePath = path.join(root, "approval.sqlite")
      const fixture = makeFixture()
      const layer = makeRuntimeLayer(databasePath, makePermissionLayer("allow", counters))
      const result = await runWith(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const database = yield* Database.Service
          const value = yield* AssetLocalizationAction.execute(fixture.input(gateway))
          const action = fixture.action(
            AssetLocalization.discover({
              htmlResource: fixture.input(gateway).htmlResource,
              html: fixture.htmlBytes,
              assetRoot: "vendor",
            }),
          )
          const state = yield* actions.load(action.actionID)
          const rows = yield* database.db
            .select({ type: EventTable.type, data: EventTable.data })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, action.actionID))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)
          return { value, state, rows }
        }),
        layer,
      )

      expect(result.value.changed).toBe(true)
      expect(result.state.action.status).toBe("settled")
      expect(result.state.progress?.phase).toBe("settled")
      expect(result.state.progress?.completed).toBe(2)
      expect(result.state.progress?.total).toBe(2)
      expect(result.state.mutationIntent?.phase).toBe("settled")
      expect(result.state.mutationIntent?.entries).toHaveLength(2)
      expect(counters.assertions).toBe(1)
      expect(fixture.fetched).toEqual(["https://cdn.example.test/app.js"])
      expect(result.rows.map((row) => row.type)).toContain("agent.action.mutation-intent-recorded.1")
      expect(result.rows.map((row) => row.type)).toContain("agent.action.progress-recorded.1")
      expect(JSON.stringify(result.rows)).not.toContain("console.log('sqlite')")
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("denied permission stops before download, mutation intent, or workspace change", async () => {
    const temporary = await makeTmpdir()
    const root = temporary.path
    try {
      const counters = { assertions: 0 }
      const fixture = makeFixture()
      const layer = makeRuntimeLayer(path.join(root, "deny.sqlite"), makePermissionLayer("deny", counters))
      const result = await runWith(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const exit = yield* AssetLocalizationAction.execute(fixture.input(gateway)).pipe(Effect.exit)
          const action = fixture.action(
            AssetLocalization.discover({
              htmlResource: "src/index.html",
              html: fixture.htmlBytes,
              assetRoot: "vendor",
            }),
          )
          return { exit, state: yield* actions.load(action.actionID) }
        }),
        layer,
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.state.action.status).toBe("blocked")
      expect(result.state.mutationIntent).toBeUndefined()
      expect(counters.assertions).toBe(1)
      expect(fixture.fetched).toEqual([])
      expect(fixture.filesByCanonical.size).toBe(1)
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("download failure is durably observed as blocked without a mutation manifest", async () => {
    const temporary = await makeTmpdir()
    const root = temporary.path
    try {
      const counters = { assertions: 0 }
      const fixture = makeFixture()
      const layer = makeRuntimeLayer(path.join(root, "download-failure.sqlite"), makePermissionLayer("allow", counters))
      const result = await runWith(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const exit = yield* AssetLocalizationAction.execute(fixture.input(gateway, true)).pipe(Effect.exit)
          const action = fixture.action(
            AssetLocalization.discover({
              htmlResource: "src/index.html",
              html: fixture.htmlBytes,
              assetRoot: "vendor",
            }),
          )
          return { exit, state: yield* actions.load(action.actionID) }
        }),
        layer,
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.state.action.status).toBe("blocked")
      expect(result.state.mutationIntent).toBeUndefined()
      expect(counters.assertions).toBe(1)
      expect(fixture.fetched).toEqual(["https://cdn.example.test/app.js"])
      expect(fixture.filesByCanonical.size).toBe(1)
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("cancelling while approval is pending leaves a durable cancelled action and no files", async () => {
    const temporary = await makeTmpdir()
    const root = temporary.path
    try {
      const counters = { assertions: 0 }
      const fixture = makeFixture()
      const layer = makeRuntimeLayer(path.join(root, "cancel.sqlite"), makePermissionLayer("wait", counters))
      const result = await runWith(
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const discovery = AssetLocalization.discover({
            htmlResource: "src/index.html",
            html: fixture.htmlBytes,
            assetRoot: "vendor",
          })
          const presented = fixture.action(discovery)
          const authorization = AssetLocalizationAction.authorizationPlan(discovery)
          const running = yield* AssetLocalizationAction.execute(fixture.input(gateway)).pipe(Effect.forkChild)
          for (let attempt = 0; attempt < 100 && counters.assertions === 0; attempt += 1)
            yield* Effect.sleep("10 millis")
          const assertions = counters.assertions
          yield* gateway.cancelPendingAction(presented, authorization, "User cancelled asset localization approval")
          yield* Fiber.interrupt(running)
          const exit = yield* Fiber.join(running).pipe(Effect.exit)
          return { assertions, exit, state: yield* actions.load(presented.actionID) }
        }),
        layer,
      )

      expect(result.assertions).toBe(1)
      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.state.action.status).toBe("cancelled")
      expect(result.state.mutationIntent).toBeUndefined()
      expect(fixture.fetched).toEqual([])
      expect(fixture.filesByCanonical.size).toBe(1)
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }, 20_000)

  test("settlement recording loss becomes outcome_unknown and never retries the committed files", async () => {
    const temporary = await makeTmpdir()
    const root = temporary.path
    try {
      const counters = { assertions: 0 }
      const fixture = makeFixture()
      const layer = makeRuntimeLayer(
        path.join(root, "settlement-unknown.sqlite"),
        makePermissionLayer("allow", counters),
      )
      const result = await runWith(
        Effect.gen(function* () {
          const service = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const originalRecord = service.recordMutationIntent
          if (!originalRecord) return yield* Effect.die(new Error("mutation recorder is unavailable"))
          const gateway: AssetLocalizationAction.AssetLocalizationActionInput["gateway"] = {
            execute: service.execute,
            recordMutationIntent: (input) =>
              input.phase === "settled"
                ? Effect.die(new Error("simulated SQLite settlement write loss"))
                : originalRecord(input),
          }
          const exit = yield* AssetLocalizationAction.execute(fixture.input(gateway)).pipe(Effect.exit)
          const action = fixture.action(
            AssetLocalization.discover({
              htmlResource: "src/index.html",
              html: fixture.htmlBytes,
              assetRoot: "vendor",
            }),
          )
          return { exit, state: yield* actions.load(action.actionID) }
        }),
        layer,
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.state.action.status).toBe("blocked")
      expect(result.state.mutationIntent?.phase).toBe("outcome_unknown")
      expect(counters.assertions).toBe(1)
      expect(fixture.fetched).toEqual(["https://cdn.example.test/app.js"])
      expect(fixture.filesByCanonical.size).toBe(2)
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  }, 20_000)
})
