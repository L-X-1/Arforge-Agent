import { strToU8, zipSync } from "fflate"
import type { OfficeFormat } from "../../src/components/preview/office-format"

const relationshipNS = "http://schemas.openxmlformats.org/package/2006/relationships"
const officeNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const wordNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const drawNS = "http://schemas.openxmlformats.org/drawingml/2006/main"
const sheetNS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const presentationNS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const rels = (items: string) => '<Relationships xmlns="' + relationshipNS + '">' + items + "</Relationships>"
const rel = (id: string, type: string, target: string, external = false) =>
  '<Relationship Id="' + id + '" Type="' + officeNS + "/" + type + '" Target="' + target + '"' + (external ? ' TargetMode="External"' : "") + "/>"

export function officeFixtureParts(format: OfficeFormat): Record<string, string | Uint8Array> {
  const main = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[format]
  const parts: Record<string, string | Uint8Array> = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    "_rels/.rels": rels(rel("main", "officeDocument", main)),
  }
  if (format === "docx") {
    parts[main] = '<w:document xmlns:w="' + wordNS + '" xmlns:a="' + drawNS + '" xmlns:r="' + officeNS + '"><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Office report</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>&lt;img src="https://office-blocked.invalid/image"&gt;</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:drawing><a:blip r:embed="picture"/></w:drawing></w:r></w:p>' +
      '<w:p><w:r><w:drawing><a:blip r:link="external"/></w:drawing></w:r></w:p>' +
      "</w:body></w:document>"
    parts["word/_rels/document.xml.rels"] = rels(rel("picture", "image", "media/pixel.png") + rel("external", "image", "https://office-blocked.invalid/external.png", true))
    parts["word/media/pixel.png"] = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII="), (char) => char.charCodeAt(0))
  } else if (format === "xlsx") {
    parts[main] = '<workbook xmlns="' + sheetNS + '" xmlns:r="' + officeNS + '"><sheets><sheet name="Summary" sheetId="2" r:id="summary"/><sheet name="Data" sheetId="1" r:id="data"/></sheets></workbook>'
    parts["xl/_rels/workbook.xml.rels"] = rels(rel("summary", "worksheet", "worksheets/sheet2.xml") + rel("data", "worksheet", "worksheets/sheet1.xml") + rel("strings", "sharedStrings", "sharedStrings.xml"))
    parts["xl/sharedStrings.xml"] = '<sst xmlns="' + sheetNS + '"><si><t>Quarter total</t></si></sst>'
    parts["xl/worksheets/sheet2.xml"] = '<worksheet xmlns="' + sheetNS + '"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>2+2</f><v>4</v></c></row><row r="3"><c r="C3" t="inlineStr"><is><t>Third row</t></is></c></row></sheetData></worksheet>'
    parts["xl/worksheets/sheet1.xml"] = '<worksheet xmlns="' + sheetNS + '"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Data sheet</t></is></c><c r="B1"><f>WEBSERVICE("https://office-blocked.invalid/formula")</f><v>7</v></c></row></sheetData></worksheet>'
  } else {
    parts[main] = '<p:presentation xmlns:p="' + presentationNS + '" xmlns:r="' + officeNS + '"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>'
    parts["ppt/_rels/presentation.xml.rels"] = rels(rel("first", "slide", "slides/slide1.xml") + rel("second", "slide", "slides/slide2.xml"))
    const slide = (title: string) => '<p:sld xmlns:p="' + presentationNS + '" xmlns:a="' + drawNS + '"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr b="1"/><a:t>' + title + '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    parts["ppt/slides/slide1.xml"] = slide("First stored slide")
    parts["ppt/slides/slide2.xml"] = slide("Second stored slide")
  }
  return parts
}

export function officeFixture(format: OfficeFormat, overrides: Record<string, string | Uint8Array> = {}) {
  const parts = { ...officeFixtureParts(format), ...overrides }
  return zipSync(Object.fromEntries(Object.entries(parts).map(([path, value]) => [path, typeof value === "string" ? strToU8(value) : value])))
}
