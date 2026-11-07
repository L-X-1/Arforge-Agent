import { describe, expect, test } from "bun:test"
import { executionContentPreview } from "./execution-content-preview"

describe("execution original-line preview", () => {
  test.each([19, 20])("preserves all %i lines without a disclosure", (count) => {
    const content = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")
    expect(executionContentPreview(content)).toEqual({ text: content, totalLines: count, shownLines: count, collapsible: false })
  })

  test("limits 21 lines to the first 20 and expands to the exact original", () => {
    const lines = Array.from({ length: 21 }, (_, i) => `line ${i + 1}: 完整 😀`)
    const content = lines.join("\n")
    expect(executionContentPreview(content)).toEqual({ text: lines.slice(0, 20).join("\n"), totalLines: 21, shownLines: 20, collapsible: true })
    expect(executionContentPreview(content, true)).toEqual({ text: content, totalLines: 21, shownLines: 21, collapsible: true })
  })

  test("retains CRLF, mixed separators and a final blank line exactly", () => {
    const prefix = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\r\n")
    const content = prefix + "\r\nlast\rtrailing\n"
    expect(executionContentPreview(content)).toEqual({ text: prefix, totalLines: 23, shownLines: 20, collapsible: true })
    expect(executionContentPreview(content, true).text).toBe(content)
  })

  test("never character-truncates a long single line", () => {
    const content = "完整😀".repeat(20000)
    expect(executionContentPreview(content)).toEqual({ text: content, totalLines: 1, shownLines: 1, collapsible: false })
  })

  test("does not invent a line for empty output", () => {
    expect(executionContentPreview("")).toEqual({ text: "", totalLines: 0, shownLines: 0, collapsible: false })
  })
})
