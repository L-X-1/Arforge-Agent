import { describe, expect, test } from "bun:test"
import { inflateRawSync } from "node:zlib"
import { extractOfficeText } from "@arforge-ai/core/office-document"
import { encodePdf, MAX_PDF_LINES, MAX_PDF_TEXT_CHARS } from "@arforge-ai/core/pdf-document-writer"
import {
  encodeDocx,
  encodePptxJson,
  encodeXlsx,
  encodeXlsxJson,
  MAX_XLSX_CELL_CHARS,
  MAX_XLSX_COLUMNS,
  MAX_XLSX_ROWS,
  MAX_DOCX_PARAGRAPHS,
  MAX_DOCX_TEXT_CHARS,
  MAX_PPTX_SLIDE_CHARS,
  OfficeDocumentWriteError,
} from "@arforge-ai/core/office-document-writer"

const zipEntryText = (bytes: Uint8Array, wanted: string): string => {
  const archive = Buffer.from(bytes)
  for (let offset = 0; offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50; ) {
    const method = archive.readUInt16LE(offset + 8)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
    const payloadStart = offset + 30 + nameLength + extraLength
    const payload = archive.subarray(payloadStart, payloadStart + compressedSize)
    if (name === wanted) return (method === 8 ? inflateRawSync(payload) : payload).toString("utf8")
    offset = payloadStart + compressedSize
  }
  throw new Error(`missing ZIP entry: ${wanted}`)
}

describe("OfficeDocumentWriter", () => {
  test("encodes a deterministic bounded XLSX that the Core reader can round-trip", () => {
    const input = {
      sheetName: "经营数据",
      rows: [
        ["月份", "收入", "达标"],
        ["六月 & 七月", 128, true],
        [null, -4.5, false],
      ],
    } as const
    const first = encodeXlsx(input)
    const second = encodeXlsx(input)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    expect(first.byteLength).toBeGreaterThan(0)
    expect(extractOfficeText(first, ".xlsx")).toEqual({
      ok: true,
      engine: "ooxml",
      text: "月份\t收入\t达标\n六月 & 七月\t128\tTRUE\n\t-4.5\tFALSE",
    })
  })

  test("normalizes object rows into a stable first-seen header", () => {
    const bytes = encodeXlsxJson(
      JSON.stringify([
        { b: 2, a: "first" },
        { a: "second", c: true },
      ]),
    )
    expect(extractOfficeText(bytes, ".xlsx")).toEqual({
      ok: true,
      engine: "ooxml",
      text: "b\ta\tc\n2\tfirst\n\tsecond\tTRUE",
    })
  })

  test("encodes bounded Markdown-like DOCX text that the Core reader can round-trip", () => {
    const input = "# 项目报告\n正文 **加粗** & 处理\n- 一项\n1. 第二项\n> 引用\n<!-- pagebreak -->\n## 后续"
    const first = encodeDocx(input)
    const second = encodeDocx(input)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const documentXml = zipEntryText(first, "word/document.xml")
    expect(documentXml).toContain('<w:br w:type="page"/>')
    expect(documentXml).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
    expect(zipEntryText(encodeDocx("# 目录\n## 章节"), "word/document.xml")).toContain('TOC \\o "1-3"')
    expect(extractOfficeText(first, ".docx")).toEqual({
      ok: true,
      engine: "ooxml",
      text: "项目报告\n正文 加粗 & 处理\n• 一项\n1. 第二项\n引用\n后续",
    })
  })

  test("encodes a deterministic bounded PPTX that the Core reader can round-trip", () => {
    const input = JSON.stringify([
      { title: "季度报告", body: "收入\n成本" },
      { title: "结论", body: "继续推进" },
    ])
    const first = encodePptxJson(input)
    const second = encodePptxJson(input)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const slideXml = zipEntryText(first, "ppt/slides/slide1.xml")
    expect(slideXml).toContain("季度报告")
    expect(extractOfficeText(first, ".pptx")).toEqual({
      ok: true,
      engine: "ooxml",
      text: "季度报告\n收入\n成本\n\n结论\n继续推进",
    })
  })

  test("encodes a deterministic paginated PDF with ASCII and CJK text", () => {
    const input = "# 项目报告\n正文 **已确认** and a long enough line for wrapping.\n<!-- pagebreak -->\n## 后续"
    const first = encodePdf(input)
    const second = encodePdf(input)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const text = Buffer.from(first).toString("latin1")
    expect(text.startsWith("%PDF-1.4\n")).toBe(true)
    expect(text).toContain("/Type /Pages /Count 2")
    expect(text).toContain("/BaseFont /STSong-Light")
    expect(text.endsWith("%%EOF\n")).toBe(true)
  })

  test("rejects invalid sheet names, unsupported cells, and non-finite numbers", () => {
    expect(() => encodeXlsx({ rows: [["x"]], sheetName: "bad/name" })).toThrow(OfficeDocumentWriteError)
    expect(() => encodeXlsx({ rows: [["x"]], sheetName: "bad\uFFFE" })).toThrow(/invalid XML character/)
    expect(() => encodeXlsx({ rows: [[{} as never]] })).toThrow(/unsupported type/)
    expect(() => encodeXlsx({ rows: [[Number.NaN]] })).toThrow(/finite/)
    expect(() => encodeXlsx({ rows: [["bad\u0001text"]] })).toThrow(/invalid XML character/)
    expect(() => encodeDocx("bad\u0001text")).toThrow(/invalid XML character/)
    expect(() => encodePptxJson("not-json")).toThrow(/not valid JSON/)
    expect(() => encodePptxJson("[]")).toThrow(/at least one slide/)
    expect(() => encodePptxJson(JSON.stringify([{ title: 1, body: "x" }]))).toThrow(/title must be a string/)
    expect(() => encodePptxJson(JSON.stringify([{ title: "x", body: "bad\u0001text" }]))).toThrow(
      /invalid XML character/,
    )
    expect(() => encodePdf("bad\u0001text")).toThrow(/control character/)
    expect(() => encodePdf("bad\uD800text")).toThrow(/unpaired surrogate/)
  })

  test("fails closed on row, column, and cell text limits before creating bytes", () => {
    expect(() => encodeXlsx({ rows: Array.from({ length: MAX_XLSX_ROWS + 1 }, () => []) })).toThrow(
      /limited to 2000 rows/,
    )
    expect(() => encodeXlsx({ rows: [Array.from({ length: MAX_XLSX_COLUMNS + 1 }, () => "x")] })).toThrow(
      /exceeds 100 columns/,
    )
    expect(() => encodeXlsx({ rows: [["x".repeat(MAX_XLSX_CELL_CHARS + 1)]] })).toThrow(/32767-character/)
    expect(() => encodeDocx("x".repeat(MAX_DOCX_TEXT_CHARS + 1))).toThrow(/bounded text/)
    expect(() => encodeDocx("\n".repeat(MAX_DOCX_PARAGRAPHS))).toThrow(/limited to 10000 paragraphs/)
    expect(() => encodePptxJson(JSON.stringify([{ title: "x", body: "x".repeat(MAX_PPTX_SLIDE_CHARS + 1) }]))).toThrow(
      /100000-character/,
    )
    expect(() => encodePdf("x".repeat(MAX_PDF_TEXT_CHARS + 1))).toThrow(/bounded text/)
    expect(() => encodePdf("\n".repeat(MAX_PDF_LINES))).toThrow(/limited to 20000 lines/)
  })
})
