import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AgentRuntime } from "../src/agent-runtime"
import { FileSystem } from "../src/filesystem"

describe("schema compatibility", () => {
  test("moved class schemas remain constructible", () => {
    const input = new FileSystem.FindInput({ query: "src" })
    expect(input).toBeInstanceOf(FileSystem.FindInput)
    expect(input.query).toBe("src")
  })

  test("legacy run budgets decode with a conservative token allowance", () => {
    const budget = Schema.decodeUnknownSync(AgentRuntime.Budget)({
      maxAttempts: 3,
      maxDurationMs: 60_000,
      maxCostMicros: 5_000_000,
      attemptsUsed: 1,
      durationMsUsed: 20,
      costMicrosUsed: 30,
    })

    expect(budget).toMatchObject({
      maxTokens: AgentRuntime.DEFAULT_MAX_TOKENS,
      tokensUsed: 0,
    })
  })

  test("legacy attempt events decode without a usage baseline or token counter", () => {
    const started = Schema.decodeUnknownSync(AgentRuntime.Event.RunAttemptStarted.data)({
      runID: "run_compat_started",
      sessionID: "ses_compat",
      attempt: 1,
      startedAt: 1,
    })
    const finished = Schema.decodeUnknownSync(AgentRuntime.Event.RunAttemptFinished.data)({
      runID: "run_compat_finished",
      sessionID: "ses_compat",
      attempt: 1,
      outcome: "completed",
      durationMs: 2,
      costMicros: 3,
      finishedAt: 4,
    })
    const controlFinished = Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunAttemptFinished.data)({
      runID: "run_compat_control",
      subject: {
        type: "control-plane",
        id: "ctl_compat",
        location: "/project",
        project: "global",
        actor: "user",
        principalRef: "prn_compat",
        requestID: "cpr_compat",
      },
      attempt: 1,
      outcome: "failed",
      durationMs: 5,
      costMicros: 6,
      finishedAt: 7,
    })

    expect(started.usageBaseline).toBeUndefined()
    expect(finished.tokens).toBe(0)
    expect(controlFinished.tokens).toBe(0)
  })
})
