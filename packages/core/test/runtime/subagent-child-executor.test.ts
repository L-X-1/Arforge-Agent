import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { SubagentChildExecutor } from "@arforge-ai/core/runtime/subagent-child-executor"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, SubagentProvider.node, SubagentChildExecutor.node]),
)
const it = testEffect(runtimeLayer)
const withProvider = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, DurableRun.node, SubagentProvider.node, SubagentChildExecutor.node]),
    [
      [
        SubagentChildExecutor.node,
        {
          ...SubagentChildExecutor.node,
          dependencies: [...SubagentChildExecutor.node.dependencies, SubagentProvider.node],
        },
      ],
    ],
  ),
)

let checkpointHook:
  | ((
      input: Parameters<DurableRun.Interface["checkpoint"]>[0],
      actual: DurableRun.Interface,
    ) => ReturnType<DurableRun.Interface["checkpoint"]>)
  | undefined
let finishAttemptHook:
  | ((
      input: Parameters<DurableRun.Interface["finishAttempt"]>[0],
      actual: DurableRun.Interface,
    ) => ReturnType<DurableRun.Interface["finishAttempt"]>)
  | undefined
let transitionHook:
  | ((
      input: Parameters<DurableRun.Interface["transition"]>[0],
      actual: DurableRun.Interface,
    ) => ReturnType<DurableRun.Interface["transition"]>)
  | undefined
const withCheckpointHook = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, DurableRun.node, SubagentProvider.node, SubagentChildExecutor.node]),
    [
      [
        SubagentChildExecutor.node,
        {
          ...SubagentChildExecutor.node,
          dependencies: [...SubagentChildExecutor.node.dependencies, SubagentProvider.node],
        },
      ],
      [
        DurableRun.node,
        {
          ...DurableRun.node,
          implementation: Layer.effect(
            DurableRun.Service,
            Effect.map(DurableRun.Service, (actual) =>
              DurableRun.Service.of({
                ...actual,
                checkpoint: (input) => (checkpointHook ? checkpointHook(input, actual) : actual.checkpoint(input)),
                finishAttempt: (input) =>
                  finishAttemptHook ? finishAttemptHook(input, actual) : actual.finishAttempt(input),
                transition: (input) => (transitionHook ? transitionHook(input, actual) : actual.transition(input)),
              }),
            ),
          ).pipe(Layer.provide([DurableRun.node.implementation!])),
        },
      ],
    ],
  ),
)

const project = ProjectID.global
const location = AbsolutePath.make("/subagent-child-executor-test")
const budget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 1_000,
  maxCostMicros: 1_000,
  maxTokens: 1_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const createParent = (runtime: DurableRun.Interface, parentBudget = budget) =>
  runtime.create({
    sessionID: SessionSchema.ID.create(),
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "child executor parent",
    budget: parentBudget,
    traceID: "child-executor-parent",
    visibility: "details",
    project,
    location,
  })

const createChild = (
  runtime: DurableRun.Interface,
  parentRunID: AgentRuntime.RunID,
  idempotencyKey: string,
  extra: Partial<Pick<DurableRun.ChildCreateInput, "runtimeDescriptorDigest" | "runtimeAdmission" | "budget">> = {},
) =>
  runtime.createChild({
    parentRunID,
    sessionID: SessionSchema.ID.create(),
    idempotencyKey,
    delegatedObjective: "run a deterministic child",
    allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
    project,
    location,
    expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "child executor test",
    budget,
    traceID: `${idempotencyKey}:trace`,
    parentTraceID: "child-executor-parent",
    visibility: "details",
    ...extra,
  })

const usage = () => Effect.succeed({ costMicros: 7, tokens: 11 })

describe("SubagentChildExecutor", () => {
  for (const held of [false, true])
    for (const mode of ["zero", "completed", "failed"] as const)
      it.effect(`recovers an exact terminal settlement intent without replay (live owner=${held}, mode=${mode})`, () =>
        Effect.gen(function* () {
          const durable = yield* DurableRun.Service
          const events = yield* EventV2.Service
          const executor = yield* SubagentChildExecutor.Service
          const parent = yield* createParent(durable)
          for (const to of ["preflight", "queued", "running"] as const)
            yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
          const child = yield* createChild(durable, parent.run.id, "terminal-intent")
          for (const to of ["preflight", "queued", "running"] as const)
            yield* durable.transition({ runID: child.run.id, to, reason: "fixture" })
          const status = mode === "failed" ? "failed" : "completed"
          const recordedUsage =
            mode === "zero"
              ? { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 }
              : { attempts: 1, durationMs: 25, costMicros: 7, tokens: 11 }
          if (mode !== "zero") {
            yield* durable.beginAttempt({ runID: child.run.id })
            yield* durable.finishAttempt({
              runID: child.run.id,
              attempt: 1,
              outcome: status,
              durationMs: 25,
              costMicros: 7,
              tokens: 11,
            })
          }
          yield* durable.transition({ runID: child.run.id, to: status, reason: "fixture terminal with recorded usage" })
          const intentAt = yield* DateTime.now
          const receipt = {
            status,
            summary: "persisted answer",
            artifactRefs: [],
            evidenceRefs: [],
            usage: recordedUsage,
          } satisfies Parameters<DurableRun.Interface["recordChildResult"]>[0]["result"]
          const intent = ChildSettlement.createIntent({
            parentRunID: parent.run.id,
            childRunID: child.run.id,
            idempotencyKey: child.run.child.idempotencyKey,
            result: receipt,
            createdAtMs: DateTime.toEpochMillis(intentAt),
          })
          yield* events.publish(
            AgentRuntime.Event.ChildRunSettlementIntentRecorded,
            {
              runID: parent.run.id,
              sessionID: parent.run.sessionID,
              childRunID: child.run.id,
              idempotencyKey: child.run.child.idempotencyKey,
              intentID: intent.intentID,
              idempotencyDigest: intent.idempotencyDigest,
              result: AgentRuntime.ChildRunResult.make({
                ...receipt,
                resultDigest: intent.resultDigest,
                recordedAt: intentAt,
              }),
              intentAt,
            },
            { expectedSequence: (yield* durable.load(parent.run.id)).lastSequence },
          )
          if (held) yield* durable.acquireLease({ runID: child.run.id, ownerID: "still-settling", ttlMs: 30_000 })
          const before = yield* durable.load(child.run.id)
          const parentBefore = yield* durable.load(parent.run.id)
          let operations = 0
          const input = {
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: () => Effect.die("terminal recovery must not read usage"),
            operation: () =>
              Effect.sync(() => {
                operations++
                return "replayed"
              }),
            onTerminal: (terminal: SubagentChildExecutor.TerminalChild) => Effect.succeed(terminal.summary),
            summarizeSuccess: String,
            summarizeFailure: String,
          }
          const result = yield* executor.execute(input).pipe(Effect.exit)
          expect(operations).toBe(0)
          if (held) {
            expect(result._tag).toBe("Failure")
            if (result._tag === "Failure") expect(Cause.pretty(result.cause)).toContain("DurableRun.LeaseHeldError")
            expect(yield* durable.load(child.run.id)).toEqual(before)
            expect(yield* durable.load(parent.run.id)).toEqual(parentBefore)
          } else {
            expect(result).toEqual(Exit.succeed("persisted answer"))
            const after = yield* durable.load(child.run.id)
            const parentAfter = yield* durable.load(parent.run.id)
            expect(after.lease).toBeUndefined()
            expect(after.run).toMatchObject({
              status,
              childResult: { status, usage: recordedUsage, resultDigest: intent.resultDigest, recordedAt: intentAt },
              budget: {
                attemptsUsed: recordedUsage.attempts,
                durationMsUsed: recordedUsage.durationMs,
                costMicrosUsed: recordedUsage.costMicros,
                tokensUsed: recordedUsage.tokens,
              },
            })
            expect(parentAfter.run).toMatchObject({
              childBudgetReserved: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
            })
            expect(yield* executor.execute(input)).toBe("persisted answer")
            expect(yield* durable.load(child.run.id)).toEqual(after)
            expect(yield* durable.load(parent.run.id)).toEqual(parentAfter)
          }
        }),
      )

  for (const status of ["completed", "failed"] as const)
    it.effect(`does not deliver a ${status} child whose result receipt is missing`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "missing-terminal-result")
        const prepared = yield* executor.prepare({
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: usage,
        })
        if (prepared.kind !== "active") throw new Error("fixture requires an attempt")
        yield* durable.finishAttempt({
          runID: child.run.id,
          attempt: prepared.execution.attempt,
          execution: prepared.execution,
          outcome: status,
          durationMs: 1,
          costMicros: 0,
          tokens: 0,
        })
        yield* durable.transition({
          runID: child.run.id,
          to: status,
          execution: prepared.execution,
          reason: "fixture terminal before receipt",
        })
        yield* durable.releaseLease({
          runID: child.run.id,
          leaseID: prepared.execution.leaseID,
          ownerID: prepared.execution.ownerID,
          reason: "fixture abandoned settlement",
        })
        const before = yield* durable.load(child.run.id)
        const parentBefore = yield* durable.load(parent.run.id)
        let callbacks = 0
        const result = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: () =>
              Effect.sync(() => {
                callbacks++
                return { costMicros: 0, tokens: 0 }
              }),
            operation: () =>
              Effect.sync(() => {
                callbacks++
                return "replayed"
              }),
            onTerminal: () =>
              Effect.sync(() => {
                callbacks++
                return "empty delivery"
              }),
            summarizeSuccess: String,
            summarizeFailure: String,
          })
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain("SubagentChildExecutor.SettlementIncompleteError")
        expect(callbacks).toBe(0)
        expect(yield* durable.load(child.run.id)).toEqual(before)
        expect(yield* durable.load(parent.run.id)).toEqual(parentBefore)
      }),
    )

  withCheckpointHook.effect(
    "rejects a stale result receipt after terminal state takeover without settling the parent",
    () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "terminal-takeover")
        const parentBefore = yield* durable.load(parent.run.id)
        let replacement: DurableRun.Snapshot | undefined
        transitionHook = (input, actual) =>
          Effect.gen(function* () {
            const changed = yield* actual.transition(input)
            if (input.runID === child.run.id && input.to === "completed" && input.execution) {
              yield* actual
                .releaseLease({
                  runID: child.run.id,
                  leaseID: input.execution.leaseID,
                  ownerID: input.execution.ownerID,
                  reason: "fixture terminal takeover",
                })
                .pipe(Effect.orDie)
              replacement = yield* actual
                .acquireLease({ runID: child.run.id, ownerID: "terminal-replacement", ttlMs: 30_000 })
                .pipe(Effect.orDie)
            }
            return changed
          })
        const result = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: usage,
            operation: () => Effect.succeed("stale receipt"),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: String,
            summarizeFailure: String,
          })
          .pipe(Effect.exit)
        expect(replacement).toBeDefined()
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
        expect(yield* durable.load(child.run.id)).toEqual(replacement!)
        expect(yield* durable.load(parent.run.id)).toEqual(parentBefore)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            transitionHook = undefined
          }),
        ),
      ),
  )

  for (const outcome of ["success", "failure"] as const)
    withCheckpointHook.effect(`refuses ${outcome} state settlement after the finished attempt is taken over`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "post-attempt-takeover")
        let replacement: DurableRun.Snapshot | undefined
        finishAttemptHook = (input, actual) =>
          Effect.gen(function* () {
            const finished = yield* actual.finishAttempt(input)
            if (input.runID === child.run.id && input.execution) {
              yield* actual
                .releaseLease({
                  runID: child.run.id,
                  leaseID: input.execution.leaseID,
                  ownerID: input.execution.ownerID,
                  reason: "fixture takeover after attempt commit",
                })
                .pipe(Effect.orDie)
              replacement = yield* actual
                .acquireLease({
                  runID: child.run.id,
                  ownerID: "post-attempt-replacement",
                  ttlMs: 30_000,
                })
                .pipe(Effect.orDie)
            }
            return finished
          })
        const result = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: usage,
            operation: () => (outcome === "success" ? Effect.succeed("old result") : Effect.fail("operation failure")),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: String,
            summarizeFailure: String,
          })
          .pipe(Effect.exit)
        expect(replacement).toBeDefined()
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
        expect(yield* durable.load(child.run.id)).toEqual(replacement!)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finishAttemptHook = undefined
          }),
        ),
      ),
    )

  for (const entry of ["prepare", "execute"] as const)
    for (const target of ["root", "foreign-session", "terminal-foreign-session"] as const)
      it.effect(`rejects ${target} before ${entry} mutates or exposes the run`, () =>
        Effect.gen(function* () {
          const durable = yield* DurableRun.Service
          const executor = yield* SubagentChildExecutor.Service
          const parent = yield* createParent(durable)
          for (const to of ["preflight", "queued", "running"] as const)
            yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
          const child = yield* createChild(durable, parent.run.id, "identity-boundary")
          if (target === "terminal-foreign-session")
            yield* durable.cancelChild({ parentRunID: parent.run.id, childRunID: child.run.id, reason: "fixture" })
          const runID = target === "root" ? parent.run.id : child.run.id
          const before = yield* durable.load(runID)
          let reads = 0
          let operations = 0
          let terminals = 0
          const input = {
            childRunID: runID,
            sessionID: target === "root" ? parent.run.sessionID : SessionSchema.ID.create(),
            readUsage: () =>
              Effect.sync(() => {
                reads++
                return { costMicros: 0, tokens: 0 }
              }),
            operation: () =>
              Effect.sync(() => {
                operations++
                return "unexpected"
              }),
            onTerminal: () =>
              Effect.sync(() => {
                terminals++
                return "unexpected"
              }),
            summarizeSuccess: String,
            summarizeFailure: String,
          }
          const result = yield* entry === "prepare"
            ? executor.prepare(input).pipe(Effect.exit)
            : executor.execute(input).pipe(Effect.exit)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure")
            expect(Cause.pretty(result.cause)).toContain("SubagentChildExecutor.InvalidInputError")
          expect(reads).toBe(0)
          expect(operations).toBe(0)
          expect(terminals).toBe(0)
          expect(yield* durable.load(runID)).toEqual(before)
        }),
      )

  for (const next of ["resume", "cancel"] as const)
    withCheckpointHook.live(`interrupts a committed provider seed before dispatch and then ${next}`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "seed-interrupted")
        const seeded = yield* Deferred.make<AgentRuntime.Checkpoint>()
        const release = yield* Deferred.make<void>()
        let operations = 0
        checkpointHook = (input, actual) =>
          actual
            .checkpoint(input)
            .pipe(
              Effect.flatMap((checkpoint) =>
                input.runID === child.run.id && input.execution
                  ? Deferred.succeed(seeded, checkpoint).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as(checkpoint),
                    )
                  : Effect.succeed(checkpoint),
              ),
            )
        const input = {
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: usage,
          provider: {
            provider: "in-process",
            executionID: String(child.run.id),
            sessionID: child.run.sessionID,
            modelID: "test-model",
            modelProviderID: "test",
            childRunID: String(child.run.id),
            parentRunID: String(parent.run.id),
          },
          permissionDigest: "a".repeat(64),
          readPermissionDigest: () => Effect.succeed("a".repeat(64)),
          operation: () =>
            Effect.sync(() => {
              operations++
              return "recovered answer"
            }),
          onTerminal: (terminal) => Effect.succeed(terminal.summary),
          summarizeSuccess: String,
          summarizeFailure: String,
        } satisfies SubagentChildExecutor.ExecuteInput<string, never, never>
        const fiber = yield* executor.execute(input).pipe(Effect.forkChild)
        const checkpoint = yield* Deferred.await(seeded).pipe(Effect.timeout("2 seconds"))
        const stopped = yield* Fiber.interrupt(fiber).pipe(
          Effect.timeout("1 second"),
          Effect.exit,
          Effect.ensuring(Deferred.succeed(release, undefined)),
        )
        yield* Fiber.join(fiber).pipe(Effect.exit)
        expect(stopped._tag).toBe("Success")
        expect(operations).toBe(0)
        const after = yield* durable.load(child.run.id)
        expect(after.lease).toBeUndefined()
        expect(after.checkpoint).toEqual(checkpoint)
        expect(after.activeAttempt?.attempt).toBe(1)
        checkpointHook = undefined
        if (next === "cancel")
          yield* durable.cancelChild({
            parentRunID: parent.run.id,
            childRunID: child.run.id,
            reason: "cancel seeded task",
            recursive: true,
          })
        yield* executor.execute(input)
        const settled = yield* durable.load(child.run.id)
        expect(settled.run.status).toBe(next === "resume" ? "completed" : "cancelled")
        expect(settled.run.budget.attemptsUsed).toBe(next === "resume" ? 2 : 1)
        expect(settled.run.budget.costMicrosUsed).toBe(0)
        expect(settled.run.budget.tokensUsed).toBe(0)
        if (next === "resume")
          expect(settled.run).toMatchObject({ childResult: { status: "completed", summary: "recovered answer" } })
        else expect("childResult" in settled.run ? settled.run.childResult : undefined).toBeUndefined()
        expect((yield* durable.load(parent.run.id)).run).toMatchObject({
          childBudgetReserved: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        })
        expect(settled.activeAttempt).toBeUndefined()
        expect(settled.lease).toBeUndefined()
        expect(operations).toBe(next === "resume" ? 1 : 0)
        yield* executor.execute(input)
        expect(operations).toBe(next === "resume" ? 1 : 0)
        expect(yield* durable.load(child.run.id)).toEqual(settled)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            checkpointHook = undefined
          }),
        ),
      ),
    )

  withProvider.effect(
    "releases the prepared lease when provider checkpoint initialization rejects late corruption",
    () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "provider-seed-failure")
        let operations = 0
        let corruptCheckpoint: AgentRuntime.Checkpoint | undefined
        const exit = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: () =>
              Effect.gen(function* () {
                corruptCheckpoint = yield* durable.checkpoint({
                  runID: child.run.id,
                  state: { phase: "subagent-provider", sessionLoop: "invalid late checkpoint" },
                })
                return yield* usage()
              }),
            provider: {
              provider: "in-process",
              executionID: String(child.run.id),
              sessionID: child.run.sessionID,
              modelID: "test-model",
              modelProviderID: "test",
              childRunID: String(child.run.id),
              parentRunID: String(parent.run.id),
            },
            permissionDigest: "a".repeat(64),
            readPermissionDigest: () => Effect.succeed("a".repeat(64)),
            operation: () =>
              Effect.sync(() => {
                operations++
                return "unexpected"
              }),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: String,
            summarizeFailure: String,
          })
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure")
          expect(Cause.pretty(exit.cause)).toContain("Nested session checkpoint must be an object")
        expect(operations).toBe(0)
        const after = yield* durable.load(child.run.id)
        expect(after.lease).toBeUndefined()
        expect(after.activeAttempt?.attempt).toBe(1)
        expect(after.run.status).toBe("running")
        expect(after.checkpoint).toEqual(corruptCheckpoint)
      }),
  )

  for (const waitingFor of ["usage", "permission"] as const)
    withProvider.live(
      `interrupts execute while preparation is waiting for ${waitingFor} without starting the operation`,
      () =>
        Effect.gen(function* () {
          const durable = yield* DurableRun.Service
          const executor = yield* SubagentChildExecutor.Service
          const parent = yield* createParent(durable)
          for (const to of ["preflight", "queued", "running"] as const)
            yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
          const child = yield* createChild(durable, parent.run.id, "prepare-interrupted")
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let operations = 0
          const fiber = yield* executor
            .execute({
              childRunID: child.run.id,
              sessionID: child.run.sessionID,
              ...(waitingFor === "permission"
                ? {
                    provider: {
                      provider: "in-process" as const,
                      executionID: String(child.run.id),
                      sessionID: child.run.sessionID,
                      modelID: "test-model",
                      modelProviderID: "test",
                      childRunID: String(child.run.id),
                      parentRunID: String(parent.run.id),
                    },
                    permissionDigest: "a".repeat(64),
                    readPermissionDigest: () =>
                      Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as("a".repeat(64)),
                      ),
                  }
                : {}),
              readUsage: () =>
                waitingFor === "permission"
                  ? usage()
                  : Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(usage),
                    ),
              operation: () =>
                Effect.sync(() => {
                  operations++
                  return "unexpected execution"
                }),
              onTerminal: (terminal) => Effect.succeed(terminal.summary),
              summarizeSuccess: String,
              summarizeFailure: String,
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"))
          const stopped = yield* Fiber.interrupt(fiber).pipe(
            Effect.timeout("1 second"),
            Effect.exit,
            Effect.ensuring(Deferred.succeed(release, undefined)),
          )
          yield* Fiber.join(fiber).pipe(Effect.exit)
          expect(stopped._tag).toBe("Success")
          expect(operations).toBe(0)
          const after = yield* durable.load(child.run.id)
          expect(after.lease).toBeUndefined()
          expect(after.activeAttempt).toBeUndefined()
          expect(after.run.budget.attemptsUsed).toBe(0)
        }),
    )

  it.effect("preparation failure never releases a replacement owner's lease", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const executor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      for (const to of ["preflight", "queued", "running"] as const)
        yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
      const child = yield* createChild(durable, parent.run.id, "prepare-takeover")
      let replacement: DurableRun.Snapshot | undefined
      const exit = yield* executor
        .prepare({
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: () =>
            Effect.gen(function* () {
              const original = yield* durable.load(child.run.id)
              yield* durable.releaseLease({
                runID: child.run.id,
                leaseID: original.lease!.id,
                ownerID: original.lease!.ownerID,
                reason: "fixture takeover",
              })
              yield* durable.acquireLease({ runID: child.run.id, ownerID: "replacement", ttlMs: 30_000 })
              replacement = yield* durable.load(child.run.id)
              return yield* Effect.fail(new Error("usage failed after takeover"))
            }),
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("usage failed after takeover")
      expect(replacement).toBeDefined()
      if (!replacement) return yield* Effect.die("fixture did not acquire replacement lease")
      expect(yield* durable.load(child.run.id)).toEqual(replacement)
    }),
  )

  for (const fault of ["failure", "defect"] as const)
    it.effect(`releases its preparation lease after a usage ${fault} and allows retry`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, `prepare-${fault}`)
        const failed = yield* executor
          .prepare({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: () =>
              fault === "failure"
                ? Effect.fail(new Error("usage unavailable"))
                : Effect.die(new Error("usage unavailable")),
          })
          .pipe(Effect.exit)
        expect(failed._tag).toBe("Failure")
        if (failed._tag === "Failure") expect(Cause.pretty(failed.cause)).toContain("usage unavailable")
        const after = yield* durable.load(child.run.id)
        expect(after.lease).toBeUndefined()
        expect(after.activeAttempt).toBeUndefined()
        expect(after.run.budget.attemptsUsed).toBe(0)
        const retried = yield* executor.prepare({
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: usage,
        })
        expect(retried.kind).toBe("active")
        if (retried.kind === "active") expect(retried.execution.attempt).toBe(1)
      }),
    )

  for (const owner of ["default", "explicit"] as const)
    it.effect(`does not recover an attempt still owned by another call in the same process: ${owner}`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "same-process-owner")
        const input = {
          childRunID: child.run.id,
          sessionID: String(child.run.sessionID),
          readUsage: usage,
          ...(owner === "explicit" ? { ownerID: "shared-worker" } : {}),
        }
        const prepared = yield* executor.prepare(input)
        expect(prepared.kind).toBe("active")
        const before = yield* durable.load(child.run.id)
        const duplicate = yield* executor.prepare(input).pipe(Effect.exit)
        expect(duplicate._tag).toBe("Failure")
        if (duplicate._tag === "Failure") expect(Cause.pretty(duplicate.cause)).toContain("DurableRun.LeaseHeldError")
        expect(yield* durable.load(child.run.id)).toEqual(before)
      }),
    )

  for (const loss of ["replaced", "expired"] as const)
    withProvider.live(`interrupts a silent provider operation after durable ownership is ${loss}`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable, { ...budget, maxDurationMs: 60_000 })
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "silent-replaced", {
          budget: { ...budget, maxDurationMs: 60_000 },
        })
        const started = yield* Deferred.make<SubagentChildExecutor.ChildExecution>()
        let closed = false
        const fiber = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: child.run.sessionID,
            readUsage: usage,
            ...(loss === "expired" ? { leaseTTLms: 500 } : {}),
            provider: {
              provider: "in-process",
              executionID: String(child.run.id),
              sessionID: child.run.sessionID,
              modelID: "test-model",
              modelProviderID: "test",
              childRunID: String(child.run.id),
              parentRunID: String(parent.run.id),
            },
            permissionDigest: "a".repeat(64),
            readPermissionDigest: () => Effect.succeed("a".repeat(64)),
            operation: (execution) =>
              Deferred.succeed(started, execution).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    closed = true
                  }),
                ),
              ),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: String,
            summarizeFailure: String,
          })
          .pipe(Effect.timeout("3 seconds"), Effect.exit, Effect.forkChild)
        const execution = yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"))
        if (loss === "replaced") {
          yield* durable.releaseLease({
            runID: child.run.id,
            leaseID: execution.leaseID,
            ownerID: execution.ownerID,
            reason: "fixture takeover",
          })
          yield* durable.acquireLease({ runID: child.run.id, ownerID: "replacement-worker", ttlMs: 60_000 })
          yield* durable.checkpoint({
            runID: child.run.id,
            state: (current) => ({ ...current, replacement: "preserve" }),
          })
        }
        const replacement = yield* durable.load(child.run.id)
        const exit = yield* Fiber.join(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("DurableRun.LeaseMismatchError")
        expect(closed).toBe(true)
        expect(yield* durable.load(child.run.id)).toEqual(replacement)
        if (loss === "expired") {
          expect(replacement.lease?.id).toBe(execution.leaseID)
          expect(DateTime.toEpochMillis(yield* DateTime.now)).toBeGreaterThanOrEqual(
            DateTime.toEpochMillis(replacement.lease!.expiresAt),
          )
          let observed = { costMicros: 17, tokens: 31 }
          let resumedOperations = 0
          const resume = () =>
            executor.execute({
              childRunID: child.run.id,
              sessionID: child.run.sessionID,
              readUsage: () => Effect.succeed(observed),
              provider: {
                provider: "in-process",
                executionID: String(child.run.id),
                sessionID: child.run.sessionID,
                modelID: "test-model",
                modelProviderID: "test",
                childRunID: String(child.run.id),
                parentRunID: String(parent.run.id),
              },
              permissionDigest: "a".repeat(64),
              readPermissionDigest: () => Effect.succeed("a".repeat(64)),
              operation: () =>
                Effect.sync(() => {
                  resumedOperations++
                  observed = { costMicros: 22, tokens: 38 }
                  return "recovered answer"
                }),
              onTerminal: (terminal) => Effect.succeed(terminal.summary),
              summarizeSuccess: String,
              summarizeFailure: String,
            })
          expect(yield* resume()).toBe("recovered answer")
          const recovered = yield* durable.load(child.run.id)
          expect(recovered.run.status).toBe("completed")
          expect(recovered.run.budget).toMatchObject({ attemptsUsed: 2, costMicrosUsed: 15, tokensUsed: 27 })
          expect(recovered.lease).toBeUndefined()
          expect(recovered.activeAttempt).toBeUndefined()
          expect(yield* resume()).toBe("recovered answer")
          expect(resumedOperations).toBe(1)
          expect(yield* durable.load(child.run.id)).toEqual(recovered)
        }
      }),
    )

  for (const checkpointKind of ["valid", "foreign"] as const)
    withProvider.effect(`recovery validates and preserves a ${checkpointKind} semantic loop checkpoint`, () =>
      Effect.gen(function* () {
        const durable = yield* DurableRun.Service
        const executor = yield* SubagentChildExecutor.Service
        const parent = yield* createParent(durable)
        for (const to of ["preflight", "queued", "running"] as const)
          yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
        const child = yield* createChild(durable, parent.run.id, "semantic-recovery")
        const prepared = yield* executor.prepare({
          childRunID: child.run.id,
          sessionID: String(child.run.sessionID),
          readUsage: usage,
        })
        if (prepared.kind === "terminal") return yield* Effect.die("unexpected terminal")
        const sessionLoop = SessionCheckpoint.make({
          sessionID: String(child.run.sessionID),
          nextStep: 4,
          needsContinuation: true,
          lastTurn: {
            turnStep: 3,
            requestDigest: "a".repeat(64),
            contextDigest: "b".repeat(64),
            toolSetRevision: "c".repeat(64),
            routeConfigRevision: "d".repeat(64),
            compilerRevision: "compiler",
          },
        })
        yield* durable.checkpoint({
          runID: child.run.id,
          state: {
            phase: "subagent-provider",
            taskRecovery: { fixture: "frozen-admission", modelID: "original-model" },
            sessionLoop: checkpointKind === "valid" ? sessionLoop : { ...sessionLoop, sessionID: "foreign-session" },
          },
        })
        yield* durable.releaseLease({
          runID: child.run.id,
          ownerID: prepared.execution.ownerID,
          leaseID: prepared.execution.leaseID,
          reason: "fixture owner released",
        })
        let operations = 0
        let injected = false
        const exit = yield* executor
          .execute({
            childRunID: child.run.id,
            sessionID: String(child.run.sessionID),
            readUsage: () =>
              Effect.gen(function* () {
                if (!injected) {
                  injected = true
                  yield* durable.checkpoint({
                    runID: child.run.id,
                    state: (current) => ({
                      ...current,
                      concurrentMarker: "written after recovery validation",
                      taskRecovery: { ...(current?.taskRecovery as Record<string, unknown>), notification: "latest" },
                    }),
                  })
                }
                return yield* usage()
              }),
            provider: {
              provider: "in-process",
              executionID: String(child.run.id),
              sessionID: String(child.run.sessionID),
              modelID: "model-test",
              modelProviderID: "provider-test",
              childRunID: String(child.run.id),
              parentRunID: String(parent.run.id),
            },
            permissionDigest: "a".repeat(64),
            readPermissionDigest: () => Effect.succeed("a".repeat(64)),
            operation: (execution) =>
              Effect.gen(function* () {
                operations++
                expect(execution.attempt).toBe(2)
                const current = yield* durable.load(child.run.id)
                expect(current.checkpoint?.state.sessionLoop).toEqual(sessionLoop)
                expect(current.checkpoint?.state.epoch).toBe(2)
                expect(current.checkpoint?.state.concurrentMarker).toBe("written after recovery validation")
                expect(current.checkpoint?.state.taskRecovery).toEqual({
                  fixture: "frozen-admission",
                  modelID: "original-model",
                  notification: "latest",
                })
                return "resumed"
              }),
            onTerminal: (terminal) => Effect.succeed(terminal.summary),
            summarizeSuccess: (value) => value,
            summarizeFailure: (cause) => String(cause),
          })
          .pipe(Effect.exit)
        if (checkpointKind === "foreign") {
          expect(Exit.isFailure(exit)).toBe(true)
          expect(operations).toBe(0)
          const after = yield* durable.load(child.run.id)
          expect(after.run.budget.attemptsUsed).toBe(1)
          expect(after.lease).toBeUndefined()
          expect(after.checkpoint?.state.sessionLoop).toMatchObject({ sessionID: "foreign-session" })
          return
        }
        expect(Exit.isSuccess(exit)).toBe(true)
        expect((yield* durable.load(child.run.id)).run.status).toBe("completed")
      }),
    )
  it.effect("validates a borrowed child attempt without creating another run or lease", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const executor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const child = yield* createChild(durable, parent.run.id, "borrowed-attempt")
      const prepared = yield* executor.prepare({
        childRunID: child.run.id,
        sessionID: String(child.run.sessionID),
        readUsage: usage,
      })
      if (prepared.kind !== "active") return yield* Effect.die("expected an active child")
      const input = { childRunID: child.run.id, sessionID: String(child.run.sessionID), execution: prepared.execution }
      const before = yield* durable.load(child.run.id)
      const verified = yield* SubagentChildExecutor.validateExecution(input)
      expect(verified).toEqual(before)
      for (const invalid of [
        { ...input, sessionID: String(parent.run.sessionID) },
        { ...input, execution: { ...input.execution, attempt: input.execution.attempt + 1 } },
        { ...input, execution: { ...input.execution, ownerID: "wrong-worker" } },
      ]) {
        const result = yield* SubagentChildExecutor.validateExecution(invalid).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
      }
      expect(yield* durable.load(child.run.id)).toEqual(before)
      expect(yield* durable.list({ sessionID: child.run.sessionID })).toHaveLength(1)
    }),
  )

  it.effect("fences recovery accounting when ownership changes during the usage read", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const executor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      for (const to of ["preflight", "queued", "running"] as const)
        yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
      const child = yield* createChild(durable, parent.run.id, "recovery-read-takeover")
      const first = yield* executor.prepare({
        childRunID: child.run.id,
        sessionID: child.run.sessionID,
        readUsage: usage,
      })
      if (first.kind !== "active") throw new Error("fixture requires an active attempt")
      yield* durable.releaseLease({
        runID: child.run.id,
        leaseID: first.execution.leaseID,
        ownerID: first.execution.ownerID,
        reason: "fixture abandoned worker",
      })
      let replacement: DurableRun.Snapshot | undefined
      let reads = 0
      const result = yield* executor
        .prepare({
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: () =>
            Effect.gen(function* () {
              reads++
              const owned = yield* durable.load(child.run.id)
              if (!owned.lease) throw new Error("fixture requires recovery lease")
              yield* durable.releaseLease({
                runID: child.run.id,
                leaseID: owned.lease.id,
                ownerID: owned.lease.ownerID,
                reason: "fixture takeover during recovery accounting",
              })
              replacement = yield* durable.acquireLease({
                runID: child.run.id,
                ownerID: "recovery-replacement",
                ttlMs: 30_000,
              })
              return { costMicros: 17, tokens: 31 }
            }),
        })
        .pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure")
        expect(Cause.pretty(result.cause)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(reads).toBe(1)
      expect(replacement).toBeDefined()
      expect(yield* durable.load(child.run.id)).toEqual(replacement!)
      expect(replacement?.activeAttempt?.attempt).toBe(1)
      expect(replacement?.run.budget.costMicrosUsed).toBe(0)
      expect(replacement?.run.budget.tokensUsed).toBe(0)
    }),
  )

  it.effect("fences settlement when ownership changes during the usage read", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const executor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      for (const to of ["preflight", "queued", "running"] as const)
        yield* durable.transition({ runID: parent.run.id, to, reason: "fixture" })
      const child = yield* createChild(durable, parent.run.id, "settlement-read-takeover")
      let execution: SubagentChildExecutor.ChildExecution | undefined
      let replacement: DurableRun.Snapshot | undefined
      let operations = 0
      const exit = yield* executor
        .execute({
          childRunID: child.run.id,
          sessionID: child.run.sessionID,
          readUsage: () =>
            Effect.gen(function* () {
              if (execution) {
                yield* durable.releaseLease({
                  runID: child.run.id,
                  leaseID: execution.leaseID,
                  ownerID: execution.ownerID,
                  reason: "fixture takeover during settlement read",
                })
                replacement = yield* durable.acquireLease({
                  runID: child.run.id,
                  ownerID: "settlement-replacement",
                  ttlMs: 30_000,
                })
              }
              return { costMicros: 7, tokens: 11 }
            }),
          operation: (active) =>
            Effect.sync(() => {
              execution = active
              operations++
              return "stale result"
            }),
          onTerminal: (terminal) => Effect.succeed(terminal.summary),
          summarizeSuccess: String,
          summarizeFailure: String,
        })
        .pipe(Effect.exit)
      expect(replacement).toBeDefined()
      expect(exit._tag).toBe("Failure")
      expect(operations).toBe(1)
      expect(yield* durable.load(child.run.id)).toEqual(replacement!)
    }),
  )

  it.effect("fences stale child settlement after another worker replaces its lease", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const executor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const child = yield* createChild(durable, parent.run.id, "replaced-lease")
      let operations = 0
      const exit = yield* executor
        .execute({
          childRunID: child.run.id,
          sessionID: String(child.run.sessionID),
          readUsage: usage,
          operation: (execution) =>
            Effect.gen(function* () {
              operations += 1
              yield* durable.releaseLease({
                runID: child.run.id,
                leaseID: execution.leaseID,
                ownerID: execution.ownerID,
                reason: "test worker replacement",
              })
              yield* durable.acquireLease({ runID: child.run.id, ownerID: "replacement-worker", ttlMs: 30_000 })
              return "stale output"
            }),
          onTerminal: (terminal) => Effect.succeed(terminal.summary),
          summarizeSuccess: (value) => value,
          summarizeFailure: (cause) => String(cause),
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(operations).toBe(1)
      const after = yield* durable.load(child.run.id)
      expect(after.run.status).toBe("running")
      expect(after.activeAttempt?.attempt).toBe(1)
      expect(after.run.budget.tokensUsed).toBe(0)
      expect(after.lease?.ownerID).toBe("replacement-worker")
    }),
  )

  it.effect("executes through one Core provider and settles one durable child", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const childExecutor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const descriptorDigest = "d".repeat(64)
      const evidenceID = AgentRuntime.EvidenceID.make("evd_child_executor_admission")
      const child = yield* createChild(durable, parent.run.id, "single", {
        runtimeDescriptorDigest: descriptorDigest,
        runtimeAdmission: {
          evidence: {
            schema_version: 1,
            kind: "custom-agent-admission",
            role: "CustomAgent.child-executor",
            profile_path: "profiles/child-executor.json",
            status: "admitted",
            decision: "admitted",
            reason: "fixture admission is complete",
            ready: true,
            descriptor_digest: descriptorDigest,
            checks: {
              status_consistent: true,
              descriptor_digest_consistent: true,
              tool_projection_consistent: true,
              payload_free: true,
            },
            declared_tool_count: 1,
            canonical_tool_count: 1,
            unsupported_tool_count: 0,
            valid: true,
            violations: [],
          },
          evidenceRefs: [evidenceID],
        },
      })
      let operationCount = 0
      const result = yield* childExecutor.execute({
        childRunID: child.run.id,
        sessionID: String(child.run.sessionID),
        readUsage: usage,
        provider: {
          provider: "in-process",
          executionID: String(child.run.id),
          sessionID: String(child.run.sessionID),
          modelID: "model-test",
          modelProviderID: "provider-test",
          childRunID: String(child.run.id),
          parentRunID: String(parent.run.id),
        },
        permissionDigest: "a".repeat(64),
        readPermissionDigest: () => Effect.succeed("a".repeat(64)),
        resultEvidenceRefs: [evidenceID],
        operation: () =>
          Effect.sync(() => {
            operationCount += 1
            return "child output"
          }),
        onTerminal: (terminal) => Effect.succeed(terminal.summary),
        summarizeSuccess: (value) => value,
        summarizeFailure: (cause) => String(cause),
      })
      const settled = (yield* durable.load(child.run.id)) as DurableRun.ChildSnapshot
      const parentAfter = yield* durable.load(parent.run.id)
      expect(result).toBe("child output")
      expect(operationCount).toBe(1)
      expect(settled.run.status).toBe("completed")
      expect(settled.run.childResult?.summary).toBe("child output")
      expect(settled.run.childResult?.evidenceRefs).toEqual([evidenceID])
      expect(settled.run.budget.attemptsUsed).toBe(1)
      expect((parentAfter.run as AgentRuntime.SessionRun).childBudgetReserved).toEqual({
        attempts: 0,
        durationMs: 0,
        costMicros: 0,
        tokens: 0,
      })
    }),
  )

  it.effect("returns a terminal child without replaying the provider operation", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const childExecutor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const child = yield* createChild(durable, parent.run.id, "terminal")
      yield* durable.transition({ runID: child.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: child.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: child.run.id, to: "running", reason: "test" })
      yield* durable.beginAttempt({ runID: child.run.id })
      yield* durable.finishAttempt({
        runID: child.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: 1,
        costMicros: 1,
        tokens: 1,
      })
      yield* durable.transition({ runID: child.run.id, to: "completed", reason: "test" })
      yield* durable.recordChildResult({
        runID: child.run.id,
        result: {
          status: "completed",
          summary: "already done",
          artifactRefs: [],
          evidenceRefs: [],
          usage: { attempts: 1, durationMs: 1, costMicros: 1, tokens: 1 },
        },
      })

      let operationCount = 0
      const result = yield* childExecutor.execute({
        childRunID: child.run.id,
        sessionID: String(child.run.sessionID),
        readUsage: usage,
        operation: () =>
          Effect.sync(() => {
            operationCount += 1
            return "replayed"
          }),
        onTerminal: (terminal) => Effect.succeed(terminal.summary),
        summarizeSuccess: (value) => value,
        summarizeFailure: (cause) => String(cause),
      })
      expect(result).toBe("already done")
      expect(operationCount).toBe(0)
    }),
  )

  it.effect("fails closed on a provider identity mismatch before executing the child", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const childExecutor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const child = yield* createChild(durable, parent.run.id, "mismatch")
      let operationRan = false
      const exit = yield* childExecutor
        .execute({
          childRunID: child.run.id,
          sessionID: String(child.run.sessionID),
          readUsage: usage,
          provider: {
            provider: "in-process",
            executionID: "different-child",
            sessionID: String(child.run.sessionID),
            modelID: "model-test",
            modelProviderID: "provider-test",
          },
          permissionDigest: "a".repeat(64),
          readPermissionDigest: () => Effect.succeed("a".repeat(64)),
          operation: () =>
            Effect.sync(() => {
              operationRan = true
              return "must not run"
            }),
          onTerminal: (terminal) => Effect.succeed(terminal.summary),
          summarizeSuccess: (value) => value,
          summarizeFailure: (cause) => String(cause),
        })
        .pipe(Effect.exit)
      expect(String(exit)).toContain("SubagentChildExecutor.InvalidInputError")
      expect(operationRan).toBe(false)
      const untouched = (yield* durable.load(child.run.id)) as DurableRun.ChildSnapshot
      expect(untouched.activeAttempt).toBeUndefined()
      expect(untouched.lease).toBeUndefined()
    }),
  )

  it.effect("rejects a changed permission digest before acquiring a child lease", () =>
    Effect.gen(function* () {
      const durable = yield* DurableRun.Service
      const childExecutor = yield* SubagentChildExecutor.Service
      const parent = yield* createParent(durable)
      yield* durable.transition({ runID: parent.run.id, to: "preflight", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "queued", reason: "test" })
      yield* durable.transition({ runID: parent.run.id, to: "running", reason: "test" })
      const child = yield* createChild(durable, parent.run.id, "permission-drift")
      let operationRan = false
      const exit = yield* childExecutor
        .execute({
          childRunID: child.run.id,
          sessionID: String(child.run.sessionID),
          readUsage: usage,
          provider: {
            provider: "in-process",
            executionID: String(child.run.id),
            sessionID: String(child.run.sessionID),
            modelID: "model-test",
            modelProviderID: "provider-test",
            parentRunID: String(parent.run.id),
          },
          permissionDigest: "a".repeat(64),
          readPermissionDigest: () => Effect.succeed("b".repeat(64)),
          operation: () =>
            Effect.sync(() => {
              operationRan = true
              return "must not run"
            }),
          onTerminal: (terminal) => Effect.succeed(terminal.summary),
          summarizeSuccess: (value) => value,
          summarizeFailure: (cause) => String(cause),
        })
        .pipe(Effect.exit)
      expect(String(exit)).toContain("SubagentChildExecutor.InvalidInputError")
      expect(operationRan).toBe(false)
      const untouched = (yield* durable.load(child.run.id)) as DurableRun.ChildSnapshot
      expect(untouched.activeAttempt).toBeUndefined()
      expect(untouched.lease).toBeUndefined()
    }),
  )
})
