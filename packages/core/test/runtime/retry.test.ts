import { describe, expect, test } from "bun:test"
import { AuthenticationReason, ContentPolicyReason, LLMError, RateLimitReason, TransportReason } from "@arforge-ai/llm"
import { RuntimeRetry, classifyFailure, decide } from "../../src/runtime/retry"

const error = (reason: ConstructorParameters<typeof RateLimitReason>[0] & { _tag: "RateLimit" }) =>
  new LLMError({ module: "test", method: "stream", reason: new RateLimitReason(reason) })

describe("RuntimeRetry", () => {
  test("retries rate limits before visible output, then offers fallback", () => {
    const failure = error({ _tag: "RateLimit", message: "provider rate limit" })
    expect(classifyFailure(failure)).toBe("rate-limit")
    expect(
      decide({
        failure,
        outputStarted: false,
        toolCallStarted: false,
        transportRetriesUsed: 0,
        maxTransportRetries: 1,
        fallbackAvailable: true,
      }),
    ).toMatchObject({ action: "retry", category: "rate-limit" })
    expect(
      decide({
        failure,
        outputStarted: false,
        toolCallStarted: false,
        transportRetriesUsed: 1,
        maxTransportRetries: 1,
        fallbackAvailable: true,
      }),
    ).toMatchObject({ action: "fallback", category: "rate-limit" })
  })

  test("stops after visible or executable output", () => {
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ message: "connection dropped" }),
    })
    expect(
      decide({
        failure,
        outputStarted: true,
        toolCallStarted: false,
        transportRetriesUsed: 0,
        maxTransportRetries: 3,
        fallbackAvailable: true,
      }),
    ).toMatchObject({ action: "stop", category: "transport" })
    expect(
      decide({
        failure,
        outputStarted: false,
        toolCallStarted: true,
        transportRetriesUsed: 0,
        maxTransportRetries: 3,
        fallbackAvailable: true,
      }),
    ).toMatchObject({ action: "stop", category: "transport" })
  })

  test("classifies auth and content policy separately and never retries them", () => {
    const authFailure = new LLMError({
      module: "test",
      method: "stream",
      reason: new AuthenticationReason({ message: "credential rejected", kind: "invalid" }),
    })
    const contentFailure = new LLMError({
      module: "test",
      method: "stream",
      reason: new ContentPolicyReason({ message: "blocked" }),
    })
    expect(classifyFailure(authFailure)).toBe("auth")
    expect(classifyFailure(contentFailure)).toBe("content-policy")
    expect(
      RuntimeRetry.decide({
        failure: contentFailure,
        outputStarted: false,
        toolCallStarted: false,
        transportRetriesUsed: 0,
        maxTransportRetries: 3,
        fallbackAvailable: true,
      }).action,
    ).toBe("stop")
    expect(
      RuntimeRetry.decide({
        failure: authFailure,
        outputStarted: false,
        toolCallStarted: false,
        transportRetriesUsed: 3,
        maxTransportRetries: 3,
        fallbackAvailable: true,
      }).action,
    ).toBe("fallback")
  })
})
