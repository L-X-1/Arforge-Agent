import { describe, expect, test } from "bun:test"
import { parsePromptInputV2Editor } from "./index"

describe("native contenteditable prompt text", () => {
  for (const [html, expected] of [
    ["First line<div>Second line</div>", "First line\nSecond line"],
    ["First line<div><br></div><div>Third line</div>", "First line\n\nThird line"],
    ["<div>First line</div><div>Second line</div>", "First line\nSecond line"],
    ["First line<div><br></div>", "First line\n"],
  ]) test(`preserves browser line structure ${html}`, () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    editor.innerHTML = html
    expect(parsePromptInputV2Editor(editor).map(part => part.content).join("")).toBe(expected)
  })
  test("accounts for a line boundary in mention offsets", () => {
    const editor = document.createElement("div")
    editor.innerHTML = 'First<div><span data-mention="file" data-path="sample.txt">@sample.txt</span> after</div>'
    expect(parsePromptInputV2Editor(editor)).toEqual([
      { type: "text", content: "First\n", start: 0, end: 6 },
      { type: "file", content: "@sample.txt", path: "sample.txt", start: 6, end: 17 },
      { type: "text", content: " after", start: 17, end: 23 },
    ])
  })
})
