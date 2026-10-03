import { expect, test } from "bun:test"
import type {
  McpAuthCallbackData as V1McpAuthCallbackData,
  McpAuthStartResponse as V1McpAuthStartResponse,
} from "../src/gen/types.gen"
import type {
  McpAuthCallbackData as V2McpAuthCallbackData,
  McpAuthStartResponse as V2McpAuthStartResponse,
} from "../src/v2/gen/types.gen"

test("v1 and v2 carry the OAuth attempt capability from start to callback", () => {
  const v1Start = {
    authorizationUrl: "https://example.test/authorize",
    oauthState: "v1-attempt-capability",
  } satisfies V1McpAuthStartResponse
  const v1Callback = {
    code: "v1-code",
    oauthState: v1Start.oauthState,
  } satisfies NonNullable<V1McpAuthCallbackData["body"]>

  const v2Start = {
    authorizationUrl: "https://example.test/authorize",
    oauthState: "v2-attempt-capability",
  } satisfies V2McpAuthStartResponse
  const v2Callback = {
    code: "v2-code",
    oauthState: v2Start.oauthState,
  } satisfies NonNullable<V2McpAuthCallbackData["body"]>

  expect(v1Callback.oauthState).toBe(v1Start.oauthState)
  expect(v2Callback.oauthState).toBe(v2Start.oauthState)
})
