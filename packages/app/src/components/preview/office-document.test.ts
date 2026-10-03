import { describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { officeFixture } from "../../../e2e/fixtures/office-documents"
import { officeFormat } from "./office-format"
import { OFFICE_XML_LIMIT, unpackOffice } from "./office-archive"
import { officeColumn, parseOfficeDocument, resolveOfficePart } from "./office-document"

describe("Office format and safe archive boundaries", () => {
  test.each(["docx", "xlsx", "pptx"] as const)("supports %s with case-insensitive paths", (format) => {
    expect(officeFormat("C:\\files\\report." + format.toUpperCase())).toBe(format)
  })
  test.each(["doc", "xls", "ppt", "docm", "xlsm", "pptm"])("does not advertise %s", (format) => {
    expect(officeFormat("report." + format)).toBeUndefined()
  })
  test("uses exact modern MIME types for extensionless files", () => {
    expect(officeFormat("download", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx")
    expect(officeFormat("report.xlsx", "application/vnd.ms-excel.sheet.macroEnabled.12")).toBeUndefined()
  })
  test.each(["https://evil.invalid/a", "//evil.invalid/a", "C:\\secret", "../../secret", "%2e%2e/secret"])("rejects unsafe relationship %s", (target) => {
    expect(resolveOfficePart("word/document.xml", target)).toBeUndefined()
  })
  test("resolves normal package-relative relationships without filesystem access", () => {
    expect(resolveOfficePart("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png")
    expect(resolveOfficePart("", "word/document.xml")).toBe("word/document.xml")
  })
  test("rejects missing and truncated ZIP structures", () => {
    expect(() => unpackOffice(strToU8("not a ZIP"))).toThrow()
    expect(() => unpackOffice(officeFixture("docx").subarray(0, 50))).toThrow()
  })
  test("rejects traversal entry names", () => {
    expect(() => unpackOffice(zipSync({ "../escape.xml": strToU8("<x/>") }))).toThrow("office-invalid-path")
  })
  test("rejects oversized inflated XML", () => {
    expect(() => unpackOffice(officeFixture("docx", { "word/document.xml": "x".repeat(OFFICE_XML_LIMIT + 1) }))).toThrow("office-limit")
  })
})

describe("Office content extraction", () => {
  test("reads Word paragraphs, styles, tables and bounded embedded raster images", () => {
    const model = parseOfficeDocument(unpackOffice(officeFixture("docx")), "docx")
    const blocks = model.pages[0].blocks
    expect(blocks[0]).toMatchObject({ kind: "paragraph", heading: true, runs: [{ text: "Office report", bold: true }] })
    expect(blocks.find((block) => block.kind === "table")).toMatchObject({ rows: [["Revenue", "42"]] })
    expect(blocks.filter((block) => block.kind === "image")).toHaveLength(1)
    expect(model.limited).toBe(true)
    expect(JSON.stringify(model)).toContain('<img src=\\"https://office-blocked.invalid/image\\">')
  })
  test("uses workbook relationships, shared strings, sparse positions and cached formula results", () => {
    const model = parseOfficeDocument(unpackOffice(officeFixture("xlsx")), "xlsx")
    expect(model.pages.map((page) => page.label)).toEqual(["Summary", "Data"])
    expect(model.pages[0].blocks[0]).toMatchObject({ kind: "table", sheet: true, rows: [["Quarter total", "4", ""], ["", "", ""], ["", "", "Third row"]] })
    expect(model.pages[1].blocks[0]).toMatchObject({ rows: [["Data sheet", "7"]] })
    expect(JSON.stringify(model)).not.toContain("WEBSERVICE")
  })
  test("keeps presentation order instead of sorting slide filenames", () => {
    const model = parseOfficeDocument(unpackOffice(officeFixture("pptx")), "pptx")
    expect(model.pages[0].blocks[0]).toMatchObject({ runs: [{ text: "Second stored slide", bold: true }] })
    expect(model.pages[1].blocks[0]).toMatchObject({ runs: [{ text: "First stored slide" }] })
  })
  test("rejects DTDs and custom entities before XML parsing", () => {
    const bytes = officeFixture("docx", { "word/document.xml": '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]><document>&secret;</document>' })
    expect(() => parseOfficeDocument(unpackOffice(bytes), "docx")).toThrow("office-unsafe-xml")
  })
  test("rejects malformed XML and renamed packages", () => {
    expect(() => parseOfficeDocument(unpackOffice(officeFixture("docx", { "word/document.xml": "<broken>" })), "docx")).toThrow()
    expect(() => parseOfficeDocument(unpackOffice(officeFixture("xlsx")), "docx")).toThrow("office-format-mismatch")
  })
  test("rejects macro-enabled package metadata even if renamed to docx", () => {
    const bytes = officeFixture("docx", { "[Content_Types].xml": '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>' })
    expect(() => parseOfficeDocument(unpackOffice(bytes), "docx")).toThrow("office-macro-format")
  })
  test("caps sparse spreadsheets without allocating their declared dimensions", () => {
    const model = parseOfficeDocument(unpackOffice(officeFixture("xlsx", {
      "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row><c r="XFD1048576"><v>9</v></c><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    })), "xlsx")
    expect(model.limited).toBe(true)
    expect(model.pages[0].blocks[0]).toMatchObject({ rows: [["1"]] })
  })
  test("formats column headers beyond Z", () => {
    expect([0, 25, 26, 49].map(officeColumn)).toEqual(["A", "Z", "AA", "AX"])
  })
})
