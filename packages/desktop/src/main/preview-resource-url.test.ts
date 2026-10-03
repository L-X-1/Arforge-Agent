import { describe, expect, test } from "bun:test"
import { redactPreviewResourceURLs } from "./preview-resource-url"

describe("preview capability log redaction", () => {
  test("redacts capability tokens wherever a resource URL appears", () => {
    const token = "a".repeat(64)
    const output = redactPreviewResourceURLs(`Failed http://127.0.0.2:43210/resources/${token}/styles/main.css and http://127.0.0.2:43210/resources/${token}`)
    expect(output).not.toContain(token)
    expect(output).toContain("[redacted]/styles/main.css")
    expect(output).not.toContain(":43210")
  })

  test("leaves unrelated application diagnostics unchanged", () => {
    const input = "Failed http://127.0.0.1:4096/api/fs/text: connection refused"
    expect(redactPreviewResourceURLs(input)).toBe(input)
  })
})
