import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Effect } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { WorktreeControlScheduler } from "@/control-operation/worktree-scheduler"
import { ControlOperation } from "@/control-operation/service"
import * as TestClock from "effect/testing/TestClock"
import { it as effectTest } from "../lib/effect"

const location = AbsolutePath.make("C:\\repo")

function controlSnapshot(input: {
  readonly id: string
  readonly kind: string
  readonly status: AgentRuntime.RunStatus
  readonly location?: typeof location
  readonly leaseExpiresAt?: AgentRuntime.RunLease["expiresAt"]
}): DurableRun.ControlSnapshot {
  return {
    run: {
      id: AgentRuntime.RunID.make(input.id),
      subject: AgentRuntime.ControlPlaneSubject.make({
        type: "control-plane",
        id: AgentRuntime.ControlPlaneID.make(`ctl_${input.id}`),
        location: input.location ?? location,
        project: ProjectID.make("project-scheduler"),
        actor: "user",
        principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
        requestID: AgentRuntime.ControlPlaneRequestID.make(`cpr_${input.id}`),
      }),
      operation: { kind: input.kind },
      status: input.status,
    } as AgentRuntime.ControlRun,
    ...(input.leaseExpiresAt
      ? {
          lease: {
            expiresAt: input.leaseExpiresAt,
          } as AgentRuntime.RunLease,
        }
      : {}),
    lastSequence: 0,
  }
}

describe("WorktreeControlScheduler", () => {
  test("detaches worker execution from the caller while coalescing a run ID", async () => {
    const started = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let calls = 0
    const runID = AgentRuntime.RunID.make("run_control_scheduler")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduler = yield* WorktreeControlScheduler.make({
            execute: () =>
              Effect.sync(() => {
                calls += 1
              }).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(release))),
          })
          yield* scheduler.start(runID)
          yield* scheduler.start(runID)
          yield* Deferred.await(started)
          expect(calls).toBe(1)
          yield* Deferred.succeed(release, undefined)
        }),
      ),
    )
  })

  test("scans safe and orphaned worktree runs once and schedules each trusted location", async () => {
    const draft = controlSnapshot({ id: "run_control_scan_draft", kind: "worktree.create", status: "draft" })
    const running = controlSnapshot({ id: "run_control_scan_running", kind: "worktree.remove", status: "running" })
    const verifying = controlSnapshot({
      id: "run_control_scan_verifying",
      kind: "worktree.reset",
      status: "verifying",
    })
    const foreign = controlSnapshot({ id: "run_control_scan_foreign", kind: "session.share", status: "draft" })
    const failed = controlSnapshot({ id: "run_control_scan_failed", kind: "worktree.create", status: "failed" })
    const cancelled = controlSnapshot({
      id: "run_control_scan_cancelled",
      kind: "worktree.remove",
      status: "cancelled",
    })
    const paused = controlSnapshot({ id: "run_control_scan_paused", kind: "worktree.reset", status: "paused" })
    const active = controlSnapshot({
      id: "run_control_scan_active",
      kind: "worktree.create",
      status: "awaiting_authorization",
      leaseExpiresAt: DateTime.makeUnsafe(Date.now() + 60_000),
    })
    const expired = controlSnapshot({
      id: "run_control_scan_expired",
      kind: "worktree.create",
      status: "awaiting_authorization",
      leaseExpiresAt: DateTime.makeUnsafe(Date.now() - 1),
    })
    const scheduled: Array<readonly [AgentRuntime.RunID, AgentRuntime.ControlPlaneSubject["location"] | undefined]> = []

    const runIDs = await Effect.runPromise(
      WorktreeControlScheduler.scanRecoverableControl({
        durable: {
          recoverableControl: () =>
            Effect.succeed([draft, running, foreign, active, expired, failed, cancelled, paused]),
          orphanedControl: () => Effect.succeed([running, verifying, failed]),
        },
        scheduler: {
          start: (runID, runLocation) => Effect.sync(() => void scheduled.push([runID, runLocation])),
        },
      }),
    )

    expect(runIDs).toEqual([draft.run.id, running.run.id, expired.run.id, verifying.run.id])
    expect(scheduled).toEqual([
      [draft.run.id, draft.run.subject.location],
      [running.run.id, running.run.subject.location],
      [expired.run.id, expired.run.subject.location],
      [verifying.run.id, verifying.run.subject.location],
    ])
    expect(scheduled.some(([runID]) => runID === active.run.id)).toBe(false)
    expect(scheduled.some(([runID]) => [failed.run.id, cancelled.run.id, paused.run.id].includes(runID))).toBe(false)
    expect(WorktreeControlScheduler.CONTROL_EXECUTION_DEADLINE_MS).toBe(ControlOperation.MAX_RUN_DURATION_MS)
    expect(WorktreeControlScheduler.CONTROL_LEASE_TTL_MS).toBeGreaterThan(ControlOperation.MAX_RUN_DURATION_MS)
  })

  effectTest.effect("restart recovery waits for the old lease to expire before scheduling takeover", () =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
      const active = controlSnapshot({
        id: "run_control_restart_lease",
        kind: "worktree.create",
        status: "awaiting_authorization",
        leaseExpiresAt: DateTime.makeUnsafe(nowMs + 1_000),
      })
      const scheduled: AgentRuntime.RunID[] = []
      const input = {
        durable: {
          recoverableControl: () => Effect.succeed([active]),
          orphanedControl: () => Effect.succeed([]),
        },
        scheduler: {
          start: (runID: AgentRuntime.RunID) => Effect.sync(() => void scheduled.push(runID)),
        },
      }

      expect(yield* WorktreeControlScheduler.scanRecoverableControl(input)).toEqual([])
      expect(scheduled).toEqual([])

      yield* TestClock.adjust("1001 millis")
      expect(yield* WorktreeControlScheduler.scanRecoverableControl(input)).toEqual([active.run.id])
      expect(scheduled).toEqual([active.run.id])
    }),
  )

  test("starts the recovery scan immediately in the owning app scope", async () => {
    const scanned = Deferred.makeUnsafe<void>()
    let calls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* WorktreeControlScheduler.startRecoveryScanner({
            durable: {
              recoverableControl: () =>
                Effect.sync(() => {
                  calls += 1
                  Deferred.doneUnsafe(scanned, Effect.void)
                  return []
                }),
              orphanedControl: () => Effect.succeed([]),
            },
            scheduler: { start: () => Effect.void },
            interval: "1 hour",
          })
          yield* Deferred.await(scanned)
        }),
      ),
    )
    expect(calls).toBe(1)
  })
})
