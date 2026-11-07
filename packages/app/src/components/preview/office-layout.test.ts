import { describe, expect, test } from "bun:test"
import { officeFixture } from "../../../e2e/fixtures/office-documents"
import { unpackOffice } from "./office-archive"
import { parseOfficeDocument } from "./office-document"

const word = (body: string) => officeFixture("docx", {
  "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
})
const sheet = (merges: string) => officeFixture("xlsx", {
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Heading</t></is></c></row><row><c r="C4"><v>42</v></c></row></sheetData><mergeCells>${merges}</mergeCells></worksheet>`,
})
export function positionedSlides() {
  return officeFixture("pptx", {
    "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="1" r:id="second"/><p:sldId id="2" r:id="first"/></p:sldIdLst></p:presentation>',
    "ppt/slides/slide2.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="914400" y="685800"/><a:ext cx="4572000" cy="1371600"/></a:xfrm><a:solidFill><a:srgbClr val="ECEFF3"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr sz="2400" b="1"/><a:t>Positioned real title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  })
}
describe("Office layout metadata from real OOXML archives", () => {
  test("preserves heading levels for a real Word outline, independently of bold text", () => {
    const model = parseOfficeDocument(unpackOffice(word('<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section two</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Plain bold</w:t></w:r></w:p>')), "docx")
    expect(model.pages[0].blocks[0]).toMatchObject({ heading: true, headingLevel: 2 })
    expect(model.pages[0].blocks[1]).toMatchObject({ heading: false })
  })
  test("retains genuine XLSX merge ranges without moving cached values", () => {
    const model = parseOfficeDocument(unpackOffice(sheet('<mergeCell ref="A1:B2"/>')), "xlsx")
    expect(model.pages[0].blocks[0]).toMatchObject({ merges: [{ row: 0, column: 0, rowSpan: 2, colSpan: 2 }] })
    expect(model.pages[0].blocks[0]).toMatchObject({ rows: [["Heading", "", ""], ["", "", ""], ["", "", ""], ["", "", "42"]] })
  })
  test("marks overlapping/out-of-limit merge geometry as limited without huge allocations", () => {
    const model = parseOfficeDocument(unpackOffice(sheet('<mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/><mergeCell ref="A1:XFD1048576"/>')), "xlsx")
    expect(model.limited).toBe(true)
    expect(model.pages[0].blocks[0]).toMatchObject({ merges: [{ row: 0, column: 0, rowSpan: 2, colSpan: 2 }] })
  })
  test("reads the real 4:3 slide dimensions and text box position instead of assuming 16:9", () => {
    const model = parseOfficeDocument(unpackOffice(positionedSlides()), "pptx")
    expect(model.pages[0].slide).toMatchObject({ width: 9144000, height: 6858000 })
    expect(model.pages[0].slide?.items[0]).toMatchObject({ kind: "text", x: 914400, y: 685800, width: 4572000, height: 1371600 })
    expect(JSON.stringify(model.pages[0].slide)).toContain("Positioned real title")
  })
  test("does not advertise a positioned slide when the package has no page geometry", () => {
    const model = parseOfficeDocument(unpackOffice(officeFixture("pptx")), "pptx")
    expect(model.pages[0].slide).toBeUndefined()
    expect(model.pages[0].blocks[0]).toMatchObject({ runs: [{ text: "Second stored slide" }] })
    expect(model.limited).toBe(true)
  })
  test("does not pass non-finite OOXML rotations to the visible slide scene", () => {
    const parts = unpackOffice(positionedSlides())
    const source = new TextDecoder().decode(parts["ppt/slides/slide2.xml"])
    parts["ppt/slides/slide2.xml"] = new TextEncoder().encode(source.replace("<a:xfrm>", '<a:xfrm rot="Infinity">'))
    const model = parseOfficeDocument(parts, "pptx")
    expect(model.limited).toBe(true)
    expect(model.pages[0].slide?.unplaced).toBe(1)
    expect(model.pages[0].slide?.items).toHaveLength(0)
    expect(JSON.stringify(model.pages[0].blocks)).toContain("Positioned real title")
  })
})
