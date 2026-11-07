import { describe, expect, test } from "bun:test"
import { executionErrorPresentation } from "./session-execution-error-model"

describe("execution failure card public details", () => {
  test("keeps only bounded public message/type and removes synthetic credentials", () => {
    const error = {
      name: "APIError",
      data: {
        message:
          "Failed https://user:synthetic-password@example.test/api?api_key=synthetic-key Authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnop " +
          "large ".repeat(3000),
        headers: { secret: "hidden-header" },
        body: "hidden-provider-body",
      },
    }
    const view = executionErrorPresentation(error, "Request failed")
    expect(view.type).toBe("APIError")
    expect(view.message.length).toBeLessThanOrEqual(2000)
    for (const secret of [
      "synthetic-password",
      "synthetic-key",
      "abcdefghijklmnop",
      "hidden-header",
      "hidden-provider-body",
    ])
      expect(view.message).not.toContain(secret)
  })
  test("does not serialize a response without a public message", () => {
    expect(
      executionErrorPresentation(
        { name: "UnknownError", headers: { authorization: "synthetic" }, body: "synthetic body" },
        "Request failed",
      ),
    ).toEqual({ type: "UnknownError", message: "Request failed" })
  })
})
