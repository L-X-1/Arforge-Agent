import { expect } from "bun:test"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { createHash } from "node:crypto"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { WorktreeControlWorker } from "@/control-operation/worktree-worker"
import { testEffect } from "../lib/effect"

const commit = (digit: string) => digit.repeat(40)
const scope: WorktreeSnapshot.Scope = {
  projectID: "project-worker",
  projectRoot: "C:\\repo",
  location: "C:\\repo",
  managedWorktreeRoot: "C:\\data\\worktrees\\project-worker",
  reservationRoot: "C:\\data\\reservations\\project-worker",
  managedWorktreeAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
  reservationAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
}
const target = "C:\\data\\worktrees\\project-worker\\task"
const reservation = `C:\\data\\reservations\\project-worker\\${createHash("sha256").update(target.toLowerCase()).digest("hex")}.json`

const subject = AgentRuntime.ControlPlaneSubject.make({
  type: "control-plane",
  id: AgentRuntime.ControlPlaneID.make("ctl_worktree-worker"),
  location: AbsolutePath.make(scope.location),
  project: ProjectID.make(scope.projectID),
  actor: "user",
  principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
  requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_worktree_worker_0001"),
})

const snapshot = WorktreeSnapshot.encode(
  {
    kind: "create",
    value: {
      info: { name: "task", branch: "arforge/task", directory: target },
      start: { project: "", extra: "" },
      requestID: subject.requestID,
      reservationPath: reservation,
      sourceCommit: commit("a"),
      roots: {
        managedWorktreeRoot: scope.managedWorktreeRoot,
        reservationRoot: scope.reservationRoot,
        managedWorktreeAnchor: scope.managedWorktreeAnchor,
        reservationAnchor: scope.reservationAnchor,
      },
    },
  },
  scope,
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

it.effect("causal rotation plus heartbeat contention preserves final checkpoint and exactly one sealed apply", () =>
  Effect.gen(function* () {
    const real = yield* DurableRun.Service
    const material = WorktreeSnapshot.actionMaterial(snapshot)
    const actionID = ActionGateway.stableControlPlaneActionID({
      subject,
      name: material.name,
      resources: material.resources,
      inputDigest: material.inputDigest,
      policyVersion: ActionGateway.POLICY_VERSION,
    })
    const claimDigest = canonicalHash({ fixture: "checkpoint-rotation", snapshot })!
    const operationID = DurableRun.controlOperationID({ subject, claimDigest, generation: 0 })!
    const preliminaryInput: DurableRun.ControlCreateInput = {
      subject,
      operation: {
        version: 1,
        id: operationID,
        kind: material.name,
        generation: 0,
        policyVersion: ActionGateway.POLICY_VERSION,
        claimDigest,
        authorizationDigest: "pending",
        inputDigest: material.inputDigest,
        actionID,
        resources: material.resources,
        semantics: material.semantics,
        payload: snapshot,
        payloadDigest: canonicalHash(snapshot)!,
      },
      initiator: "user",
      authority: "human",
      riskTier: "L3",
      reasonSummary: material.reasonSummary,
      budget: {
        maxAttempts: 2,
        maxDurationMs: 60_000,
        maxCostMicros: 100_000,
        maxTokens: 100_000,
        attemptsUsed: 0,
        durationMsUsed: 0,
        costMicrosUsed: 0,
        tokensUsed: 0,
      },
      traceID: "owned-checkpoint-causal",
      visibility: "details",
    }
    const runID = DurableRun.controlRunID(preliminaryInput)!
    const gatewayInput: ActionGateway.Input = {
      kind: "control-plane",
      controlPlane: subject,
      runID,
      actionID,
      name: material.name,
      resources: material.resources,
      semantics: material.semantics,
      inputDigest: material.inputDigest,
      reasonSummary: material.reasonSummary,
      initiator: "user",
      traceID: preliminaryInput.traceID,
    }
    const createInput = {
      ...preliminaryInput,
      operation: {
        ...preliminaryInput.operation,
        authorizationDigest: ActionGateway.intentDigestOf(
          gatewayInput,
          WorktreeSnapshot.authorizationPlan(snapshot, actionID),
        ),
      },
    }
    const claimed = yield* real.claimControl(createInput)
    expect(claimed.snapshot.run.id).toBe(runID)
    const rotated = yield* Deferred.make<void>()
    const finalEntered = yield* Deferred.make<void>()
    const finishFinal = yield* Deferred.make<void>()
    let handedOff = false,
      heartbeats = 0,
      applyCount = 0,
      oldCapabilityRejected = false
    let finalCheckpointRunID: string | undefined, finalCheckpointActionID: string | undefined
    const durable = {
      ...real,
      heartbeatControl: (capability, input) =>
        real.heartbeatControl(capability, input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              heartbeats++
            }),
          ),
          Effect.tap(() => (handedOff ? Deferred.succeed(rotated, undefined) : Effect.void)),
        ),
      checkpointControl: (capability, input) =>
        Effect.gen(function* () {
          if (typeof input.state !== "function" && input.state.kind === "verified") {
            finalCheckpointRunID = input.runID
            finalCheckpointActionID = input.lastActionID
            yield* Deferred.succeed(finalEntered, undefined)
            yield* Deferred.await(finishFinal)
          }
          return yield* real.checkpointControl(capability, input)
        }),
    } satisfies DurableRun.Interface
    // Authorization is a unit double only. The worker and durable DB lease
    // issuance, revocation, owner rejection and checkpoint writes are real.
    const gateway = {
      execute: (_input, operation) => operation.execute({} as ActionGateway.AuthorizationGrantCapability),
    } as ActionGateway.Interface
    const worker = WorktreeControlWorker.makeGeneric({
      durable,
      gateway,
      codec: {
        decode: WorktreeSnapshot.decode,
        actionMaterial: WorktreeSnapshot.actionMaterial,
        authorizationPlan: WorktreeSnapshot.authorizationPlan,
      },
      ownerID: "owned-worker-a",
      leaseTtlMs: 6_000,
      executionDeadlineMs: 5_000,
      scope: () => Effect.succeed(scope),
      pauseOnExecutorError: (error) => error instanceof ActionGateway.RecoveryRequiredError,
      executor: {
        execute: (command) =>
          Effect.gen(function* () {
            const checkpoint = command.checkpointControl
            yield* checkpoint({ kind: "preimage-receipt", receiptDigest: "immutable-owned-receipt" })
            handedOff = true
            yield* command.controlLeaseValidated()
            yield* Deferred.await(rotated)
            const rejected = yield* real.validateControlLease(command.controlLease).pipe(Effect.flip)
            oldCapabilityRejected = rejected instanceof DurableRun.InvalidRunLeaseCapabilityError
            applyCount++
            yield* checkpoint({ kind: "verified", receiptDigest: "immutable-owned-receipt", applyCount }).pipe(
              Effect.mapError(
                () => new ActionGateway.RecoveryRequiredError({ actionID, reason: "verified checkpoint rejected" }),
              ),
            )
          }),
      },
    })
    const task = yield* worker.execute(runID).pipe(Effect.exit, Effect.forkChild)
    yield* Effect.raceFirst(
      Deferred.await(finalEntered),
      Fiber.join(task).pipe(
        Effect.flatMap((outcome) =>
          Effect.die(
            new Error(
              "Worker stopped before final checkpoint: " +
                (Exit.isFailure(outcome) ? Cause.pretty(outcome.cause) : "success without checkpoint"),
            ),
          ),
        ),
      ),
    )
    const heartbeatAtFinalEntry = heartbeats
    yield* TestClock.adjust("2100 millis")
    yield* Effect.yieldNow
    const heartbeatsDuringFinal = heartbeats - heartbeatAtFinalEntry
    const foreign = yield* real
      .acquireControlLease({ runID, ownerID: "owned-worker-b", ttlMs: 6_000 })
      .pipe(Effect.exit)
    yield* Deferred.succeed(finishFinal, undefined)
    const outcome = yield* Fiber.join(task)
    const settled = yield* real.load(runID)
    const retried = yield* worker.execute(runID).pipe(Effect.exit)
    const afterRetry = yield* real.load(runID)
    expect(oldCapabilityRejected).toBe(true)
    expect(Exit.isFailure(foreign)).toBe(true)
    expect(applyCount).toBe(1)
    expect(finalCheckpointRunID).toBe(runID)
    expect(finalCheckpointActionID).toBe(actionID)
    expect(afterRetry.checkpoint?.id).toBe(settled.checkpoint?.id)
    expect(Exit.isSuccess(outcome)).toBe(true)
    expect(settled.run.status).toBe("completed")
    expect(settled.checkpoint?.state.kind).toBe("verified")
    expect(heartbeatsDuringFinal).toBe(0)
    expect(Exit.isSuccess(retried)).toBe(true)
  }),
)
