import { describe, expect, test } from "bun:test"
import { officeFixture, officeFixtureParts } from "../../../e2e/fixtures/office-documents"
import { unpackOffice } from "./office-archive"
import { parseOfficeDocument, type OfficeBlock } from "./office-document"

const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (content: string, properties = "") => `<w:tc><w:tcPr>${properties}</w:tcPr>${content}</w:tc>`
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`
const table = (...rows: string[]) => `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>${rows.join("")}</w:tbl>`
const picture = '<w:r><w:drawing><a:blip r:embed="picture"/></w:drawing></w:r>'
function document(body: string) {
  const parts = officeFixtureParts("docx")
  parts["word/document.xml"] = String(parts["word/document.xml"]).replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`)
  return parseOfficeDocument(unpackOffice(officeFixture("docx", parts)), "docx")
}
const asTable = (block: OfficeBlock) => {
  if (block.kind !== "table") throw new Error("Expected a real table block")
  return block
}
const blockText = (block: OfficeBlock) => block.kind === "paragraph" ? block.runs.map(run => run.text).join("") : ""

describe("DOCX merged and nested table content", () => {
  test("keeps horizontal/vertical grid positions, nested blocks and text fallback without flattening the render tree", () => {
    const nested = table(row(cell(p("Nested one")), cell(p("Nested two"))))
    const content = p("Before picture") + `<w:p>${picture}</w:p>` + p("Before nested") + nested + p("After nested")
    const model = document(table(
      row(cell(p("Wide heading"), '<w:gridSpan w:val="2"/>'), cell(p("Right"))),
      row(cell(p("Tall cell"), '<w:vMerge w:val="restart"/>'), cell(content), cell(p("Top right"))),
      row(cell(p(""), "<w:vMerge/>"), cell(p("Bottom middle")), cell(p("Bottom right"))),
    ))
    const grid = asTable(model.pages[0].blocks[0])
    expect(grid.columns).toBe(3)
    expect(grid.merges).toEqual([
      { row: 0, column: 0, rowSpan: 1, colSpan: 2 },
      { row: 1, column: 0, rowSpan: 2, colSpan: 1 },
    ])
    expect(grid.rows[0]).toEqual(["Wide heading", "", "Right"])
    expect(grid.rows[2]).toEqual(["", "Bottom middle", "Bottom right"])
    const blocks = grid.cellBlocks![1][1]
    expect(blocks.map(block => block.kind)).toEqual(["paragraph", "image", "paragraph", "table", "paragraph"])
    expect(blockText(blocks[0])).toBe("Before picture")
    expect(asTable(blocks[3]).cellBlocks![0].map(cell => cell.map(blockText).join(""))).toEqual(["Nested one", "Nested two", ""])
    expect(blockText(blocks[4])).toBe("After nested")
    expect(grid.rows[1][1]).toContain("Nested one")
    expect(grid.cellBlocks![2][0]).toEqual([])
    expect(model.limited).toBe(false)
  })

  test("keeps text and an inline image in their original order", () => {
    const blocks = document(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Before inline</w:t><w:drawing><a:blip r:embed="picture"/></w:drawing><w:t>After inline</w:t></w:r></w:p>`).pages[0].blocks
    expect(blocks.map(block => block.kind)).toEqual(["paragraph", "image", "paragraph"])
    expect(blocks[0]).toMatchObject({ runs: [{ text: "Before inline", bold: true }] })
    expect(blocks[2]).toMatchObject({ runs: [{ text: "After inline", bold: true }] })
    const heading = document('<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Before inline</w:t><w:drawing><a:blip r:embed="picture"/></w:drawing><w:t>After inline</w:t></w:r></w:p>').pages[0].blocks
    expect(heading[0]).toMatchObject({ heading: true, outlineText: "Before inlineAfter inline" })
    expect(heading[2]).toMatchObject({ heading: false })
  })

  test("continues a combined row/column merge only across matching empty continuation cells", () => {
    const grid = asTable(document(table(
      row(cell(p("Combined"), '<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>'), cell(p("R1"))),
      row(cell(p(""), '<w:gridSpan w:val="2"/><w:vMerge/>'), cell(p("R2"))),
      row(cell(p("Orphan content"), '<w:vMerge/>'), cell(p("B3")), cell(p("C3"))),
    )).pages[0].blocks[0])
    expect(grid.merges).toEqual([{ row: 0, column: 0, rowSpan: 2, colSpan: 2 }])
    expect(grid.rows[2][0]).toBe("Orphan content")
    expect(grid.cellBlocks![2][0].map(blockText)).toEqual(["Orphan content"])
  })

  test("never hides unexpected continuation content or joins a stopped vertical merge", () => {
    const grid = asTable(document(table(
      row(cell(p("First"), '<w:vMerge w:val="restart"/>')),
      row(cell(p("Must remain visible"), '<w:vMerge/>')),
      row(cell(p("Last"), '<w:vMerge/>')),
    )).pages[0].blocks[0])
    expect(grid.merges).toEqual([])
    expect(grid.rows.map(row => row[0])).toEqual(["First", "Must remain visible", "Last"])
  })

  test("bounds excessive grid declarations and nested tables while disclosing omissions", () => {
    const huge = document(table(row(cell(p("Bounded"), '<w:gridSpan w:val="999999"/>'))))
    expect(huge.limited).toBe(true)
    expect(asTable(huge.pages[0].blocks[0]).columns).toBeLessThanOrEqual(50)
    let nested = p("Leaf")
    for (let i = 0; i < 40; i++) nested = table(row(cell(nested)))
    expect(document(nested).limited).toBe(true)
  })
})
