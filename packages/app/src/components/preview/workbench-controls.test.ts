import { describe, expect, test } from "bun:test"
import { previewDownloadBytes, previewDownloadName, previewLocalPath } from "./preview-export"
import { findPdfPages } from "./pdf-search"

describe("authorized preview exports", () => {
  test("preserves binary snapshots and empty text", () => {
    expect([...previewDownloadBytes({ type: "binary", encoding: "base64", content: "AAH/" })]).toEqual([0, 1, 255])
    expect(previewDownloadBytes({ type: "text", content: "" }).length).toBe(0)
    expect(() => previewDownloadBytes({ type: "binary", content: "private" })).toThrow()
    expect(previewDownloadName("C:\\project\\report.pdf")).toBe("report.pdf")
    expect(previewDownloadName("/workspace/a\u0000.txt")).toBe("a_.txt")
  })
  test("native targets stay inside the current workspace", () => {
    expect(previewLocalPath("C:\\project", "reports/a.pdf")).toBe("C:/project/reports/a.pdf")
    expect(previewLocalPath("C:/project", "c:/PROJECT/a.pdf")).toBe("c:/PROJECT/a.pdf")
    expect(previewLocalPath("/project", "/project/a.pdf")).toBe("/project/a.pdf")
    for (const path of ["../other/a.pdf", "a/../../other.pdf", "/project2/a.pdf", "D:/a.pdf", "file:///project/a.pdf", "https://example.com/a.pdf"]) {
      expect(previewLocalPath("/project", path)).toBeUndefined()
    }
  })
})
describe("PDF document search", () => {
  test("searches all pages and matches normalized text without executing document content", async () => {
    const pages = ["An introduction", "Hello\nworld", "HELLO world again"]
    expect(await findPdfPages({ pages: 3, query: "hello world", read: async (page) => pages[page - 1]!, current: () => true })).toEqual([2, 3])
  })
  test("drops in-flight results when the document or query changes", async () => {
    let current = true
    const seen: number[] = []
    expect(await findPdfPages({ pages: 3, query: "result", current: () => current, read: async (page) => { seen.push(page); current = false; return "result" } })).toBeUndefined()
    expect(seen).toEqual([1])
  })
  test("empty queries do not read pages and failures remain recoverable", async () => {
    expect(await findPdfPages({ pages: 1, query: " ", current: () => true, read: async () => { throw new Error("should not read") } })).toEqual([])
    await expect(findPdfPages({ pages: 1, query: "x", current: () => true, read: async () => { throw new Error("read failed") } })).rejects.toThrow("read failed")
  })
})
