import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { AbsolutePath } from "@arforge-ai/core/schema"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import * as SubagentControl from "@arforge-ai/core/runtime/subagent-control"
import * as SubagentControlClaim from "@arforge-ai/core/runtime/subagent-control-claim"
import * as SubagentControlRecovery from "@arforge-ai/core/runtime/subagent-control-recovery"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { CurrentCheck } from "@arforge-ai/core/runtime/subagent-control-access"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "../lib/effect"

const project = ProjectID.global
const location = AbsolutePath.make("/subagent-control-recovery")
const principal = ControlPrincipal.LOCAL_PRINCIPAL
const parentRunID = AgentRuntime.RunID.make("run_recovery_parent")
const childRunID = AgentRuntime.RunID.make("run_recovery_child")
const sessionID = SessionSchema.ID.make("ses_recovery_child")
const controlRunID = AgentRuntime.RunID.make("run_recovery_control")
const now = DateTime.makeUnsafe(1_000)

const subject = AgentRuntime.ControlPlaneSubject.make({
  type: "control-plane",
  id: ControlPrincipal.controlPlaneID(principal, {
    location,
    projectID: project,
    action: "subagent.control.wait",
  }),
  location,
  project,
  actor: "user",
  principalRef: ControlPrincipal.principalRef(principal),
  requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_recovery_wait"),
})

const makeFakeServices = (
  options: {
    readonly status?: AgentRuntime.RunStatus
    readonly activeAttempt?: boolean
    readonly operation?: "wait" | "cancel"
    readonly recursive?: boolean
  } = {},
) => {
  const operation = options.operation ?? "wait"
  const controlSubject = {
    ...subject,
    id: ControlPrincipal.controlPlaneID(principal, {
      location,
      projectID: project,
      action: `subagent.control.${operation}`,
    }),
  }
  const material = SubagentControlClaim.make({
    operation,
    subject: controlSubject,
    parentRunID,
    childRunID,
    sessionID,
    requestID: subject.requestID,
    timeoutMs: 0,
    ...(operation === "cancel" ? { reasonDigest: "a".repeat(64), recursive: options.recursive } : {}),
  })
  const parentLease = AgentRuntime.RunLease.make({
    id: AgentRuntime.LeaseID.make("lea_recovery_parent"),
    runID: parentRunID,
    ownerID: "parent-owner",
    generation: 0,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: DateTime.makeUnsafe(100_000),
  })
  const controlLease = AgentRuntime.RunLease.make({
    id: AgentRuntime.LeaseID.make("lea_recovery_control"),
    runID: controlRunID,
    ownerID: "recovery-owner",
    generation: 0,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: DateTime.makeUnsafe(100_000),
  })
  const authDigest = ActionGateway.intentDigestOf({ ...material.gateway, runID: controlRunID }, material.authorization)
  const operationSnapshot = AgentRuntime.ControlOperationSnapshot.make({
    version: 1,
    id: AgentRuntime.ControlOperationID.make("cop_recovery_wait"),
    kind: material.gateway.name,
    generation: 0,
    policyVersion: ActionGateway.POLICY_VERSION,
    claimDigest: "a".repeat(64),
    authorizationDigest: authDigest,
    inputDigest: material.inputDigest,
    actionID: material.actionID,
    resources: [...material.resources],
    semantics: material.semantics,
    payload: material.envelope,
    payloadDigest: material.inputDigest,
  })
  let status: AgentRuntime.RunStatus = options.status ?? "draft"
  let attempt = options.activeAttempt ?? false
  const run = AgentRuntime.ControlRun.make({
    id: controlRunID,
    subject: controlSubject,
    operation: operationSnapshot,
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: material.reasonSummary,
    budget: material.claim.run.budget,
    traceID: "recovery-test",
    visibility: "details",
    status,
    time: { created: now, updated: now },
  })
  const snapshot = (): DurableRun.ControlSnapshot => ({
    run: { ...run, status },
    lease: status === "draft" ? undefined : controlLease,
    activeAttempt: attempt
      ? {
          attempt: 1,
          startedAt: now,
        }
      : undefined,
    lastSequence: 0,
  })
  const parent = {
    run: {
      id: parentRunID,
      sessionID: SessionSchema.ID.make("ses_recovery_parent"),
      project,
      location,
      status: "running",
      initiator: "agent",
      authority: "automatic",
      riskTier: "L1",
      reasonSummary: "recovery parent",
      budget: material.claim.run.budget,
      traceID: "recovery-parent",
      visibility: "details",
      time: { created: now, updated: now, started: now },
    },
    lease: parentLease,
    lastSequence: 0,
  } as DurableRun.SessionSnapshot
  const durable = {
    load: (runID: AgentRuntime.RunID) => (runID === parentRunID ? Effect.succeed(parent) : Effect.succeed(snapshot())),
    validateLease: () => Effect.succeed(parent),
    acquireControlLease: () => {
      return Effect.succeed({ snapshot: snapshot(), capability: {} as DurableRun.RunLeaseCapability })
    },
    validateControlLease: () => Effect.succeed(snapshot()),
    releaseControlLease: () => Effect.succeed(snapshot()),
    transitionControl: (_capability: DurableRun.RunLeaseCapability, input: { readonly to: AgentRuntime.RunStatus }) => {
      status = input.to
      return Effect.succeed(snapshot())
    },
    beginControlAttempt: () => {
      status = "running"
      attempt = true
      return Effect.succeed(snapshot())
    },
    finishControlAttempt: () => {
      attempt = false
      return Effect.succeed(snapshot())
    },
  } as unknown as DurableRun.Interface
  const observed: Array<unknown> = []
  const gateway = {
    execute: (_input: unknown, operationInput: ActionGateway.Operation<unknown, unknown, unknown>) => {
      observed.push(_input)
      return operationInput.execute({} as ActionGateway.AuthorizationGrantCapability)
    },
  } as unknown as ActionGateway.Interface
  const control = {
    wait: (input: SubagentControl.WaitInput) => {
      expect(input.parentRunID).toBe(parentRunID)
      expect(input.leaseID).toBe(parentLease.id)
      return Effect.succeed({
        operation: "wait",
        parentRunID,
        childRunID,
        durable: {} as DurableRun.ChildSnapshot,
        timedOut: true,
      } satisfies SubagentControl.Result)
    },
  } as unknown as SubagentControl.Interface
  let accessAllowed = true
  const query = {
    from: () => query,
    where: () => query,
    limit: () => query,
    all: () => Effect.succeed([principal]),
    get: () => Effect.succeed(accessAllowed ? { id: sessionID } : undefined),
  }
  const database = {
    db: { select: () => query },
  } as unknown as import("@arforge-ai/core/database/database").Database.Interface
  return {
    material,
    parentLease,
    durable,
    gateway,
    control,
    observed,
    snapshot,
    database,
    revokeAccess: () => {
      accessAllowed = false
    },
  }
}

describe("SubagentControlRecovery", () => {
  for (const status of ["running", "completed"] as const) {
    it.effect(`rejects a settled Gateway receipt after access is revoked (${status})`, () =>
      Effect.gen(function* () {
        const fixture = makeFakeServices({ status, activeAttempt: status === "running" })
        let returnedSettledResult = false
        const result = yield* Effect.exit(
          SubagentControlRecovery.executeControlGateway({
            runID: controlRunID,
            material: fixture.material,
            sealedKind: "existing",
            parentLease: fixture.parentLease,
            database: fixture.database,
            durable: fixture.durable,
            control: fixture.control,
            gateway: {
              ...fixture.gateway,
              execute: () =>
                Effect.sync(() => {
                  fixture.revokeAccess()
                  returnedSettledResult = true
                  return SubagentControlRecovery.receiptFromResult(
                    {
                      operation: "wait",
                      parentRunID,
                      childRunID,
                      timedOut: true,
                      durable: {} as DurableRun.ChildSnapshot,
                    },
                    fixture.material,
                  )
                }),
            } as ActionGateway.Interface,
            direct: () => Effect.die("settled recovery must not execute direct"),
          }),
        )
        expect(returnedSettledResult).toBe(true)
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("outside your authorized scope")
        expect(fixture.snapshot().run.status).toBe(status)
        expect(fixture.snapshot().activeAttempt !== undefined).toBe(status === "running")
      }),
    )
  }
  it.effect("carries the live claim check into the direct operation", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices()
      let continued = false
      const result = yield* Effect.exit(
        SubagentControlRecovery.executeControlGateway({
          runID: controlRunID,
          material: fixture.material,
          sealedKind: "existing",
          parentLease: fixture.parentLease,
          database: fixture.database,
          durable: fixture.durable,
          gateway: fixture.gateway,
          control: fixture.control,
          direct: () =>
            Effect.gen(function* () {
              fixture.revokeAccess()
              yield* yield* CurrentCheck
              continued = true
              return {
                operation: "wait" as const,
                parentRunID,
                childRunID,
                timedOut: false,
                durable: {} as DurableRun.ChildSnapshot,
              }
            }),
        }),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(continued).toBe(false)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("outside your authorized scope")
    }),
  )
  it.effect("rechecks descendants that appear at the Gateway handoff", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices({ operation: "cancel" })
      let scans = 0
      let calls = 0
      const result = yield* Effect.exit(
        SubagentControlRecovery.executeControlGateway({
          runID: controlRunID,
          material: fixture.material,
          sealedKind: "existing",
          parentLease: fixture.parentLease,
          database: fixture.database,
          durable: {
            ...fixture.durable,
            listChildren: () => {
              scans++
              if (scans === 1) return Effect.succeed([])
              fixture.revokeAccess()
              return Effect.succeed([
                {
                  run: {
                    id: AgentRuntime.RunID.make("run_late_descendant"),
                    sessionID,
                    project,
                    location,
                    child: { parentRunID: childRunID },
                  },
                },
              ] as DurableRun.ChildSnapshot[])
            },
          },
          gateway: fixture.gateway,
          control: fixture.control,
          direct: () => {
            calls++
            return Effect.die("late unauthorized descendant must prevent cancellation")
          },
        }),
      )
      expect(scans).toBe(2)
      expect(calls).toBe(0)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("outside your authorized scope")
    }),
  )
  for (const recursive of [true, false]) {
    it.effect(`recovery honors recursive cancellation scope (${recursive})`, () =>
      Effect.gen(function* () {
        const fixture = makeFakeServices({ operation: "cancel", recursive })
        let scans = 0
        let calls = 0
        const result = yield* Effect.exit(
          SubagentControlRecovery.executeControlGateway({
            runID: controlRunID,
            material: fixture.material,
            sealedKind: "existing",
            parentLease: fixture.parentLease,
            database: fixture.database,
            durable: {
              ...fixture.durable,
              listChildren: () => {
                scans++
                // An incomplete page must be rejected rather than treated as an
                // authorized tree. No descendant projection is consumed in this case.
                return Effect.succeed(Array.from({ length: 1_000 }) as DurableRun.ChildSnapshot[])
              },
            },
            gateway: fixture.gateway,
            control: fixture.control,
            direct: () => {
              calls++
              return Effect.succeed({
                operation: "cancel" as const,
                parentRunID,
                childRunID,
                timedOut: false,
                durable: {} as DurableRun.ChildSnapshot,
              })
            },
          }),
        )
        expect(calls).toBe(recursive ? 0 : 1)
        expect(scans).toBe(recursive ? 1 : 0)
        expect(Exit.isFailure(result)).toBe(recursive)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("complete authorization scan limit")
      }),
    )
  }
  for (const revokeAt of ["before-lease", "gateway-handoff"] as const) {
    it.effect(`rechecks current session access at ${revokeAt}`, () =>
      Effect.gen(function* () {
        const fixture = makeFakeServices()
        let calls = 0
        if (revokeAt === "before-lease") fixture.revokeAccess()
        const result = yield* Effect.exit(
          SubagentControlRecovery.executeControlGateway({
            runID: controlRunID,
            material: fixture.material,
            sealedKind: "existing",
            parentLease: fixture.parentLease,
            durable: fixture.durable,
            database: fixture.database,
            control: fixture.control,
            gateway: {
              ...fixture.gateway,
              execute: (input, operation) => {
                fixture.revokeAccess()
                return fixture.gateway.execute(input, operation)
              },
            },
            direct: () => {
              calls++
              return Effect.die("revoked direct operation must not run")
            },
          }),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("outside your authorized scope")
        expect(calls).toBe(0)
        if (revokeAt === "before-lease") {
          expect(fixture.observed).toHaveLength(0)
          expect(fixture.snapshot().run.status).toBe("draft")
        }
      }),
    )
  }
  it.effect("registers and runs the exact sealed-envelope invariant", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices()
      const registry = new RuntimeInvariants.RuntimeInvariantRegistry()
      SubagentControlRecovery.registerInvariants(registry)
      const passed = yield* registry.assert(fixture.material.envelope, {
        owner: "subagent-control-recovery",
        mode: "test",
      })
      expect(passed.passedAll).toBe(true)
      const tampered = { ...fixture.material.envelope, requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_drift") }
      const failed = yield* registry.run(tampered, { owner: "subagent-control-recovery", mode: "test" })
      expect(failed).toMatchObject({ failed: 1, passedAll: false })
    }),
  )

  it.effect("rebuilds a detached wait through the shared ActionGateway handoff", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices()
      const receipt = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable: fixture.durable,
        gateway: fixture.gateway,
        control: fixture.control,
        database: fixture.database,
      })

      expect(receipt).toMatchObject({
        operation: "wait",
        parentRunID,
        childRunID,
        timedOut: true,
      })
      expect(fixture.observed).toHaveLength(1)
      expect(fixture.snapshot().run.status).toBe("completed")
    }),
  )

  it.effect("takes over a crashed running attempt before invoking the direct control exactly once", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices({ status: "running", activeAttempt: true })
      const calls: string[] = []
      const durable = {
        ...fixture.durable,
        beginControlAttempt: () => Effect.die(new Error("Recovery must not allocate a second logical attempt")),
      }
      const receipt = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable,
        gateway: fixture.gateway,
        control: {
          ...fixture.control,
          wait: () => {
            calls.push("wait")
            return Effect.succeed({
              operation: "wait",
              parentRunID,
              childRunID,
              durable: {} as DurableRun.ChildSnapshot,
              timedOut: false,
            } satisfies SubagentControl.Result)
          },
        },
        database: fixture.database,
      })

      expect(receipt.timedOut).toBe(false)
      expect(calls).toEqual(["wait"])
      expect(fixture.snapshot().run.status).toBe("completed")
      expect(fixture.snapshot().activeAttempt).toBeUndefined()
    }),
  )

  it.effect("does not resume an unfinished attempt beyond its original duration budget", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices({ status: "running", activeAttempt: true })
      yield* TestClock.adjust("62 seconds")
      let directCalls = 0
      const result = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable: fixture.durable,
        gateway: fixture.gateway,
        control: fixture.control,
        database: fixture.database,
        direct: () => {
          directCalls++
          return Effect.die(new Error("Expired attempt must not execute"))
        },
      }).pipe(
        Effect.catchIf(
          (error) => error instanceof ActionGateway.BlockedError,
          (error) => Effect.succeed(error.reason),
        ),
      )
      expect(String(result)).toContain("duration budget")
      expect(directCalls).toBe(0)
      expect(fixture.snapshot().activeAttempt).toBeDefined()
    }),
  )

  it.effect("replays a completed control only from the settled durable result", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices({ status: "completed" })
      let directCalls = 0
      const observed: Array<{ readonly allowSettledReplay?: boolean }> = []
      const gateway = {
        ...fixture.gateway,
        execute: (input: unknown, operation: ActionGateway.Operation<unknown, unknown, unknown>) => {
          const replay =
            input !== null &&
            typeof input === "object" &&
            (input as { readonly allowSettledReplay?: unknown }).allowSettledReplay === true
          observed.push({ ...(replay ? { allowSettledReplay: true } : {}) })
          return replay
            ? Effect.succeed(
                SubagentControlRecovery.receiptFromResult(
                  {
                    operation: "wait",
                    parentRunID,
                    childRunID,
                    durable: {} as DurableRun.ChildSnapshot,
                    timedOut: false,
                  } satisfies SubagentControl.Result,
                  fixture.material,
                ),
              )
            : operation.execute({} as ActionGateway.AuthorizationGrantCapability)
        },
      } as ActionGateway.Interface
      const control = {
        ...fixture.control,
        wait: () => {
          directCalls += 1
          return Effect.die("settled control must not be invoked during replay")
        },
      } as SubagentControl.Interface
      const receipt = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable: fixture.durable,
        gateway,
        control,
        database: fixture.database,
      })

      expect(receipt.operation).toBe("wait")
      expect(directCalls).toBe(0)
      expect(observed).toEqual([{ allowSettledReplay: true }])
      expect(fixture.snapshot().run.status).toBe("completed")
    }),
  )

  it.effect("uses the same control lease as a unique promotion gate for concurrent recovery", () =>
    Effect.gen(function* () {
      const fixture = makeFakeServices()
      let leaseHeld = false
      let calls = 0
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const baseAcquire = fixture.durable.acquireControlLease
      const durable = {
        ...fixture.durable,
        acquireControlLease: ((input: {
          readonly runID: AgentRuntime.RunID
          readonly ownerID: string
          readonly ttlMs: number
        }) => {
          if (leaseHeld)
            return Effect.fail(
              new DurableRun.LeaseHeldError({ runID: input.runID, ownerID: "first-recovery", expiresAtMs: 100_000 }),
            )
          leaseHeld = true
          return baseAcquire(input)
        }) as DurableRun.Interface["acquireControlLease"],
        releaseControlLease: (() =>
          Effect.sync(() => {
            leaseHeld = false
            return fixture.snapshot()
          })) as DurableRun.Interface["releaseControlLease"],
      } as DurableRun.Interface
      const gateway = {
        ...fixture.gateway,
        execute: ((_input: unknown, operation: ActionGateway.Operation<unknown, unknown, unknown>) =>
          operation.execute({} as ActionGateway.AuthorizationGrantCapability)) as ActionGateway.Interface["execute"],
      } as ActionGateway.Interface
      const control = {
        ...fixture.control,
        wait: () =>
          Effect.gen(function* () {
            calls += 1
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return {
              operation: "wait",
              parentRunID,
              childRunID,
              durable: {} as DurableRun.ChildSnapshot,
              timedOut: false,
            } satisfies SubagentControl.Result
          }),
      } as SubagentControl.Interface

      const first = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable,
        gateway,
        control,
        database: fixture.database,
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* SubagentControlRecovery.executeControlGateway({
        runID: controlRunID,
        material: fixture.material,
        sealedKind: "existing",
        parentLease: fixture.parentLease,
        durable,
        gateway,
        control,
        database: fixture.database,
      }).pipe(Effect.exit)
      expect(second._tag).toBe("Failure")
      if (second._tag === "Failure") expect(second.cause).toBeDefined()
      expect(calls).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(first)).timedOut).toBe(false)
      expect(fixture.snapshot().run.status).toBe("completed")
    }),
  )
})
