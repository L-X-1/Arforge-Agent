import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { DurableAction } from "../src/runtime/durable-action"
import { mutationRecoveryMessage, project, recoveryMessage } from "../src/tool/execution-state"

const actionID = AgentRuntime.ActionID.make("act_execution_state")

/** The projection consumes snapshots already validated by DurableAction. */
const snapshot = (
  status: AgentRuntime.ActionStatus,
  options: {
    readonly attemptsUsed?: number
    readonly activeAttempt?: number
    readonly observation?: AgentRuntime.Observation["status"]
    readonly mutationIntent?: AgentRuntime.MutationIntent
  } = {},
) =>
  ({
    action: {
      id: actionID,
      status,
      budget: { attemptsUsed: options.attemptsUsed ?? 0 },
    },
    ...(options.activeAttempt === undefined
      ? {}
      : { activeAttempt: { attempt: options.activeAttempt, startedAt: new Date() } }),
    ...(options.observation === undefined ? {} : { observation: { status: options.observation } }),
    ...(options.mutationIntent === undefined ? {} : { mutationIntent: options.mutationIntent }),
    lastSequence: 7,
  }) as unknown as DurableAction.Snapshot

const preparedMutationIntent = (): AgentRuntime.MutationIntent =>
  ({
    version: 1,
    transactionID: AgentRuntime.MutationTransactionID.create(),
    actionID,
    intentDigest: "d".repeat(64),
    idempotencyKey: "idem_execution_state",
    phase: "prepared",
    entries: [],
    manifestDigest: "e".repeat(64),
    automaticRetryAllowed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    summary: "prepared mutation",
  }) as unknown as AgentRuntime.MutationIntent

describe("ToolExecutionState", () => {
  test("projects the durable preparation boundary without inventing a dispatch", () => {
    expect(project(snapshot("proposed"))).toMatchObject({
      state: "not_started",
      actionStatus: "proposed",
      repair: { required: false, source: "none" },
    })
    expect(project(snapshot("authorized"))).toMatchObject({
      state: "prepared",
      actionStatus: "authorized",
      repair: { required: false, source: "none" },
    })
  })

  test("distinguishes a live dispatch from a recovered unknown outcome", () => {
    const live = project(snapshot("executing", { attemptsUsed: 1, activeAttempt: 1 }), "live")
    expect(live).toMatchObject({
      state: "dispatched",
      attempt: 1,
      repair: { required: false, source: "none" },
    })

    const recovered = project(snapshot("executing", { attemptsUsed: 1, activeAttempt: 1 }), "recovery")
    expect(recovered).toMatchObject({
      state: "outcome_unknown",
      attempt: 1,
      repair: { required: true, source: "action-gateway-recovery" },
    })
    expect(recoveryMessage(recovered)).toContain("inspect or reconcile")
  })

  test("requires repair for an observed but not settled result", () => {
    expect(project(snapshot("observed", { attemptsUsed: 1, observation: "failed" }))).toMatchObject({
      state: "observed",
      outcome: "failed",
      repair: { required: true, source: "durable-action" },
    })
    expect(project(snapshot("settled", { attemptsUsed: 1, observation: "succeeded" }))).toMatchObject({
      state: "settled",
      outcome: "succeeded",
      repair: { required: false, source: "none" },
    })
  })

  test("fails closed to outcome_unknown when terminal evidence is contradictory", () => {
    expect(project(snapshot("settled", { attemptsUsed: 1 }))).toMatchObject({
      state: "outcome_unknown",
      repair: { required: true },
    })
    expect(project(snapshot("blocked", { attemptsUsed: 1 }))).toMatchObject({
      state: "outcome_unknown",
      repair: { required: true },
    })
  })

  test("projects mutation recovery and gives a retry-safe operator message", () => {
    const recovered = project(
      snapshot("executing", {
        attemptsUsed: 1,
        activeAttempt: 1,
        mutationIntent: preparedMutationIntent(),
      }),
      "recovery",
    )

    expect(recovered.mutationRecovery).toMatchObject({
      decision: "inspect",
      phase: "prepared",
      automaticRetryAllowed: false,
    })
    expect(mutationRecoveryMessage(recovered)).toContain("Automatic retry is blocked")
    expect(mutationRecoveryMessage(recovered)).toContain("inspect the recorded targets")
    expect(recoveryMessage(recovered)).toContain("Mutation recovery requires inspect")
  })
})
