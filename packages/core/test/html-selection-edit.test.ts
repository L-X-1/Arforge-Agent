import { createHash } from "node:crypto"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { prepareHtmlSelectionEdit } from "../src/tool/html-selection-edit"

const directory = path.resolve("html-selection-fixture")
const element = '<h1 id="selected">\u4e2d\u6587 \ud83d\ude80 &amp; title</h1>'
const source = `<!-- prefix -->\r\n${element}\r\n<p>Keep me</p>`
const snapshot = (text = source) => ({
  path: "page.html", directory,
  revision: createHash("sha256").update(text).digest("hex"),
  mode: "file-preview" as const,
  start: text.indexOf(element), end: text.indexOf(element) + element.length,
})
const input = () => ({
  directory, path: "page.html", content: new TextEncoder().encode(source),
  guard: snapshot(), oldString: element, newString: '<h1 id="selected" style="font-size:32px">Changed</h1>',
})

describe("guarded HTML source editing", () => {
  test("changes only the captured UTF-16 range and preserves surrounding CRLF source", () => {
    const value = input()
    expect(prepareHtmlSelectionEdit(value).after).toBe(source.replace(element, value.newString))
  })

  test("targets the selected occurrence instead of guessing among duplicates", () => {
    const text = `${element}\n${element}`
    const value = input()
    const guard = { ...snapshot(text), start: element.length + 1, end: text.length }
    expect(prepareHtmlSelectionEdit({ ...value, content: new TextEncoder().encode(text), guard }).after)
      .toBe(`${element}\n${value.newString}`)
  })

  test("hashes BOM-free source while leaving BOM preservation to the file writer", () => {
    const value = input()
    expect(prepareHtmlSelectionEdit({ ...value, content: new TextEncoder().encode(`\uFEFF${source}`) }).after)
      .toBe(source.replace(element, value.newString))
  })

  test("rejects a stale full-file version even when the selected text still matches", () => {
    expect(() => prepareHtmlSelectionEdit({ ...input(), content: new TextEncoder().encode(`${source}\nnew outside edit`) }))
      .toThrow("changed after this selection")
  })

  test("rejects a different file, workspace, and an external target", () => {
    const value = input()
    for (const changed of [
      { ...value, path: "another.html" },
      { ...value, guard: { ...value.guard, directory: path.resolve(directory, "other") } },
      { ...value, path: "../outside.html", guard: { ...value.guard, path: "../outside.html" } },
    ]) expect(() => prepareHtmlSelectionEdit(changed)).toThrow("file and workspace")
  })

  test("rejects unsaved buffers, replaceAll and truncated-sized selections", () => {
    const value = input()
    expect(() => prepareHtmlSelectionEdit({ ...value, guard: { ...value.guard, mode: "editor-buffer" } })).toThrow("reference-only")
    expect(() => prepareHtmlSelectionEdit({ ...value, replaceAll: true })).toThrow("replaceAll")
    expect(() => prepareHtmlSelectionEdit({ ...value, guard: { ...value.guard, end: value.guard.start + 8001 } })).toThrow("bounded")
  })

  test("rejects partial oldString, invalid bounds and malformed hashes", () => {
    const value = input()
    expect(() => prepareHtmlSelectionEdit({ ...value, oldString: "title" })).toThrow("entire captured")
    for (const guard of [
      { ...value.guard, start: -1 }, { ...value.guard, start: 1.5 },
      { ...value.guard, end: value.guard.start }, { ...value.guard, revision: "not-a-hash" },
    ]) expect(() => prepareHtmlSelectionEdit({ ...value, guard })).toThrow("bounded")
  })

  test("rejects invalid UTF-8, NUL, oversized replacements, and no-op replacements", () => {
    const value = input()
    expect(() => prepareHtmlSelectionEdit({ ...value, content: new Uint8Array([0xff]) })).toThrow("UTF-8")
    expect(() => prepareHtmlSelectionEdit({ ...value, content: new TextEncoder().encode(`${source}\0`) })).toThrow("supported")
    expect(() => prepareHtmlSelectionEdit({ ...value, newString: "x".repeat(8001) })).toThrow("bounded")
    expect(() => prepareHtmlSelectionEdit({ ...value, newString: element })).toThrow("does not change")
  })

  test("adapts new multiline content to the existing CRLF convention without normalizing other source", () => {
    const value = { ...input(), newString: "<h1>\nChanged\n</h1>" }
    expect(prepareHtmlSelectionEdit(value).after).toBe(source.replace(element, "<h1>\r\nChanged\r\n</h1>"))
  })
})
