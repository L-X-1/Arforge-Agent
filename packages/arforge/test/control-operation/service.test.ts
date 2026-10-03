import { describe, expect, test } from "bun:test"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { Database } from "@arforge-ai/core/database/database"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { EventV2 } from "@arforge-ai/core/event"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Effect, Exit } from "effect"
import { createHash } from "node:crypto"
import { ControlOperation } from "@/control-operation/service"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { HttpControlSubject } from "@/control-plane/http-control-subject"
import { WorktreeControlWorker } from "@/control-operation/worktree-worker"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, ControlClaimIndex.node]),
)
const it = testEffect(runtimeLayer)
const principal: ControlClaimIndex.Principal = ControlOperation.LocalPrincipal

const scope: WorktreeSnapshot.Scope = {
  projectID: "project-control-service",
  projectRoot: "C:\\repo",
  location: "C:\\repo",
  managedWorktreeRoot: "C:\\data\\worktrees\\project-control-service",
  reservationRoot: "C:\\data\\reservations\\project-control-service",
  managedWorktreeAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
  reservationAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
}
const target = "C:\\data\\worktrees\\project-control-service\\task"
const reservation = `C:\\data\\reservations\\project-control-service\\${createHash("sha256").update(target.toLowerCase()).digest("hex")}.json`

const snapshotFor = (requestID: AgentRuntime.ControlPlaneRequestID) =>
  WorktreeSnapshot.encode(
    {
      kind: "create",
      value: {
        info: { name: "task", branch: "arforge/task", directory: target },
        start: { project: "", extra: "" },
        requestID,
        reservationPath: reservation,
        sourceCommit: "b".repeat(40),
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

const subjectFor = (requestID: AgentRuntime.ControlPlaneRequestID) =>
  HttpControlSubject.make({
    directory: scope.location,
    projectID: ProjectID.make(scope.projectID),
    action: "worktree.create",
    requestID,
    principal,
  })

const result = (requestID: AgentRuntime.ControlPlaneRequestID, actionID = AgentRuntime.ActionID.make("act_service")) =>
  ({
    kind: "claimed" as const,
    presentedRequestID: requestID,
    snapshot: {
      run: {
        id: AgentRuntime.RunID.make("run_control_service"),
        operation: { actionID },
        status: "draft",
      },
    },
  }) as unknown as ControlClaimIndex.ClaimResult

describe("ControlOperation", () => {
  it.effect("uses a canonical action identity while retaining the first sealed payload", () =>
    Effect.gen(function* () {
      const firstID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_real_first")
      const secondID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_real_second")
      const claims = yield* ControlClaimIndex.Service
      const scheduled: AgentRuntime.RunID[] = []
      const service = ControlOperation.make({
        claims,
        scheduler: { start: (runID) => Effect.sync(() => void scheduled.push(runID)) },
      })

      const first = yield* service.claimAndStart({
        subject: subjectFor(firstID),
        snapshot: snapshotFor(firstID),
      })
      const second = yield* service.claimAndStart({
        subject: subjectFor(secondID),
        snapshot: snapshotFor(secondID),
      })
      const resolved = yield* claims.lookup({
        controlPlaneID: subjectFor(secondID).id,
        requestID: secondID,
      })

      expect(first.kind).toBe("claimed")
      expect(second.kind).toBe("existing")
      expect(second.runID).toBe(first.runID)
      expect(resolved.run.subject.requestID).toBe(firstID)
      expect(resolved.run.operation.payload).toEqual(snapshotFor(firstID))
      expect(resolved.run.operation.payload).not.toEqual(snapshotFor(secondID))
      expect(scheduled).toEqual([first.runID, first.runID])
    }).pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal)),
  )

  it.effect("isolates subject identity but rejects nonlocal claims before persistence or scheduling", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      let scheduled = false
      const service = ControlOperation.make({
        claims,
        scheduler: { start: () => Effect.sync(() => void (scheduled = true)) },
      })
      const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_same_request")
      const other = { tenantID: "ten_control_service_other", userID: "usr_control_service_other" }
      const subject = (owner: ControlClaimIndex.Principal) =>
        HttpControlSubject.make({
          directory: scope.location,
          projectID: ProjectID.make(scope.projectID),
          action: "worktree.create",
          requestID,
          principal: owner,
        })
      const firstSubject = subject(principal)
      const secondSubject = subject(other)

      const rejected = yield* service
        .claimAndStart({ subject: secondSubject, snapshot: snapshotFor(requestID) })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, other), Effect.exit)

      expect(firstSubject.id).not.toBe(secondSubject.id)
      expect(firstSubject.principalRef).not.toBe(secondSubject.principalRef)
      expect(String(rejected)).toContain("ControlOperation.UnsupportedPrincipalError")
      expect(scheduled).toBe(false)
      expect(
        HttpControlSubject.ownedBy(firstSubject, {
          directory: scope.location,
          projectID: ProjectID.make(scope.projectID),
          action: "worktree.create",
          principal: other,
        }),
      ).toBe(false)
      expect(
        HttpControlSubject.ownedBy(secondSubject, {
          directory: scope.location,
          projectID: ProjectID.make(scope.projectID),
          action: "worktree.create",
          principal: other,
        }),
      ).toBe(true)

      const absent = yield* claims
        .lookup({ controlPlaneID: secondSubject.id, requestID })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, other), Effect.exit)
      expect(String(absent)).toContain("ControlClaimIndex.NotFoundError")
    }),
  )

  it.effect("starts the zero-cost sealed executor under the real DurableRun budget", () =>
    Effect.gen(function* () {
      const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_real_budget")
      const claims = yield* ControlClaimIndex.Service
      const durable = yield* DurableRun.Service
      const service = ControlOperation.make({
        claims,
        scheduler: { start: () => Effect.void },
      })
      const claimed = yield* service.claimAndStart({
        subject: subjectFor(requestID),
        snapshot: snapshotFor(requestID),
      })
      const persisted = yield* durable.load(claimed.runID)
      if (!("subject" in persisted.run)) throw new Error("expected a persisted control run")
      const material = WorktreeSnapshot.actionMaterial(snapshotFor(requestID))
      const gatewayInput = {
        kind: "control-plane" as const,
        controlPlane: persisted.run.subject,
        runID: persisted.run.id,
        actionID: persisted.run.operation.actionID,
        name: material.name,
        resources: material.resources,
        semantics: material.semantics,
        reasonSummary: material.reasonSummary,
        initiator: persisted.run.initiator,
        traceID: persisted.run.traceID,
        inputDigest: material.inputDigest,
      } satisfies ActionGateway.Input
      expect(persisted.run.operation.kind).toBe(material.name)
      expect(persisted.run.operation.inputDigest).toBe(material.inputDigest)
      expect(persisted.run.operation.resources).toEqual(material.resources)
      expect(persisted.run.operation.semantics).toEqual(material.semantics)
      expect(persisted.run.operation.authorizationDigest).toBe(
        ActionGateway.intentDigestOf(
          gatewayInput,
          WorktreeSnapshot.authorizationPlan(snapshotFor(requestID), persisted.run.operation.actionID),
        ),
      )
      let executed = 0
      const worker = WorktreeControlWorker.make({
        durable,
        gateway: {
          execute: (_input, operation) => operation.execute({} as ActionGateway.AuthorizationGrantCapability),
        } as ActionGateway.Interface,
        executor: {
          execute: () =>
            Effect.sync(() => {
              executed += 1
            }),
        },
        ownerID: "worker-real-budget",
        leaseTtlMs: 60_000,
        scope: () => Effect.succeed(scope),
      })

      yield* worker.execute(claimed.runID)
      const completed = yield* durable.load(claimed.runID)
      expect(executed).toBe(1)
      expect(completed.run.status).toBe("completed")
      expect(completed.run.budget).toMatchObject({
        maxAttempts: 1,
        attemptsUsed: 1,
        maxCostMicros: 1,
        costMicrosUsed: 0,
      })
    }).pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal)),
  )

  test("claims sealed aliases with canonical material then starts only the durable run", async () => {
    const firstID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_first")
    const secondID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_second")
    const seen: ControlClaimIndex.ClaimInput[] = []
    const scheduled: AgentRuntime.RunID[] = []
    const claims = {
      claim: (input: ControlClaimIndex.ClaimInput) =>
        Effect.sync(() => {
          seen.push(input)
          return result(input.subject.requestID, AgentRuntime.ActionID.make(`act_${seen.length}`))
        }),
    } as unknown as ControlClaimIndex.Interface
    const service = ControlOperation.make({
      claims,
      scheduler: { start: (runID) => Effect.sync(() => void scheduled.push(runID)) },
    })

    const first = await Effect.runPromise(
      service
        .claimAndStart({
          subject: subjectFor(firstID),
          snapshot: snapshotFor(firstID),
        })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal)),
    )
    const second = await Effect.runPromise(
      service
        .claimAndStart({
          subject: subjectFor(secondID),
          snapshot: snapshotFor(secondID),
        })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal)),
    )

    expect(first.runID).toBe(second.runID)
    expect(scheduled).toEqual([first.runID, second.runID])
    expect(seen).toHaveLength(2)
    expect(seen[0]!.claimMaterial).toEqual(seen[1]!.claimMaterial)
    expect(seen[0]!.input).toEqual(WorktreeSnapshot.claimMaterial(snapshotFor(firstID)).input)
    expect(seen[0]!.operation.payload).toEqual(snapshotFor(firstID))
    expect(Object.hasOwn(seen[0]!, "prepared")).toBe(false)
  })

  test("fails closed before writing a claim when no app-scoped scheduler is injected", async () => {
    let claimed = false
    const service = ControlOperation.make({
      claims: {
        claim: () =>
          Effect.sync(() => {
            claimed = true
            return result(AgentRuntime.ControlPlaneRequestID.make("cpr_no_scheduler"))
          }),
      } as unknown as ControlClaimIndex.Interface,
    })
    const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_no_scheduler")
    const exit = await Effect.runPromise(
      Effect.exit(
        service.claimAndStart({
          subject: subjectFor(requestID),
          snapshot: snapshotFor(requestID),
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(claimed).toBe(false)
  })

  it.effect("cannot accept a caller-supplied principal or write without request identity context", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      let scheduled = false
      const service = ControlOperation.make({
        claims,
        scheduler: { start: () => Effect.sync(() => void (scheduled = true)) },
      })
      const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_control_service_missing_principal")
      const exit = yield* service
        .claimAndStart({ subject: subjectFor(requestID), snapshot: snapshotFor(requestID) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("ControlClaimIndex.MissingPrincipalError")
      expect(scheduled).toBe(false)

      const lookup = yield* claims
        .lookup({ controlPlaneID: subjectFor(requestID).id, requestID })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal), Effect.exit)
      expect(String(lookup)).toContain("ControlClaimIndex.NotFoundError")
    }),
  )
})
