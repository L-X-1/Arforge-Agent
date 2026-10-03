import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  VerifierRegistry,
  VerifierRegistryError,
  createDefaultVerifierRegistry,
  completionGate,
  durableSettlementChecks,
  freezeVerifierInput,
  runChecks,
  summarize,
  verificationReport,
  verify,
} from "@arforge-ai/core/runtime/verifier"
import { digest } from "@arforge-ai/core/runtime/insight"
import { checkpointResumeToken } from "@arforge-ai/core/runtime/durable-run"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { DateTime, Effect } from "effect"

describe("RuntimeVerifier", () => {
  it("registers versioned read-only verifiers and emits immutable evidence", async () => {
    const registry = new VerifierRegistry()
    registry.register({
      actionKind: "share",
      actionVersion: "1",
      readOnly: true,
      credentialScope: "independent",
      verify: async (input, context) => [
        {
          command: "share lookup digest",
          exitCode:
            context.credentialScope === "independent" && input.observation.values.digest === "sha-share" ? 0 : 1,
          output: "share observation",
        },
      ],
    })
    const result = await registry.verify(
      freezeVerifierInput({
        frozenIntent: {
          actionKind: "share",
          actionVersion: "1",
          intentDigest: "intent-share",
          payload: { visibility: "private" },
        },
        observation: {
          status: "succeeded",
          observationDigest: "obs-share",
          summary: "provider lookup completed",
          values: { digest: "sha-share" },
        },
        artifactRefs: [{ kind: "share", ref: "share://local/1", digest: "sha-share" }],
        runID: AgentRuntime.RunID.make("run_verifier_registry"),
        actionID: AgentRuntime.ActionID.create(),
        observationID: AgentRuntime.ObservationID.make("obs_verifier_registry"),
      }),
    )
    expect(result.evaluation.passed).toBe(true)
    expect(result.evidence.verificationStatus).toBe("verified")
    expect(result.evidence.instructionAllowed).toBe(false)
    expect(result.evidence.artifactDigest).toBe("sha-share")
    expect(result.evidence.observationIDs).toEqual([AgentRuntime.ObservationID.make("obs_verifier_registry")])
    expect(result.evidenceDigest).toHaveLength(64)
  })

  it("ships independent default verifiers for enabled action kinds", async () => {
    const registry = createDefaultVerifierRegistry()
    expect(registry.list().map((item) => item.actionKind)).toEqual([
      "file",
      "shell",
      "worktree",
      "share",
      "browser",
      "workflow",
    ])
    const result = await registry.verify(
      freezeVerifierInput({
        frozenIntent: { actionKind: "workflow", actionVersion: "1", intentDigest: "intent", payload: {} },
        observation: {
          status: "succeeded",
          observationDigest: "observation",
          summary: "all workflow actions settled",
          values: { requiredStepsSettled: true, actionsSettled: true },
        },
        artifactRefs: [],
      }),
    )
    expect(result.evaluation).toMatchObject({ passed: true, total: 3, passedCount: 3 })
  })

  it("rejects mutable input, duplicate keys, mutation executors, and deadline overruns", async () => {
    const registry = new VerifierRegistry()
    const registration = {
      actionKind: "file",
      actionVersion: "1",
      readOnly: true as const,
      credentialScope: "independent" as const,
      verify: async () => [{ command: "file", exitCode: 0, output: "ok" }],
    }
    registry.register(registration)
    expect(() => registry.register(registration)).toThrow(VerifierRegistryError)
    expect(() =>
      registry.register({
        ...registration,
        actionKind: "unsafe",
        mutationExecutor: async () => undefined,
      } as typeof registration & { mutationExecutor: () => Promise<void> }),
    ).toThrow(/mutation executor/)
    try {
      await registry.verify({
        frozenIntent: { actionKind: "file", actionVersion: "1", intentDigest: "intent", payload: {} },
        observation: { status: "succeeded", observationDigest: "obs", summary: "ok", values: {} },
        artifactRefs: [],
      })
      throw new Error("mutable verifier input unexpectedly passed")
    } catch (error) {
      expect(error).toMatchObject({ code: "INPUT_NOT_FROZEN" })
    }

    const slow = new VerifierRegistry()
    slow.register({
      actionKind: "slow",
      actionVersion: "1",
      readOnly: true,
      credentialScope: "independent",
      deadlineMs: 10,
      verify: async () => {
        await Bun.sleep(50)
        return [{ command: "slow", exitCode: 0, output: "late" }]
      },
    })
    try {
      await slow.verify(
        freezeVerifierInput({
          frozenIntent: { actionKind: "slow", actionVersion: "1", intentDigest: "intent", payload: {} },
          observation: { status: "succeeded", observationDigest: "obs", summary: "ok", values: {} },
          artifactRefs: [],
        }),
      )
      throw new Error("slow verifier unexpectedly passed")
    } catch (error) {
      expect(error).toMatchObject({ code: "DEADLINE_EXCEEDED" })
    }
  })

  it("joins the effectful verifier result to the durable run trace", async () => {
    RuntimeInsight.reset()
    const result = await Effect.runPromise(
      verify({
        runID: "run_verify",
        traceID: "trace_verify",
        sessionID: "ses_verify",
        toolCallID: "tool_verify",
        actionID: "act_verify",
        claim: "checks pass",
        checks: [{ command: "bun test", exitCode: 0, output: "pass" }],
      }),
    )
    expect(result.summary.passed).toBe(true)
    expect(RuntimeInsight.verifications(1)[0]).toMatchObject({
      runID: "run_verify",
      traceID: "trace_verify",
      actionID: "act_verify",
      passed: true,
    })
    expect(RuntimeInsight.metrics().find((metric) => metric.name === "verification.result")).toMatchObject({
      attributes: expect.objectContaining({ runID: "run_verify", traceID: "trace_verify" }),
    })
  })

  it("marks checks ok when exit code is zero", () => {
    const checks = runChecks([
      { command: "npm test", exitCode: 0, output: "all green" },
      { command: "npm run lint", exitCode: 1, output: "lint error here" },
    ])
    expect(checks[0].ok).toBe(true)
    expect(checks[1].ok).toBe(false)
    expect(checks[1].outputTail).toBe("lint error here")
  })

  it("summarizes pass/fail and lists failed commands", () => {
    const checks = runChecks([
      { command: "a", exitCode: 0, output: "" },
      { command: "b", exitCode: 2, output: "boom" },
    ])
    const summary = summarize(checks)
    expect(summary.passed).toBe(false)
    expect(summary.total).toBe(2)
    expect(summary.passedCount).toBe(1)
    expect(summary.failedChecks).toEqual(["b"])
  })

  it("passes only when there are checks and all of them pass", () => {
    expect(summarize([]).passed).toBe(false)
    expect(summarize([{ command: "a", ok: true, exitCode: 0, outputTail: "" }]).passed).toBe(true)
  })

  it("renders a report for the model", () => {
    const report = verificationReport({ passed: false, total: 2, passedCount: 1, failedChecks: ["b"] })
    expect(report).toContain("FAILED")
    expect(report).toContain("`b`")
    const passed = verificationReport({ passed: true, total: 2, passedCount: 2, failedChecks: [] })
    expect(passed).toContain("PASSED")
  })

  it("truncates long outputs", () => {
    const checks = runChecks([{ command: "a", exitCode: 1, output: "x".repeat(2000) }])
    expect(checks[0].outputTail.length).toBeLessThanOrEqual(600)
  })

  it("requires a valid semantic checkpoint and settled successful actions", () => {
    const runID = AgentRuntime.RunID.make("run_test")
    const state = { phase: "tool-loop", cursor: 4 }
    const stateDigest = digest(state)
    const checkpointIdentity = {
      id: AgentRuntime.CheckpointID.create(),
      runID,
      lastActionID: AgentRuntime.ActionID.create(),
      eventSequence: 7,
      stateDigest,
      state,
      createdAt: DateTime.makeUnsafe(1_234),
    }
    const checkpoint = AgentRuntime.Checkpoint.make({
      ...checkpointIdentity,
      resumeToken: checkpointResumeToken(checkpointIdentity),
    })
    expect(
      summarize(
        durableSettlementChecks({
          runID,
          checkpoint,
          actions: [{ actionID: "act_ok", status: "settled", observationStatus: "succeeded" }],
          digest,
        }),
      ).passed,
    ).toBe(true)
    const failed = durableSettlementChecks({
      runID,
      checkpoint: { ...checkpoint, stateDigest: "tampered" },
      actions: [{ actionID: "act_open", status: "executing" }],
      digest,
    })
    expect(summarize(failed).passed).toBe(false)
    expect(failed.map((check) => check.ok)).toEqual([false, false])

    const legacyToken = AgentRuntime.Checkpoint.make({
      ...checkpoint,
      resumeToken: digest({ runID, eventSequence: checkpoint.eventSequence, stateDigest: checkpoint.stateDigest }),
    })
    expect(
      durableSettlementChecks({
        runID,
        checkpoint: legacyToken,
        actions: [{ actionID: "act_ok", status: "settled", observationStatus: "succeeded" }],
        digest,
      })[0].ok,
    ).toBe(false)

    for (const mutation of ["checkpointID", "lastActionID", "eventSequence", "createdAt", "state"] as const) {
      const tampered = AgentRuntime.Checkpoint.make({
        ...checkpoint,
        ...(mutation === "checkpointID" ? { id: AgentRuntime.CheckpointID.create() } : {}),
        ...(mutation === "lastActionID" ? { lastActionID: AgentRuntime.ActionID.create() } : {}),
        ...(mutation === "eventSequence" ? { eventSequence: checkpoint.eventSequence + 1 } : {}),
        ...(mutation === "createdAt" ? { createdAt: DateTime.makeUnsafe(1_235) } : {}),
        ...(mutation === "state" ? { state: { ...state, cursor: 5 } } : {}),
      })
      const tamperedChecks = durableSettlementChecks({
        runID,
        checkpoint: tampered,
        actions: [{ actionID: "act_ok", status: "settled", observationStatus: "succeeded" }],
        digest,
      })
      expect(tamperedChecks[0].ok, mutation).toBe(false)
    }
  })

  it("lets verifier evidence, not a model stop reason, authorize completion", () => {
    const base = {
      runID: "run_completion",
      actions: [{ actionID: "act_ok", status: "settled", observationStatus: "succeeded" }],
      digest,
    }
    const state = { phase: "complete" }
    const stateDigest = digest(state)
    const checkpointIdentity = {
      id: AgentRuntime.CheckpointID.create(),
      runID: AgentRuntime.RunID.make(base.runID),
      lastActionID: AgentRuntime.ActionID.create(),
      eventSequence: 2,
      stateDigest,
      state,
      createdAt: DateTime.makeUnsafe(1_234),
    }
    const checkpoint = AgentRuntime.Checkpoint.make({
      ...checkpointIdentity,
      resumeToken: checkpointResumeToken(checkpointIdentity),
    })
    expect(
      completionGate({
        ...base,
        checkpoint,
        independentVerifierPassed: true,
        modelStopReason: "finished",
      }).allowed,
    ).toBe(true)
    expect(
      completionGate({
        ...base,
        checkpoint,
        independentVerifierPassed: false,
        modelStopReason: "finished",
      }),
    ).toMatchObject({ allowed: false, summary: { passed: false } })
  })
})
