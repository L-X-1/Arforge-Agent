import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit } from "effect"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import { ControlRunCoordinator } from "@/control-plane/run-coordinator"

const subject = AgentRuntime.ControlPlaneSubject.make({
  type: "control-plane",
  id: AgentRuntime.ControlPlaneID.make("ctl_control-run-coordinator-test"),
  location: AbsolutePath.make("C:/repo"),
  project: Project.ID.make("prj_control-run-coordinator-test"),
  actor: "user",
  principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
  requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_control-run-coordinator-test"),
})

const record = (
  overrides: Partial<ControlRunCoordinator.Record<{ readonly frozen: true }>> = {},
): ControlRunCoordinator.Record<{ readonly frozen: true }> => ({
  runID: AgentRuntime.RunID.make("run_control-run-coordinator-test"),
  actionID: AgentRuntime.ActionID.make("act_control-run-coordinator-test"),
  subject,
  operationID: "cop_control-run-coordinator-test",
  bindingDigest: "binding-control-run-coordinator-test",
  operation: "worktree.create",
  status: "awaiting_authorization",
  snapshot: { frozen: true },
  expectedSequence: 0,
  ...overrides,
})

describe("ControlRunCoordinator", () => {
  test("derives a safe DTO without exposing snapshot or arbitrary operation", () => {
    const safe = ControlRunCoordinator.statusDTO(record())
    expect(safe).toEqual({
      runID: AgentRuntime.RunID.make("run_control-run-coordinator-test"),
      actionID: AgentRuntime.ActionID.make("act_control-run-coordinator-test"),
      requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_control-run-coordinator-test"),
      projectID: Project.ID.make("prj_control-run-coordinator-test"),
      location: AbsolutePath.make("C:/repo"),
      operation: "worktree.create",
      phase: "waiting_for_confirmation",
      recovery: "awaiting_authorization",
      canApprove: true,
    })
    expect(Object.hasOwn(safe, "snapshot")).toBe(false)
    expect(Object.hasOwn(safe, "resources")).toBe(false)

    const unknown = ControlRunCoordinator.statusDTO(record({ operation: "arbitrary.publish" }))
    expect(unknown.operation).toBe("unknown")
    expect(unknown.canApprove).toBe(false)
  })

  test("maps terminal and recovery states without inventing a second state machine", () => {
    expect(ControlRunCoordinator.recoveryDirective("awaiting_authorization")).toBe("awaiting_authorization")
    expect(ControlRunCoordinator.recoveryDirective("running")).toBe("recover")
    expect(ControlRunCoordinator.recoveryDirective("paused")).toBe("none")
    expect(ControlRunCoordinator.recoveryDirective("completed")).toBe("none")
    expect(ControlRunCoordinator.displayPhase("verifying")).toBe("verifying")
    expect(ControlRunCoordinator.displayPhase("cancelled")).toBe("cancelled")
  })

  test("claims once, schedules one app-scoped worker, and keeps the caller outside the worker lifetime", async () => {
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const finalized = Deferred.makeUnsafe<void>()
    let claims = 0
    let executions = 0
    const operation = record()

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* ControlRunCoordinator.make({
            repository: {
              claim: () =>
                Effect.sync(() => {
                  claims += 1
                  return {
                    kind: "claimed" as const,
                    record: operation,
                    presentedRequestID: subject.requestID,
                  }
                }),
              load: () => Effect.succeed(operation),
              recoverable: () => Effect.succeed([]),
            },
            worker: {
              execute: () =>
                Effect.sync(() => {
                  executions += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.ensuring(Deferred.succeed(finalized, undefined)),
                ),
            },
          })
          const dto = yield* coordinator.claimAndStart({
            subject,
            operationID: operation.operationID,
            bindingDigest: operation.bindingDigest,
            operation: operation.operation,
            snapshot: operation.snapshot,
          })
          yield* Deferred.await(started)
          yield* coordinator.start(operation)
          const active = yield* coordinator.active
          return { dto, active: active.has(operation.runID), claims, executions }
        }),
      ),
    )

    expect(outcome).toEqual({
      dto: { kind: "claimed", status: ControlRunCoordinator.statusDTO(operation) },
      active: true,
      claims: 1,
      executions: 1,
    })
    // Scope disposal interrupts the detached worker rather than holding this
    // test (or an HTTP request) open.  The durable worker will reappear via
    // `recoverable` on the next application startup.
    await Effect.runPromise(Deferred.await(finalized))
  })

  test("startup recovery schedules every recoverable run and status is subject-scoped", async () => {
    const first = record({ status: "recovering" })
    const second = record({
      runID: AgentRuntime.RunID.make("run_control-run-coordinator-second"),
      actionID: AgentRuntime.ActionID.make("act_control-run-coordinator-second"),
      status: "awaiting_authorization",
    })
    const seen: string[] = []
    const bothStarted = Deferred.makeUnsafe<void>()
    const finish = Deferred.makeUnsafe<void>()

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* ControlRunCoordinator.make({
            repository: {
              claim: () =>
                Effect.succeed({ kind: "claimed" as const, record: first, presentedRequestID: subject.requestID }),
              load: (runID) => Effect.succeed(runID === first.runID ? first : second),
              recoverable: () => Effect.succeed([first, second]),
            },
            worker: {
              execute: (item) =>
                Effect.sync(() => {
                  seen.push(item.runID)
                  return seen.length === 2
                }).pipe(
                  Effect.flatMap((isSecond) => (isSecond ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
                  Effect.andThen(Deferred.await(finish)),
                ),
            },
          })
          yield* coordinator.recover()
          yield* Deferred.await(bothStarted)
          expect(new Set(seen)).toEqual(new Set([first.runID, second.runID]))

          const status = yield* coordinator.status({
            runID: first.runID,
            subject,
            operationID: first.operationID,
            bindingDigest: first.bindingDigest,
          })
          expect(status.recovery).toBe("recover")
          const aliasSubject = AgentRuntime.ControlPlaneSubject.make({
            ...subject,
            requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_other"),
          })
          const aliasStatus = yield* coordinator.status({
            runID: first.runID,
            subject: aliasSubject,
            operationID: first.operationID,
            bindingDigest: first.bindingDigest,
          })
          expect(aliasStatus.runID).toBe(first.runID)

          const mismatch = yield* Effect.exit(
            coordinator.status({
              runID: first.runID,
              subject,
              operationID: first.operationID,
              bindingDigest: "wrong-binding",
            }),
          )
          expect(Exit.isFailure(mismatch)).toBe(true)
          yield* Deferred.succeed(finish, undefined)
        }),
      ),
    )
  })
})
