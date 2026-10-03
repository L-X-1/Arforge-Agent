import { describe, expect, test } from "bun:test"
import { agentExtensionPublicError, isRetiredAgentCapabilityError } from "./agent-extension-error"

describe("Agent extension public errors", () => {
  test("recognizes a retired capability inside a serialized server error", () => {
    const error = new Error(
      JSON.stringify({
        _tag: "InvalidRequestError",
        message: "internal implementation detail",
        kind: "agent-capability-retired",
      }),
    )
    expect(isRetiredAgentCapabilityError(error)).toBe(true)
  })

  test("never exposes an unrecognized structured error as raw JSON", () => {
    const error = { _tag: "UnknownError", body: { secret: "must-not-leak" } }
    expect(agentExtensionPublicError(error, "Try again")).toBe("Try again")
  })

  test("keeps a plain actionable error message", () => {
    expect(agentExtensionPublicError(new Error("Refresh and try again"), "Fallback")).toBe("Refresh and try again")
  })
})
