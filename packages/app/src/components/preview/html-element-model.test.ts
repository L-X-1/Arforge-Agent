import { describe, expect, test } from "bun:test"
import { decodeHtmlElementMessage, htmlElementExcerpt, htmlLineStarts, mapHtmlElements } from "./html-element-model"

const marker = "a".repeat(32)

describe("HTML element source mapping", () => {
  test("uses exact UTF-16 ranges, including CRLF, Chinese text and entities", () => {
    const source = '<!doctype html>\r\n<html><body>\r\n  <h1 id="title">\u4e2d\u6587 &amp; \ud83d\ude80</h1>\r\n</body></html>'
    const result = mapHtmlElements(source, marker)
    const heading = result.elements.find((element) => element.tag === "h1")!
    expect(source.slice(heading.start, heading.end)).toBe('<h1 id="title">\u4e2d\u6587 &amp; \ud83d\ude80</h1>')
    expect(heading).toMatchObject({ line: 3, column: 3, endLine: 3 })
    expect(htmlElementExcerpt(source, heading).text).toBe(source.slice(heading.start, heading.end))
    expect(htmlLineStarts("a\rb\r\nc\nd")).toEqual([0, 2, 5, 7])
  })

  test("distinguishes repeated tags by source position and preserves original title metadata", () => {
    const source = '<p title="original">Same</p>\n<p>Same</p>'
    const result = mapHtmlElements(source, marker)
    expect(result.elements).toHaveLength(2)
    expect(result.elements[0]!.id).not.toBe(result.elements[1]!.id)
    expect(result.elements[0]!.originalTitle).toBe("original")
    expect(result.elements[1]!.line).toBe(2)
    expect(result.markup).toContain(result.markerPrefix + result.elements[0]!.id)
  })

  test("does not map generated wrappers, scripts, styles, forms or foreign markup", () => {
    const result = mapHtmlElements('<style>h1{color:red}</style><script>bad()</script><form><input></form><svg><text>x</text></svg><table><tr><td>Cell</td></tr></table>', marker)
    expect(result.elements.map((element) => element.tag)).toEqual(["table", "tr", "td"])
    expect(result.elements.some((element) => element.tag === "tbody")).toBe(false)
  })

  test("strips forged internal markers and keeps quoted angle brackets inside attributes", () => {
    const source = '<h2 data-arforge-source="element-999" title="a > b">A</h2>'
    const result = mapHtmlElements(source, marker)
    expect(result.markup).not.toContain("data-arforge-source")
    expect(result.elements).toHaveLength(1)
    expect(htmlElementExcerpt(source, result.elements[0]!).text).toBe(source)
    expect(result.elements[0]!.originalTitle).toBe("a > b")
  })

  test("bounds parsing, element indexes and source excerpts", () => {
    expect(() => mapHtmlElements("x".repeat(500_001), marker)).toThrow()
    const result = mapHtmlElements("<p>x</p>".repeat(1501), marker)
    expect(result.elements).toHaveLength(1500)
    expect(result.limited).toBe(true)
    expect(htmlElementExcerpt("<p>abcdef</p>", mapHtmlElements("<p>abcdef</p>", marker).elements[0]!, 4)).toEqual({ text: "<p>a", truncated: true })
    expect(() => mapHtmlElements("<p>x</p>", "untrusted\"marker")).toThrow()
  })
})

describe("HTML element bridge message boundary", () => {
  const session = { frameID: "frame-one", revision: "revision-one", elements: mapHtmlElements("<h1>Pick</h1>", marker).elements }
  const data = { type: "arforge.html-element", frameID: session.frameID, revision: session.revision, kind: "select", id: session.elements[0]!.id }

  test("resolves only current, indexed identities without trusting source positions from the iframe", () => {
    expect(decodeHtmlElementMessage({ data: { ...data, start: -999, path: "C:/private" }, origin: "null", sourceMatches: true }, session)).toEqual({ kind: "select", element: session.elements[0] })
  })

  test("rejects other windows, non-opaque origins, stale versions and unknown IDs", () => {
    expect(decodeHtmlElementMessage({ data, origin: "null", sourceMatches: false }, session)).toBeUndefined()
    expect(decodeHtmlElementMessage({ data, origin: "http://localhost", sourceMatches: true }, session)).toBeUndefined()
    for (const invalid of [null, "message", { ...data, type: "other" }, { ...data, frameID: "other" }, { ...data, revision: "stale" }, { ...data, id: "unknown" }, { ...data, kind: "write-file" }]) {
      expect(decodeHtmlElementMessage({ data: invalid, origin: "null", sourceMatches: true }, session)).toBeUndefined()
    }
  })

  test("recognizes bounded lifecycle messages", () => {
    for (const kind of ["ready", "cancel"] as const) {
      expect(decodeHtmlElementMessage({ data: { ...data, kind }, origin: "null", sourceMatches: true }, session)).toEqual({ kind })
    }
  })
})
