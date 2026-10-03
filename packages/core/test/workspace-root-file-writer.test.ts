import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect, Exit, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { testEffect } from "./lib/effect"
import { commitWorkspaceRootMutation, executeWorkspaceRootMutation } from "../src/workspace-root-writer"
import {
  inspectWorkspaceRootFileWriter,
  makeWorkspaceRootFileWriter,
  workspaceRootFileWriterPaths,
} from "../src/workspace-root-file-writer"
import {
  planWorkspaceRootMutation,
  readWorkspaceRootMutationStateAt,
  workspaceRootMutationIntentDigest,
  workspaceRootMutationStateDigest,
} from "../src/workspace-roots"

const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const secretLayer = Layer.succeed(
  SecretProvider.Service,
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(9), "workspace-root-writer-test-secret"),
)
const itEffect = testEffect(
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
      [PermissionV2.node, permissionLayer],
      [SecretProvider.node, secretLayer],
    ],
  ),
)
const deniedPermissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "deny" }),
    assert: () => Effect.fail(new PermissionV2.BlockedError({ rules: [] })),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const itDeniedEffect = testEffect(
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
      [PermissionV2.node, deniedPermissionLayer],
      [SecretProvider.node, secretLayer],
    ],
  ),
)

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "arforge-workspace-file-"))
  const target = await mkdtemp(join(tmpdir(), "arforge-workspace-file-target-"))
  const profile = join(root, "profile")
  const request = {
    action: "trust" as const,
    primary: root,
    primaryIsDirectory: true,
    target,
    targetIsDirectory: true,
    trustedWorkspaces: [] as string[],
    configuredRoots: [] as string[],
  }
  const authorization = {
    kind: "action-gateway" as const,
    status: "approved" as const,
    receiptID: "receipt-file-writer",
    actionID: "action-file-writer",
    workspace: resolve(root),
    target: resolve(target),
    intentDigest: workspaceRootMutationIntentDigest(request),
  }
  const plan = planWorkspaceRootMutation({ ...request, authorization })
  return { root, target, profile, request, authorization, plan }
}

const workspaceAction = (root: string, target: string, toolCallID: string): ActionGateway.Input => {
  const session = {
    sessionID: SessionSchema.ID.create(),
    assistantMessageID: SessionMessage.ID.create(),
    toolCallID,
  }
  const request = {
    action: "trust" as const,
    primary: root,
    primaryIsDirectory: true,
    target,
    targetIsDirectory: true,
    trustedWorkspaces: [] as string[],
    configuredRoots: [] as string[],
  }
  return {
    kind: "session",
    ...session,
    actionID: ActionGateway.stableActionID(session),
    agent: AgentV2.ID.make("build"),
    name: "workspace.root.trust",
    resources: [root, target],
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L3",
      authority: "human",
      idempotency: "idempotent",
      retryability: "safe",
      reversibility: "reversible",
      compensation: "restore-workspace-root-state",
      filesystemScope: [root, target],
      networkScope: [],
      secretScope: [],
      externalServices: [],
      expectedArtifacts: ["workspace root state"],
      successCriteria: ["workspace root state committed"],
    }),
    reasonSummary: "ActionGateway workspace root mutation integration probe",
    inputDigest: workspaceRootMutationIntentDigest(request),
  }
}

const planFor = (input: {
  action: "trust" | "add" | "remove"
  primary: string
  target: string
  trustedWorkspaces: string[]
  configuredRoots: string[]
}) => {
  const request = {
    ...input,
    primaryIsDirectory: true,
    targetIsDirectory: true,
  }
  const authorization = {
    kind: "action-gateway" as const,
    status: "approved" as const,
    receiptID: `receipt-file-${input.action}`,
    actionID: `action-file-${input.action}`,
    workspace: resolve(input.primary),
    target: resolve(input.target),
    intentDigest: workspaceRootMutationIntentDigest(request),
  }
  return { request, authorization, plan: planWorkspaceRootMutation({ ...request, authorization }) }
}

describe("workspace root local file owner", () => {
  test("persists trust through journaled CAS and metadata-only outbox/audit", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({
        profileDirectory: item.profile,
        primary: item.root,
        enabled: true,
      })
      const result = await Effect.runPromise(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      expect(result.status).toBe("committed")
      expect(result.rollbackArtifactID).toMatch(/^workspace-rollback-[a-f0-9]{64}$/)
      const state = readWorkspaceRootMutationStateAt(item.profile, item.root)
      expect(state.trustedWorkspaces).toEqual([resolve(item.target)])
      expect(state.configuredRoots).toEqual([])
      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
      const outbox = JSON.parse(await readFile(paths.outboxFile, "utf8")) as Array<{ phase: string }>
      expect(outbox.map((record) => record.phase)).toEqual(["prepared", "committed"])
      const audit = JSON.parse(await readFile(paths.auditFile, "utf8")) as Array<{ phase: string }>
      expect(audit.map((record) => record.phase)).toEqual(["committed"])
      const preflight = inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })
      expect(preflight).toMatchObject({
        execution_mode: "read-only-workspace-root-writer-preflight",
        side_effects: "none",
        status: "clear",
        ready: true,
        blocking_reasons: [],
      })
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("recovers a prepared journal with a partial state from its rollback artifact", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      const before = {
        trustedWorkspaces: [] as string[],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
      }
      const after = {
        trustedWorkspaces: [resolve(item.target)],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [resolve(item.target)], configuredRoots: [] }),
      }
      const rollbackArtifactID = `workspace-rollback-${createHash("sha256")
        .update(JSON.stringify({ before, intentDigest: item.plan.intentDigest }))
        .digest("hex")}`
      await mkdir(paths.rollbackDirectory, { recursive: true })
      await writeFile(join(paths.rollbackDirectory, `${rollbackArtifactID}.json`), JSON.stringify(before), "utf8")
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.journalFile,
        JSON.stringify({
          schemaVersion: 1,
          action: "trust",
          intentDigest: item.plan.intentDigest,
          phase: "prepared",
          before,
          after,
          rollbackArtifactID,
        }),
        "utf8",
      )
      // A malformed configured file represents the crash window between the
      // two legacy state-file replacements.
      await writeFile(paths.configuredFile, JSON.stringify({ roots: "partial" }), "utf8")

      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const recovered = await Effect.runPromise(writer.readState())
      expect(recovered.trustedWorkspaces).toEqual([])
      expect(recovered.configuredRoots).toEqual([])
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
      expect(JSON.parse(await readFile(paths.configuredFile, "utf8"))).toEqual({ schema_version: 1, roots: [] })
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("fuses add/remove with the same trusted state and leaves trust on remove", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(item.profile, { recursive: true })
      await writeFile(
        paths.trustedFile,
        JSON.stringify({ workspaces: [resolve(item.root), resolve(item.target)] }),
        "utf8",
      )
      await writeFile(paths.configuredFile, JSON.stringify({ schema_version: 1, roots: [] }), "utf8")

      const add = planFor({
        action: "add",
        primary: item.root,
        target: item.target,
        trustedWorkspaces: [resolve(item.root), resolve(item.target)],
        configuredRoots: [],
      })
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      expect((await Effect.runPromise(commitWorkspaceRootMutation({ ...add, writer }))).status).toBe("committed")
      expect(readWorkspaceRootMutationStateAt(item.profile, item.root).configuredRoots).toEqual([resolve(item.target)])

      const remove = planFor({
        action: "remove",
        primary: item.root,
        target: item.target,
        trustedWorkspaces: [resolve(item.root), resolve(item.target)],
        configuredRoots: [resolve(item.target)],
      })
      expect((await Effect.runPromise(commitWorkspaceRootMutation({ ...remove, writer }))).status).toBe("committed")
      expect(readWorkspaceRootMutationStateAt(item.profile, item.root)).toMatchObject({
        trustedWorkspaces: [resolve(item.root), resolve(item.target)].sort((left, right) => left.localeCompare(right)),
        configuredRoots: [],
      })
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("returns a no-op without creating rollback or outbox records", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(item.profile, { recursive: true })
      await writeFile(paths.trustedFile, JSON.stringify({ workspaces: [resolve(item.target)] }), "utf8")
      const noop = planFor({
        action: "trust",
        primary: item.root,
        target: item.target,
        trustedWorkspaces: [resolve(item.target)],
        configuredRoots: [],
      })
      expect(noop.plan.status).toBe("noop")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const result = await Effect.runPromise(commitWorkspaceRootMutation({ ...noop, writer }))
      expect(result.status).toBe("noop")
      expect(await Bun.file(paths.outboxFile).exists()).toBe(false)
      expect(await Bun.file(paths.rollbackDirectory).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("leaves a prepared outbox entry durable when the CAS stage has not started", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const paths = workspaceRootFileWriterPaths(item.profile)
      await Effect.runPromise(
        writer.appendRecoveryOutbox({
          schemaVersion: 1,
          action: item.plan.action,
          intentDigest: item.plan.intentDigest,
          phase: "prepared",
          before: item.plan.before,
          after: item.plan.after,
          rollbackArtifactID: `workspace-rollback-${"f".repeat(64)}`,
        }),
      )
      expect(await Effect.runPromise(writer.readState())).toMatchObject({ trustedWorkspaces: [], configuredRoots: [] })
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1)
      expect(await Bun.file(paths.trustedFile).exists()).toBe(false)
      expect(await Bun.file(paths.configuredFile).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("blocks restart inspection when a committed outbox receipt has no matching audit", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      const record = {
        schemaVersion: 1 as const,
        action: item.plan.action,
        intentDigest: item.plan.intentDigest,
        phase: "committed" as const,
        before: item.plan.before,
        after: item.plan.after,
        rollbackArtifactID: `workspace-rollback-${"a".repeat(64)}`,
      }
      await writeFile(paths.outboxFile, JSON.stringify([record]), "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("audit_unavailable")
      expect(await Bun.file(paths.outboxFile).exists()).toBe(true)
      expect(await Bun.file(paths.auditFile).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("cleans a committed journal only after observing the exact post-state", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const committed = await Effect.runPromise(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      const paths = workspaceRootFileWriterPaths(item.profile)
      const after = readWorkspaceRootMutationStateAt(item.profile, item.root)
      const before = {
        trustedWorkspaces: [] as string[],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
      }
      await writeFile(
        paths.journalFile,
        JSON.stringify({
          schemaVersion: 1,
          action: "trust",
          intentDigest: item.plan.intentDigest,
          phase: "committed",
          before,
          after,
          rollbackArtifactID: committed.rollbackArtifactID!,
        }),
        "utf8",
      )
      expect(await Effect.runPromise(writer.readState())).toMatchObject({ trustedWorkspaces: [resolve(item.target)] })
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("fails closed when another writer owns the profile lock", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(paths.lockFile, "held", "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(exit.toString()).toContain("state_conflict")
      expect(await Bun.file(paths.trustedFile).exists()).toBe(false)
      expect(await Bun.file(paths.configuredFile).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("reclaims a lock whose recorded owner process is gone", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.lockFile,
        JSON.stringify({
          schemaVersion: 1,
          pid: 2_147_483_647,
          createdAt: Date.now(),
          token: "dead-owner-token",
        }),
        "utf8",
      )
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      expect(await Effect.runPromise(writer.readState())).toMatchObject({ trustedWorkspaces: [], configuredRoots: [] })
      expect(await Bun.file(paths.lockFile).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("recovers a real child-process crash between the two state files", async () => {
    const item = await fixture()
    const readyMarker = join(item.root, "writer-ready.marker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/workspace-root-writer-crash-worker.ts",
        item.profile,
        item.root,
        item.target,
        readyMarker,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      const exitCode = await worker.exited
      expect(exitCode).not.toBe(0)
      expect(await Bun.file(readyMarker).text()).toBe("trusted-file-written")

      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(JSON.parse(await readFile(paths.journalFile, "utf8"))).toMatchObject({ phase: "prepared" })
      expect(JSON.parse(await readFile(paths.trustedFile, "utf8"))).toEqual({ workspaces: [resolve(item.target)] })
      expect(await Bun.file(paths.configuredFile).exists()).toBe(false)

      const restarted = makeWorkspaceRootFileWriter({
        profileDirectory: item.profile,
        primary: item.root,
        enabled: true,
      })
      expect(await Effect.runPromise(restarted.readState())).toMatchObject({
        trustedWorkspaces: [],
        configuredRoots: [],
      })
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
      expect(await Bun.file(paths.lockFile).exists()).toBe(false)
      expect(JSON.parse(await readFile(paths.trustedFile, "utf8"))).toEqual({ workspaces: [] })
      expect(JSON.parse(await readFile(paths.configuredFile, "utf8"))).toEqual({ schema_version: 1, roots: [] })
    } finally {
      worker.kill()
      await worker.exited
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  }, 20_000)

  test("serializes concurrent duplicate plans and preserves one committed receipt", async () => {
    const item = await fixture()
    const startMarker = join(item.root, "writer-concurrent-start.marker")
    const readyMarkers = [
      join(item.root, "writer-concurrent-ready-a.marker"),
      join(item.root, "writer-concurrent-ready-b.marker"),
    ]
    const resultMarkers = [
      join(item.root, "writer-concurrent-result-a.json"),
      join(item.root, "writer-concurrent-result-b.json"),
    ]
    const workers = readyMarkers.map((readyMarker, index) =>
      Bun.spawn(
        [
          process.execPath,
          "test/fixture/workspace-root-writer-concurrent-worker.ts",
          item.profile,
          item.root,
          item.target,
          readyMarker,
          startMarker,
          resultMarkers[index]!,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    )

    try {
      let ready = await Promise.all(readyMarkers.map((marker) => Bun.file(marker).exists()))
      for (let attempt = 0; attempt < 400 && !ready.every(Boolean); attempt += 1) {
        await Bun.sleep(10)
        ready = await Promise.all(readyMarkers.map((marker) => Bun.file(marker).exists()))
      }
      expect(ready).toEqual([true, true])
      await writeFile(startMarker, "go", "utf8")
      const exitCodes = await Promise.all(workers.map((worker) => worker.exited))
      expect(exitCodes).toEqual([0, 0])
      const results = await Promise.all(resultMarkers.map(async (marker) => JSON.parse(await readFile(marker, "utf8"))))
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ schemaVersion: 1, status: "committed" }),
          expect.objectContaining({ schemaVersion: 1, status: "committed" }),
        ]),
      )
      const state = readWorkspaceRootMutationStateAt(item.profile, item.root)
      expect(state.trustedWorkspaces).toEqual([resolve(item.target)])
      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "prepared" }),
          expect.objectContaining({ phase: "committed" }),
        ]),
      )
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toEqual([
        expect.objectContaining({ phase: "committed" }),
      ])
      expect(inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })).toMatchObject({
        status: "clear",
        ready: true,
        blocking_reasons: [],
      })
    } finally {
      for (const worker of workers) worker.kill()
      await Promise.all(workers.map((worker) => worker.exited))
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  }, 20_000)

  test("survives a bounded restart lifecycle and exact replay without residue", async () => {
    const item = await fixture()
    const targets = await Promise.all(
      Array.from({ length: 4 }, (_, index) => mkdtemp(join(tmpdir(), `arforge-workspace-file-lifecycle-${index}-`))),
    )
    try {
      let trustedWorkspaces: string[] = []
      let configuredRoots: string[] = []
      let last: ReturnType<typeof planFor> | undefined
      const commit = async (input: ReturnType<typeof planFor>) => {
        const writer = makeWorkspaceRootFileWriter({
          profileDirectory: item.profile,
          primary: item.root,
          enabled: true,
        })
        const result = await Effect.runPromise(commitWorkspaceRootMutation({ ...input, writer }))
        expect(result.status).toBe("committed")
        expect((await Effect.runPromise(writer.readState())).digest).toEqual(
          workspaceRootMutationStateDigest({
            trustedWorkspaces: input.plan.nextTrustedWorkspaces,
            configuredRoots: input.plan.nextConfiguredRoots,
          }),
        )
        return result
      }

      for (const target of targets) {
        const input = planFor({
          action: "trust",
          primary: item.root,
          target,
          trustedWorkspaces,
          configuredRoots,
        })
        await commit(input)
        trustedWorkspaces = [...trustedWorkspaces, resolve(target)].sort((left, right) => left.localeCompare(right))
        last = input
      }
      for (const target of targets) {
        const input = planFor({
          action: "add",
          primary: item.root,
          target,
          trustedWorkspaces,
          configuredRoots,
        })
        await commit(input)
        configuredRoots = [...configuredRoots, resolve(target)].sort((left, right) => left.localeCompare(right))
        last = input
      }
      for (const target of targets) {
        const input = planFor({
          action: "remove",
          primary: item.root,
          target,
          trustedWorkspaces,
          configuredRoots,
        })
        await commit(input)
        configuredRoots = configuredRoots.filter((root) => root !== resolve(target))
        last = input
      }

      expect(last).toBeDefined()
      const duplicate = await commit(last!)
      expect(duplicate.rollbackArtifactID).toMatch(/^workspace-rollback-[a-f0-9]{64}$/)
      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
      const outbox = JSON.parse(await readFile(paths.outboxFile, "utf8")) as Array<{ phase: string }>
      expect(outbox).toHaveLength(24)
      expect(outbox.filter((record) => record.phase === "prepared")).toHaveLength(12)
      expect(outbox.filter((record) => record.phase === "committed")).toHaveLength(12)
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toHaveLength(12)
      expect(readWorkspaceRootMutationStateAt(item.profile, item.root)).toEqual({
        trustedWorkspaces,
        configuredRoots,
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces, configuredRoots }),
      })
      expect(inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })).toMatchObject({
        status: "clear",
        ready: true,
        blocking_reasons: [],
      })
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await Promise.all(targets.map((target) => rm(target, { recursive: true, force: true })))
    }
  })

  test("refuses exact replay when the committed rollback artifact is missing", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const committed = await Effect.runPromise(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      const artifact = join(
        workspaceRootFileWriterPaths(item.profile).rollbackDirectory,
        `${committed.rollbackArtifactID!}.json`,
      )
      await unlink(artifact)
      const replay = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer: makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true }),
        }),
      )
      expect(Exit.isFailure(replay)).toBe(true)
      if (Exit.isFailure(replay)) expect(replay.cause.toString()).toContain("rollback_unavailable")
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("marks a post-CAS crash before outbox promotion as recovery-required", async () => {
    const item = await fixture()
    const readyMarker = join(item.root, "writer-promotion-crash.marker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/workspace-root-writer-promotion-crash-worker.ts",
        item.profile,
        item.root,
        item.target,
        readyMarker,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      const exitCode = await worker.exited
      expect(exitCode).not.toBe(0)
      expect(await Bun.file(readyMarker).text()).toBe("after-journal-committed")

      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(JSON.parse(await readFile(paths.journalFile, "utf8"))).toMatchObject({ phase: "committed" })
      expect(JSON.parse(await readFile(paths.trustedFile, "utf8"))).toEqual({ workspaces: [resolve(item.target)] })
      expect(JSON.parse(await readFile(paths.configuredFile, "utf8"))).toEqual({ schema_version: 1, roots: [] })
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1)
      expect(await Bun.file(paths.auditFile).exists()).toBe(false)

      const restarted = makeWorkspaceRootFileWriter({
        profileDirectory: item.profile,
        primary: item.root,
        enabled: true,
      })
      const recoveryExit = await Effect.runPromiseExit(restarted.readState())
      expect(Exit.isFailure(recoveryExit)).toBe(true)
      if (Exit.isFailure(recoveryExit)) expect(recoveryExit.cause.toString()).toContain("recovery_required")
      expect(await Bun.file(paths.journalFile).exists()).toBe(true)
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toMatchObject([
        { phase: "prepared" },
        { phase: "recovery_required" },
      ])
      expect(inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })).toMatchObject({
        status: "blocked",
        ready: false,
      })
    } finally {
      worker.kill()
      await worker.exited
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  }, 20_000)

  test("marks a fully written post-image with a prepared journal as recovery-required", async () => {
    const item = await fixture()
    const readyMarker = join(item.root, "writer-prepared-promotion-crash.marker")
    const worker = Bun.spawn(
      [
        process.execPath,
        "test/fixture/workspace-root-writer-promotion-crash-worker.ts",
        item.profile,
        item.root,
        item.target,
        readyMarker,
        "after-configured-file",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    try {
      const exitCode = await worker.exited
      expect(exitCode).not.toBe(0)
      expect(await Bun.file(readyMarker).text()).toBe("after-configured-file")

      const paths = workspaceRootFileWriterPaths(item.profile)
      expect(JSON.parse(await readFile(paths.journalFile, "utf8"))).toMatchObject({ phase: "prepared" })
      expect(JSON.parse(await readFile(paths.trustedFile, "utf8"))).toEqual({ workspaces: [resolve(item.target)] })
      expect(JSON.parse(await readFile(paths.configuredFile, "utf8"))).toEqual({ schema_version: 1, roots: [] })
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1)
      expect(await Bun.file(paths.auditFile).exists()).toBe(false)

      const restarted = makeWorkspaceRootFileWriter({
        profileDirectory: item.profile,
        primary: item.root,
        enabled: true,
      })
      const recoveryExit = await Effect.runPromiseExit(restarted.readState())
      expect(Exit.isFailure(recoveryExit)).toBe(true)
      if (Exit.isFailure(recoveryExit)) expect(recoveryExit.cause.toString()).toContain("recovery_required")
      expect(JSON.parse(await readFile(paths.journalFile, "utf8"))).toMatchObject({ phase: "prepared" })
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toMatchObject([
        { phase: "prepared" },
        { phase: "recovery_required" },
      ])
    } finally {
      worker.kill()
      await worker.exited
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  }, 20_000)

  test("does not guess recovery when the prepared journal has no rollback artifact", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      const before = {
        trustedWorkspaces: [] as string[],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
      }
      const after = {
        trustedWorkspaces: [resolve(item.target)],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [resolve(item.target)], configuredRoots: [] }),
      }
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.journalFile,
        JSON.stringify({
          schemaVersion: 1,
          action: "trust",
          intentDigest: item.plan.intentDigest,
          phase: "prepared",
          before,
          after,
          rollbackArtifactID: `workspace-rollback-${"b".repeat(64)}`,
        }),
        "utf8",
      )
      await writeFile(paths.configuredFile, JSON.stringify({ roots: "partial" }), "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(exit.toString()).toContain("state_malformed")
      expect(await Bun.file(paths.journalFile).exists()).toBe(true)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("rejects a journal whose before and after snapshots are identical", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      const state = {
        trustedWorkspaces: [] as string[],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
      }
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.journalFile,
        JSON.stringify({
          schemaVersion: 1,
          action: "trust",
          intentDigest: item.plan.intentDigest,
          phase: "prepared",
          before: state,
          after: state,
          rollbackArtifactID: `workspace-rollback-${"9".repeat(64)}`,
        }),
        "utf8",
      )
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("state_malformed")
      expect(await Bun.file(paths.journalFile).exists()).toBe(true)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  itDeniedEffect.effect("fails before state owner invocation when ActionGateway denies the mutation", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => ({
        root: await mkdtemp(join(tmpdir(), "arforge-workspace-denied-")),
        target: await mkdtemp(join(tmpdir(), "arforge-workspace-denied-target-")),
      })),
      ({ root, target }) =>
        Effect.gen(function* () {
          const request = {
            action: "trust" as const,
            primary: root,
            primaryIsDirectory: true,
            target,
            targetIsDirectory: true,
            trustedWorkspaces: [] as string[],
            configuredRoots: [] as string[],
          }
          const session = {
            sessionID: SessionSchema.ID.create(),
            assistantMessageID: SessionMessage.ID.create(),
            toolCallID: "workspace-denied-trust",
          }
          const action: ActionGateway.Input = {
            kind: "session",
            ...session,
            actionID: ActionGateway.stableActionID(session),
            agent: AgentV2.ID.make("build"),
            name: "workspace.root.trust",
            resources: [root, target],
            semantics: AgentRuntime.EffectSemantics.make({
              riskTier: "L3",
              authority: "human",
              idempotency: "idempotent",
              retryability: "safe",
              reversibility: "reversible",
              compensation: "restore-workspace-root-state",
              filesystemScope: [root, target],
              networkScope: [],
              secretScope: [],
              externalServices: [],
              expectedArtifacts: ["workspace root state"],
              successCriteria: ["workspace root state committed"],
            }),
            reasonSummary: "Denied workspace root mutation",
            inputDigest: workspaceRootMutationIntentDigest(request),
          }
          const gateway = yield* ActionGateway.Service
          const exit = yield* executeWorkspaceRootMutation({
            gateway,
            action,
            request,
            writer: makeWorkspaceRootFileWriter({
              profileDirectory: join(root, "profile"),
              primary: root,
              enabled: true,
            }),
          }).pipe(Effect.exit)
          expect(exit.toString()).toContain("ActionGateway.BlockedError")
          expect(yield* Effect.promise(() => Bun.file(join(root, "profile", "trusted_workspaces.json")).exists())).toBe(
            false,
          )
        }),
      ({ root, target }) =>
        Effect.promise(() =>
          Promise.all([rm(root, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]),
        ),
    ),
  )

  itEffect.effect("routes an approved workspace mutation through ActionGateway into the concrete file owner", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => fixture()),
      (item) =>
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const result = yield* executeWorkspaceRootMutation({
            gateway,
            action: workspaceAction(item.root, item.target, "workspace-approved-trust"),
            request: item.request,
            writer: makeWorkspaceRootFileWriter({
              profileDirectory: item.profile,
              primary: item.root,
              enabled: true,
            }),
          })
          expect(result.status).toBe("committed")
          expect(result.action).toBe("trust")
          expect(result.rollbackArtifactID).toMatch(/^workspace-rollback-[a-f0-9]{64}$/)
          expect(readWorkspaceRootMutationStateAt(item.profile, item.root).trustedWorkspaces).toEqual([
            resolve(item.target),
          ])
          expect(inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })).toMatchObject({
            status: "clear",
            ready: true,
            blocking_reasons: [],
          })
        }),
      (item) =>
        Effect.promise(() =>
          Promise.all([
            rm(item.root, { recursive: true, force: true }),
            rm(item.target, { recursive: true, force: true }),
          ]),
        ),
    ),
  )

  test("disabled factory does not create a profile or state files", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })
      const exit = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      expect(exit.toString()).toContain("writer_disabled")
      expect(await Bun.file(join(item.profile, "trusted_workspaces.json")).exists()).toBe(false)
      expect(await Bun.file(join(item.profile, "workspace_roots.json")).exists()).toBe(false)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("blocks later writes when a recovery-required marker needs manual review", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.outboxFile,
        JSON.stringify([
          {
            schemaVersion: 1,
            action: "trust",
            intentDigest: item.plan.intentDigest,
            phase: "recovery_required",
            before: item.plan.before,
            after: item.plan.after,
            rollbackArtifactID: "workspace-rollback-" + "a".repeat(64),
          },
        ]),
        "utf8",
      )
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("recovery_required")
      const mutationExit = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      expect(Exit.isFailure(mutationExit)).toBe(true)
      if (Exit.isFailure(mutationExit)) expect(mutationExit.cause.toString()).toContain("recovery_required")
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("does not replay or delete a prepared journal over a recovery-required marker", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      const before = {
        trustedWorkspaces: [] as string[],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
      }
      const after = {
        trustedWorkspaces: [resolve(item.target)],
        configuredRoots: [] as string[],
        digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [resolve(item.target)], configuredRoots: [] }),
      }
      const rollbackArtifactID = `workspace-rollback-${createHash("sha256")
        .update(JSON.stringify({ before, intentDigest: item.plan.intentDigest }))
        .digest("hex")}`
      await mkdir(paths.rollbackDirectory, { recursive: true })
      await writeFile(join(paths.rollbackDirectory, `${rollbackArtifactID}.json`), JSON.stringify(before), "utf8")
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.journalFile,
        JSON.stringify({
          schemaVersion: 1,
          action: "trust",
          intentDigest: item.plan.intentDigest,
          phase: "prepared",
          before,
          after,
          rollbackArtifactID,
        }),
        "utf8",
      )
      // Simulate CAS having replaced only the first state file before a
      // second process recorded recovery_required for an outbox/audit gap.
      await writeFile(paths.trustedFile, JSON.stringify({ workspaces: [resolve(item.target)] }), "utf8")
      await writeFile(
        paths.outboxFile,
        JSON.stringify([
          {
            schemaVersion: 1,
            action: "trust",
            intentDigest: item.plan.intentDigest,
            phase: "recovery_required",
            before: item.plan.before,
            after: item.plan.after,
            rollbackArtifactID,
          },
        ]),
        "utf8",
      )

      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("recovery_required")
      expect(await Bun.file(paths.journalFile).exists()).toBe(true)
      expect(JSON.parse(await readFile(paths.trustedFile, "utf8"))).toEqual({ workspaces: [resolve(item.target)] })
      expect(await Bun.file(paths.configuredFile).exists()).toBe(false)
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("rejects a phase-only or malformed recovery outbox before exposing state", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(
        paths.outboxFile,
        JSON.stringify([
          {
            phase: "committed",
            intentDigest: item.plan.intentDigest,
          },
        ]),
        "utf8",
      )
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const readExit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(readExit)).toBe(true)
      if (Exit.isFailure(readExit)) expect(readExit.cause.toString()).toContain("outbox_unavailable")

      const appendExit = await Effect.runPromiseExit(
        writer.appendRecoveryOutbox({
          schemaVersion: 1,
          action: item.plan.action,
          intentDigest: "not-a-digest",
          phase: "prepared",
          before: item.plan.before,
          after: item.plan.after,
          rollbackArtifactID: `workspace-rollback-${"a".repeat(64)}`,
        }),
      )
      expect(Exit.isFailure(appendExit)).toBe(true)
      if (Exit.isFailure(appendExit)) expect(appendExit.cause.toString()).toContain("outbox_unavailable")
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("maps malformed outbox/audit JSON to their typed boundaries without overwriting", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      const malformedOutbox = '{"phase":'
      await writeFile(paths.outboxFile, malformedOutbox, "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const outboxExit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(outboxExit)).toBe(true)
      if (Exit.isFailure(outboxExit)) expect(outboxExit.cause.toString()).toContain("outbox_unavailable")
      expect(await readFile(paths.outboxFile, "utf8")).toBe(malformedOutbox)

      await writeFile(paths.outboxFile, "[]", "utf8")
      const malformedAudit = "[broken"
      await writeFile(paths.auditFile, malformedAudit, "utf8")
      const auditExit = await Effect.runPromiseExit(
        writer.audit({
          action: item.plan.action,
          intentDigest: item.plan.intentDigest,
          phase: "committed",
          before: item.plan.before,
          after: item.plan.after,
          rollbackArtifactID: `workspace-rollback-${"f".repeat(64)}`,
        }),
      )
      expect(Exit.isFailure(auditExit)).toBe(true)
      if (Exit.isFailure(auditExit)) expect(auditExit.cause.toString()).toContain("audit_unavailable")
      expect(await readFile(paths.auditFile, "utf8")).toBe(malformedAudit)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("rejects an over-capacity recovery outbox during restart inspection", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      const record = {
        schemaVersion: 1 as const,
        action: item.plan.action,
        intentDigest: item.plan.intentDigest,
        phase: "prepared" as const,
        before: item.plan.before,
        after: item.plan.after,
        rollbackArtifactID: `workspace-rollback-${"c".repeat(64)}`,
      }
      await writeFile(paths.outboxFile, JSON.stringify(Array.from({ length: 1_025 }, () => record)), "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("outbox_unavailable")
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("keeps idempotent outbox/audit retries at capacity but rejects new records", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      const record = {
        schemaVersion: 1 as const,
        action: item.plan.action,
        intentDigest: item.plan.intentDigest,
        phase: "prepared" as const,
        before: item.plan.before,
        after: item.plan.after,
        rollbackArtifactID: `workspace-rollback-${"d".repeat(64)}`,
      }
      await writeFile(paths.outboxFile, JSON.stringify(Array.from({ length: 1_024 }, () => record)), "utf8")
      await writeFile(
        paths.auditFile,
        JSON.stringify(Array.from({ length: 4_096 }, () => ({ ...record, schemaVersion: undefined }))),
        "utf8",
      )
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })

      await Effect.runPromise(writer.appendRecoveryOutbox(record))
      await Effect.runPromise(writer.audit(record))
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1_024)
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toHaveLength(4_096)

      const newIntent = { ...record, intentDigest: "e".repeat(64) }
      const outboxExit = await Effect.runPromiseExit(writer.appendRecoveryOutbox(newIntent))
      const auditExit = await Effect.runPromiseExit(writer.audit(newIntent))
      expect(Exit.isFailure(outboxExit)).toBe(true)
      expect(Exit.isFailure(auditExit)).toBe(true)
      if (Exit.isFailure(outboxExit)) expect(outboxExit.cause.toString()).toContain("outbox_unavailable")
      if (Exit.isFailure(auditExit)) expect(auditExit.cause.toString()).toContain("audit_unavailable")
      expect(JSON.parse(await readFile(paths.outboxFile, "utf8"))).toHaveLength(1_024)
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toHaveLength(4_096)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("rejects malformed existing audit records instead of appending over them", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(paths.auditFile, JSON.stringify([{ phase: "committed" }]), "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const exit = await Effect.runPromiseExit(
        writer.audit({
          action: item.plan.action,
          intentDigest: item.plan.intentDigest,
          phase: "committed",
          before: item.plan.before,
          after: item.plan.after,
          rollbackArtifactID: `workspace-rollback-${"b".repeat(64)}`,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("audit_unavailable")
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toEqual([{ phase: "committed" }])
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("rejects unknown fields in durable outbox and audit records", async () => {
    const item = await fixture()
    try {
      const paths = workspaceRootFileWriterPaths(item.profile)
      await mkdir(paths.writerDirectory, { recursive: true })
      const record = {
        schemaVersion: 1 as const,
        action: item.plan.action,
        intentDigest: item.plan.intentDigest,
        phase: "prepared" as const,
        before: item.plan.before,
        after: item.plan.after,
        rollbackArtifactID: `workspace-rollback-${"e".repeat(64)}`,
      }
      await writeFile(paths.outboxFile, JSON.stringify([{ ...record, unexpected: "payload" }]), "utf8")
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      const outboxExit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(outboxExit)).toBe(true)
      if (Exit.isFailure(outboxExit)) expect(outboxExit.cause.toString()).toContain("outbox_unavailable")

      await writeFile(paths.outboxFile, "[]", "utf8")
      await writeFile(
        paths.auditFile,
        JSON.stringify([{ ...record, schemaVersion: undefined, unexpected: "payload" }]),
        "utf8",
      )
      const auditExit = await Effect.runPromiseExit(writer.audit(record))
      expect(Exit.isFailure(auditExit)).toBe(true)
      if (Exit.isFailure(auditExit)) expect(auditExit.cause.toString()).toContain("audit_unavailable")
      expect(JSON.parse(await readFile(paths.auditFile, "utf8"))).toEqual([
        expect.objectContaining({ unexpected: "payload" }),
      ])
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("preflight blocks a writer path occupied by a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-preflight-writer-path-"))
    const profile = join(root, "profile")
    try {
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, ".workspace-root-writer"), "not-a-directory", "utf8")
      const result = inspectWorkspaceRootFileWriter({ profileDirectory: profile, primary: root })
      expect(result.status).toBe("blocked")
      expect(result.blocking_reasons).toContain("state_malformed")
      expect(result.checks).toContainEqual(
        expect.objectContaining({ id: "lock", status: "blocked", reason: "state_malformed" }),
      )
      expect(await readFile(join(profile, ".workspace-root-writer"), "utf8")).toBe("not-a-directory")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preflight is read-only and treats an absent profile as a clean empty baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-preflight-empty-"))
    const profile = join(root, "profile-not-created")
    try {
      const before = await Bun.file(profile).exists()
      const result = inspectWorkspaceRootFileWriter({ profileDirectory: profile, primary: root })
      expect(result).toMatchObject({
        profile_directory: resolve(profile),
        primary: resolve(root),
        status: "clear",
        ready: true,
        blocking_reasons: [],
      })
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "profile", status: "satisfied", observation: "absent (empty baseline)" }),
          expect.objectContaining({ id: "state", status: "satisfied", observation: "empty" }),
          expect.objectContaining({ id: "journal", status: "satisfied", observation: "absent" }),
          expect.objectContaining({ id: "outbox", status: "satisfied" }),
          expect.objectContaining({ id: "audit", status: "satisfied" }),
        ]),
      )
      expect(await Bun.file(profile).exists()).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preflight reports typed corruption and never repairs or overwrites evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "arforge-workspace-preflight-corrupt-"))
    const profile = join(root, "profile")
    try {
      const paths = workspaceRootFileWriterPaths(profile)
      await mkdir(profile, { recursive: true })
      const malformedState = "{not-json"
      const malformedOutbox = '[{"phase":"committed"}]'
      await writeFile(paths.trustedFile, malformedState, "utf8")
      await mkdir(paths.writerDirectory, { recursive: true })
      await writeFile(paths.outboxFile, malformedOutbox, "utf8")
      const result = inspectWorkspaceRootFileWriter({ profileDirectory: profile, primary: root })
      expect(result.status).toBe("blocked")
      expect(result.ready).toBe(false)
      expect(result.blocking_reasons).toEqual(expect.arrayContaining(["state_malformed", "outbox_unavailable"]))
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          id: "state",
          observation: "trusted_workspaces.json=present; workspace_roots.json=missing",
          reason: "state_malformed",
        }),
      )
      expect(await readFile(paths.trustedFile, "utf8")).toBe(malformedState)
      expect(await readFile(paths.outboxFile, "utf8")).toBe(malformedOutbox)
      expect(await Bun.file(paths.journalFile).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preflight blocks orphan audit evidence instead of treating it as a committed mutation", async () => {
    const item = await fixture()
    try {
      const writer = makeWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root, enabled: true })
      await Effect.runPromise(
        commitWorkspaceRootMutation({
          request: item.request,
          authorization: item.authorization,
          plan: item.plan,
          writer,
        }),
      )
      const paths = workspaceRootFileWriterPaths(item.profile)
      const outboxBefore = await readFile(paths.outboxFile, "utf8")
      await rm(paths.outboxFile)
      const readExit = await Effect.runPromiseExit(writer.readState())
      expect(Exit.isFailure(readExit)).toBe(true)
      if (Exit.isFailure(readExit)) expect(readExit.cause.toString()).toContain("audit_unavailable")
      const preflight = inspectWorkspaceRootFileWriter({ profileDirectory: item.profile, primary: item.root })
      expect(preflight.status).toBe("blocked")
      expect(preflight.blocking_reasons).toContain("audit_unavailable")
      expect(preflight.checks).toContainEqual(
        expect.objectContaining({ id: "audit", status: "blocked", reason: "audit_unavailable" }),
      )
      expect(await Bun.file(paths.auditFile).exists()).toBe(true)
      expect(outboxBefore.length).toBeGreaterThan(0)
    } finally {
      await rm(item.root, { recursive: true, force: true })
      await rm(item.target, { recursive: true, force: true })
    }
  })

  test("preflight keeps separate profiles isolated", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "arforge-workspace-preflight-a-"))
    const rootB = await mkdtemp(join(tmpdir(), "arforge-workspace-preflight-b-"))
    const profileA = join(rootA, "profile")
    const profileB = join(rootB, "profile")
    try {
      await mkdir(profileA, { recursive: true })
      await writeFile(join(profileA, "trusted_workspaces.json"), "{broken", "utf8")
      const blocked = inspectWorkspaceRootFileWriter({ profileDirectory: profileA, primary: rootA })
      const clean = inspectWorkspaceRootFileWriter({ profileDirectory: profileB, primary: rootB })
      expect(blocked.status).toBe("blocked")
      expect(blocked.blocking_reasons).toContain("state_malformed")
      expect(clean).toMatchObject({
        profile_directory: resolve(profileB),
        primary: resolve(rootB),
        status: "clear",
        ready: true,
      })
      expect(clean.blocking_reasons).toEqual([])
    } finally {
      await rm(rootA, { recursive: true, force: true })
      await rm(rootB, { recursive: true, force: true })
    }
  })

  itEffect.effect("verifies a real ActionGateway capability before the file owner commits", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => ({
        root: await mkdtemp(join(tmpdir(), "arforge-workspace-gateway-")),
        target: await mkdtemp(join(tmpdir(), "arforge-workspace-gateway-target-")),
      })),
      ({ root, target }) =>
        Effect.gen(function* () {
          const request = {
            action: "trust" as const,
            primary: root,
            primaryIsDirectory: true,
            target,
            targetIsDirectory: true,
            trustedWorkspaces: [] as string[],
            configuredRoots: [] as string[],
          }
          const session = {
            sessionID: SessionSchema.ID.create(),
            assistantMessageID: SessionMessage.ID.create(),
            toolCallID: "workspace-gateway-trust",
          }
          const action: ActionGateway.Input = {
            kind: "session",
            ...session,
            actionID: ActionGateway.stableActionID(session),
            agent: AgentV2.ID.make("build"),
            name: "workspace.root.trust",
            resources: [root, target],
            semantics: AgentRuntime.EffectSemantics.make({
              riskTier: "L3",
              authority: "human",
              idempotency: "idempotent",
              retryability: "safe",
              reversibility: "reversible",
              compensation: "restore-workspace-root-state",
              filesystemScope: [root, target],
              networkScope: [],
              secretScope: [],
              externalServices: [],
              expectedArtifacts: ["workspace root state"],
              successCriteria: ["workspace root state committed"],
            }),
            reasonSummary: "Explicitly trust an additional workspace root",
            inputDigest: workspaceRootMutationIntentDigest(request),
          }
          const gateway = yield* ActionGateway.Service
          const result = yield* executeWorkspaceRootMutation({
            gateway,
            action,
            request,
            writer: makeWorkspaceRootFileWriter({
              profileDirectory: join(root, "profile"),
              primary: root,
              enabled: true,
            }),
          })
          expect(result.status).toBe("committed")
          expect(yield* Effect.sync(() => readWorkspaceRootMutationStateAt(join(root, "profile"), root))).toMatchObject(
            {
              trustedWorkspaces: [resolve(target)],
              configuredRoots: [],
            },
          )
        }),
      ({ root, target }) =>
        Effect.promise(() =>
          Promise.all([rm(root, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]),
        ),
    ),
  )
})
