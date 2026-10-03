import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { ControlPlaneMutationPayload } from "../src/control-principal"

describe("protocol control-plane request contract", () => {
  test("client mutation envelope contains request identity only", () => {
    const fields = ControlPlaneMutationPayload.fields
    expect("tenantID" in fields).toBe(false)
    expect("userID" in fields).toBe(false)
    expect("actor" in fields).toBe(false)
    expect("principalRef" in fields).toBe(false)

    const payload = Schema.encodeSync(ControlPlaneMutationPayload)({
      requestID: AgentRuntime.ControlPlaneRequestID.create(),
    })
    expect(Object.keys(payload)).toEqual(["requestID"])
  })
})
