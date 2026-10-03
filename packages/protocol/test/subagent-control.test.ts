import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { SubagentControl } from "@arforge-ai/schema/subagent-control"

const requestID = AgentRuntime.ControlPlaneRequestID.make("cpr_protocol_subagent_control")
const runID = AgentRuntime.RunID.make("run_protocol_subagent_control")
const prompt = { text: "queue this child instruction" }

describe("subagent control protocol contract", () => {
  test("receipt metadata round-trips without treating older responses as ready", () => {
    const base = {
      operation: "wait" as const,
      parentRunID: runID,
      childRunID: AgentRuntime.RunID.make("run_protocol_child"),
      status: "completed" as const,
      timedOut: false,
    }
    for (const resultReceiptStatus of ["pending", "missing", "present", "not-required"] as const) {
      const decoded = Schema.decodeUnknownSync(SubagentControl.Response)({ ...base, resultReceiptStatus })
      expect(Schema.encodeSync(SubagentControl.Response)(decoded)).toEqual({ ...base, resultReceiptStatus })
    }
    const old = Schema.decodeUnknownSync(SubagentControl.Response)(base)
    expect(old.resultReceiptStatus).toBeUndefined()
    expect(Schema.encodeSync(SubagentControl.Response)({ ...old, resultReceiptStatus: undefined })).toEqual(base)
    expect(() =>
      Schema.decodeUnknownSync(SubagentControl.Response)({ ...base, resultReceiptStatus: "ready" }),
    ).toThrow()
  })

  test("round-trips steer/followup payloads without lease fields", () => {
    const steer = Schema.decodeUnknownSync(SubagentControl.SteerPayload, { onExcessProperty: "error" })({
      requestID,
      prompt,
    })
    expect(steer.requestID).toBe(requestID)
    expect(steer.prompt.text).toBe(prompt.text)

    const followup = Schema.encodeSync(SubagentControl.FollowupPayload)({ requestID, prompt })
    expect(followup).toEqual({ requestID, prompt })
    expect(() =>
      Schema.decodeUnknownSync(SubagentControl.SteerPayload, { onExcessProperty: "error" })({
        requestID,
        prompt,
        leaseID: "lea_client_must_not_supply",
        ownerID: "forged-worker",
      }),
    ).toThrow()
  })

  test("enforces bounded observation and cancellation payloads", () => {
    const wait = Schema.decodeUnknownSync(SubagentControl.WaitPayload, { onExcessProperty: "error" })({
      requestID,
      timeoutMs: 0,
    })
    expect(wait.timeoutMs).toBe(0)
    expect(() => Schema.decodeUnknownSync(SubagentControl.WaitPayload)({ requestID, timeoutMs: 60_001 })).toThrow()

    const cancel = Schema.decodeUnknownSync(SubagentControl.CancelPayload)({
      requestID,
      reason: "stop the child",
      recursive: true,
    })
    expect(cancel.reason).toBe("stop the child")
    expect(cancel.recursive).toBe(true)
    expect(() => Schema.decodeUnknownSync(SubagentControl.CancelPayload)({ requestID, reason: "   " })).toThrow()
  })

  test("response projects only safe control metadata", () => {
    const response = Schema.decodeUnknownSync(SubagentControl.Response, { onExcessProperty: "error" })({
      operation: "steer",
      parentRunID: runID,
      childRunID: AgentRuntime.RunID.make("run_protocol_child"),
      status: "running",
      timedOut: false,
      requestID,
      admission: {
        messageID: "msg_protocol_control",
        sessionID: "ses_protocol_control",
        delivery: "steer",
        promptDigest: "a".repeat(64),
        envelopeDigest: "b".repeat(64),
      },
      controlRunID: AgentRuntime.RunID.make("run_protocol_claim"),
      actionID: AgentRuntime.ActionID.make("act_protocol_claim"),
      claim: "claimed",
    })
    expect(response.timedOut).toBe(false)
    expect(JSON.stringify(response)).not.toContain("leaseID")
    expect(JSON.stringify(response)).not.toContain("ownerID")
    expect(JSON.stringify(response)).not.toContain("queue this child instruction")
    expect(() =>
      Schema.decodeUnknownSync(SubagentControl.Response, { onExcessProperty: "error" })({
        ...response,
        leaseID: "lea_should_not_be_returned",
      }),
    ).toThrow()
  })
})
