import { describe, expect, test } from "bun:test"
import { publicErrorMessage } from "./public-error"

describe("publicErrorMessage", () => {
  test("extracts messages from typed API errors instead of rendering object coercion", () => {
    expect(
      publicErrorMessage({
        _tag: "ServiceUnavailableError",
        message: "Arforge Agent capability service is unavailable.",
        service: "arforge-agent-python",
      }),
    ).toBe("Arforge Agent capability service is unavailable.")
  })

  test("finds nested transport messages", () => {
    expect(publicErrorMessage({ error: { cause: { message: "Request timed out." } } })).toBe("Request timed out.")
  })

  test("does not serialize unknown objects and redacts secrets", () => {
    expect(publicErrorMessage({ headers: { authorization: "Bearer hidden" } }, "Unable to continue.")).toBe(
      "Unable to continue.",
    )
    expect(publicErrorMessage(new Error("token=abcdefghijklmnop"))).toBe("token=[REDACTED_SECRET]")
    expect(publicErrorMessage("provider rejected sk-abcdefghijklmnop")).toBe(
      "provider rejected [REDACTED_SECRET]",
    )
  })
})
