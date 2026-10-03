import { describe, expect, test } from "bun:test"
import { markdownPreviewLink, MARKDOWN_PREVIEW_MAX_CHARACTERS } from "./markdown-preview-model"

describe("read-only Markdown preview", () => {
  test("only permits explicit HTTP links opened by a user action", () => {
    expect(markdownPreviewLink("https://example.com/docs?q=hello#intro")).toBe("https://example.com/docs?q=hello#intro")
    expect(markdownPreviewLink(" http://localhost:3000/ ")).toBe("http://localhost:3000/")
  })
  test.each([
    "javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/private.txt",
    "//example.com/", "../image.png", "#heading", "https://user:password@example.com/", "https://example.com/\nfile",
  ])("does not navigate to %s", (value) => {
    expect(markdownPreviewLink(value)).toBeUndefined()
  })
  test("bounds the initial rich preview work without limiting source viewing", () => {
    expect(MARKDOWN_PREVIEW_MAX_CHARACTERS).toBe(500_000)
  })
})
