import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import {
  bindMergeAction,
  evaluateMerge,
  executeMergeAction,
  makeWriteChangeReceipt,
  verifyParentMergeDurably,
  type TestReceipt,
} from "@arforge-ai/core/runtime/write-conflict-control"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { testEffect } from "../lib/effect"

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
  SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(11), "merge-action-test-aes-256-gcm"),
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

const digest = (value: string) => value.repeat(64)
const tests: ReadonlyArray<TestReceipt> = [{ name: "bun test", status: "passed", resultDigest: digest("e") }]

itEffect.effect("executes and verifies repository merge through the real durable ActionGateway", () =>
  Effect.gen(function* () {
    const runs = yield* DurableRun.Service
    const actions = yield* DurableAction.Service
    const gateway = yield* ActionGateway.Service
    const sessionID = SessionSchema.ID.create()
    const parentRunID = AgentRuntime.RunID.create()
    const parent = yield* runs.create({
      id: parentRunID,
      sessionID,
      initiator: "user",
      authority: "human",
      riskTier: "L2",
      reasonSummary: "merge Action integration test",
      budget: AgentRuntime.Budget.make({
        maxAttempts: 2,
        maxDurationMs: 60_000,
        maxCostMicros: 1,
        maxTokens: 1_000,
        attemptsUsed: 0,
        durationMsUsed: 0,
        costMicrosUsed: 0,
        tokensUsed: 0,
      }),
      traceID: `merge:${parentRunID}`,
      visibility: "details",
      project: ProjectID.global,
      location: AbsolutePath.make("E:/repo"),
      delegableCapabilities: [{ action: "repository.merge", resources: ["workspace"], access: "write" }],
    })
    yield* runs.transition({ runID: parent.run.id, to: "preflight", reason: "merge preflight" })
    yield* runs.transition({ runID: parent.run.id, to: "queued", reason: "merge queued" })
    yield* runs.transition({ runID: parent.run.id, to: "running", reason: "merge running" })

    const receipt = makeWriteChangeReceipt({
      parentRunID: parent.run.id,
      childRunID: "run_child_merge",
      nodeID: "merge-node",
      workspace: "E:/repo",
      isolation: "isolated-worktree",
      baseHeadDigest: digest("a"),
      headDigest: digest("b"),
      files: [{ path: "src/example.ts", status: "modified", beforeDigest: digest("c"), afterDigest: digest("d") }],
      tests,
    })
    const decision = evaluateMerge({
      receipt,
      currentHeadDigest: digest("a"),
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const binding = bindMergeAction(decision.plan, {
      sessionID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.create(),
      runID: parent.run.id,
    })

    let inspections = 0
    let applied = 0
    const result = yield* executeMergeAction(gateway, decision.plan, binding, {
      inspect: () =>
        Effect.sync(() => {
          inspections += 1
          return inspections === 1
            ? { headDigest: digest("a"), diffDigest: digest("0"), changedPaths: [] }
            : { headDigest: digest("b"), diffDigest: receipt.diffDigest, changedPaths: ["src/example.ts"] }
        }),
      apply: () =>
        Effect.sync(() => {
          applied += 1
          return "merged"
        }),
      verifyTests: () => Effect.succeed(tests),
    })

    expect(result).toMatchObject({ value: "merged", observation: { headDigest: digest("b") }, tests })
    expect(applied).toBe(1)
    expect(inspections).toBe(2)
    yield* runs.transition({ runID: parent.run.id, to: "verifying", reason: "merge parent verification" })
    const verification = yield* verifyParentMergeDurably(actions, runs, {
      plan: decision.plan,
      binding,
      observedHeadDigest: digest("b"),
      observedDiffDigest: receipt.diffDigest,
      observedChangedPaths: ["src/example.ts"],
      tests,
    })
    expect(verification.failedChecks).toEqual([])
    expect(verification.passed).toBe(true)
    expect((yield* actions.load(binding.input.actionID)).action.status).toBe("settled")

    const staleReceipt = makeWriteChangeReceipt({
      parentRunID: parent.run.id,
      childRunID: "run_child_stale_merge",
      nodeID: "stale-merge-node",
      workspace: "E:/repo",
      isolation: "isolated-worktree",
      baseHeadDigest: digest("a"),
      headDigest: digest("f"),
      files: [{ path: "src/stale.ts", status: "added", afterDigest: digest("f") }],
      tests,
    })
    const staleDecision = evaluateMerge({
      receipt: staleReceipt,
      currentHeadDigest: digest("a"),
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!staleDecision.plan) throw new Error("expected a ready stale merge plan")
    const staleBinding = bindMergeAction(staleDecision.plan, {
      sessionID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.create(),
      runID: parent.run.id,
    })
    let staleApplied = 0
    const staleExit = yield* executeMergeAction(gateway, staleDecision.plan, staleBinding, {
      inspect: () =>
        Effect.succeed({ headDigest: digest("b"), diffDigest: receipt.diffDigest, changedPaths: ["src/example.ts"] }),
      apply: () =>
        Effect.sync(() => {
          staleApplied += 1
        }),
      verifyTests: () => Effect.succeed(tests),
    }).pipe(Effect.exit)
    expect(Exit.isFailure(staleExit)).toBe(true)
    expect(staleApplied).toBe(0)

    const dirtyReceipt = makeWriteChangeReceipt({
      parentRunID: parent.run.id,
      childRunID: "run_child_dirty_merge",
      nodeID: "dirty-merge-node",
      workspace: "E:/repo",
      isolation: "isolated-worktree",
      baseHeadDigest: digest("b"),
      headDigest: digest("c"),
      files: [{ path: "src/dirty.ts", status: "added", afterDigest: digest("c") }],
      tests,
    })
    const dirtyDecision = evaluateMerge({
      receipt: dirtyReceipt,
      currentHeadDigest: digest("b"),
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!dirtyDecision.plan) throw new Error("expected a ready dirty-workspace merge plan")
    const dirtyBinding = bindMergeAction(dirtyDecision.plan, {
      sessionID,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.create(),
      runID: parent.run.id,
    })
    let dirtyApplied = 0
    const dirtyExit = yield* executeMergeAction(gateway, dirtyDecision.plan, dirtyBinding, {
      inspect: () =>
        Effect.succeed({ headDigest: digest("b"), diffDigest: digest("0"), changedPaths: ["src/local.ts"] }),
      apply: () =>
        Effect.sync(() => {
          dirtyApplied += 1
        }),
      verifyTests: () => Effect.succeed(tests),
    }).pipe(Effect.exit)
    expect(Exit.isFailure(dirtyExit)).toBe(true)
    expect(dirtyApplied).toBe(0)
  }),
)
