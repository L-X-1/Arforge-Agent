import { describe, expect, test } from "bun:test"
import { markdownCodeSources, markdownCodeLineCount, projectMarkdownCodeSources } from "./markdown-code-source"
import { project } from "./markdown-stream"

describe("markdown original code source", () => {
  test("retains exact CRLF, Unicode, trailing whitespace and closing-fence boundary", () => {
    const body = "const emoji = '😀'  \r\n\tconsole.log(emoji)\r\n"
    const [source] = markdownCodeSources("Before\r\n\r\n```typescript title=sample\r\n" + body + "```\r\nAfter")
    expect(source?.text).toBe(body)
    expect(source?.language).toBe("typescript")
    expect(markdownCodeLineCount(source!.text)).toBe(3)
  })

  test("keeps open streamed code and partially arriving fences as the actual current source", () => {
    expect(markdownCodeSources("```not-a-shiki-language\r\nline1\r\nline2\r\n")[0]?.text).toBe("line1\r\nline2\r\n")
    expect(markdownCodeSources("```ts\nline1\n``")[0]?.text).toBe("line1\n``")
    expect(markdownCodeSources("```ts\nline1\n```")[0]?.text).toBe("line1\n")
  })

  test("uses Markdown container semantics while retaining original line endings", () => {
    const result = markdownCodeSources("> ```js\r\n> const x = 1\r\n> ```\r\n\r\n- ```py\r\n  print('二')\r\n  ```\r\n")
    expect(result.map(source => source.text)).toEqual(["const x = 1\r\n", "print('二')\r\n"])
    expect(result.map(source => source.language)).toEqual(["js", "py"])
  })

  test("does not assign a duplicate fence to an earlier code block", () => {
    const result = markdownCodeSources("```\none\r\n```\n\n```\none\n```\n")
    expect(result.map(source => source.text)).toEqual(["one\r\n", "one\n"])
  })

  test("retains meaningful blank lines and indentation without including fences", () => {
    expect(markdownCodeSources("  ~~~~txt\r  one\r  \r  two\r  ~~~~")[0]?.text).toBe("  one\r  \r  two\r")
    expect(markdownCodeSources("    one\r\n    two\r\n\r\nafter")[0]?.text).toBe("one\r\ntwo\r\n")
    expect(markdownCodeSources("```\n``` ")[0]?.text).toBe("")
  })

  test("counts original rather than wrapped lines and preserves a final blank line", () => {
    expect(markdownCodeLineCount("long ".repeat(1000))).toBe(1)
    expect(markdownCodeLineCount(Array.from({ length: 20 }, (_, index) => index).join("\r\n"))).toBe(20)
    expect(markdownCodeLineCount("a\r\nb\rc\n")).toBe(4)
  })

  test("appends original streamed EOLs without replacing completed code sources and drops a closing fence from copy", () => {
    const first = "```js\r\none\r\n```\r\n\r\n```ts\r\nconst x = 1\r"
    const firstBlocks = project(undefined, first, true)
    const initial = projectMarkdownCodeSources(undefined, first, firstBlocks.blocks.at(-1))
    const second = first + "\nconst y = 2\r\n"
    const nextBlocks = project(firstBlocks, second, true)
    const next = projectMarkdownCodeSources(initial, second, nextBlocks.blocks.at(-1))
    expect(next.sources[0]).toBe(initial.sources[0])
    expect(next.sources[1]?.text).toBe("const x = 1\r\nconst y = 2\r\n")
    const closed = second + "```"
    expect(projectMarkdownCodeSources(next, closed, project(nextBlocks, closed, true).blocks.at(-1)).sources[1]?.text).toBe(next.sources[1]!.text)
  })
})
