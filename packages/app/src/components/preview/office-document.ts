import type { OfficeFormat } from "./office-format"
import type { OfficeParts } from "./office-archive"

export type OfficeRun = { text: string; bold?: boolean; italic?: boolean }
export type OfficeBlock =
  | { kind: "paragraph"; runs: OfficeRun[]; heading: boolean }
  | { kind: "table"; rows: string[][]; columns: number; sheet?: boolean }
  | { kind: "image"; source: string }
export type OfficePage = { label: string; blocks: OfficeBlock[] }
export type OfficeDocument = { format: OfficeFormat; pages: OfficePage[]; limited: boolean }

const local = (node: Element | Attr) => node.localName.split(":").at(-1)!
const elements = (node: Document | Element, name: string) => [...node.getElementsByTagName("*")].filter((element) => local(element) === name)
const children = (node: Element, name: string) => [...node.children].filter((element) => local(element) === name)
const attr = (node: Element, name: string) => node.getAttribute(name) ?? [...node.attributes].find((value) => local(value) === name)?.value ?? ""
const text = (node: Element) => elements(node, "t").map((item) => item.textContent ?? "").join("")

export function resolveOfficePart(source: string, target: string): string | undefined {
  if (!target || /[\\:\x00?#%]/.test(target) || target.startsWith("//")) return
  const parts = target.startsWith("/") ? [] : source.split("/").slice(0, -1)
  for (const part of target.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") { if (!parts.length) return; parts.pop() }
    else parts.push(part)
  }
  return parts.join("/")
}

export function officeColumn(index: number): string {
  let label = ""
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + (value - 1) % 26) + label
  return label
}

function rasterSource(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0, height = 0, mime = ""
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20); mime = "image/png"
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); mime = "image/jpeg"; break
      }
      offset += length
    }
  }
  if (!mime || !width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) return
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
  return "data:" + mime + ";base64," + btoa(binary)
}

export function parseOfficeDocument(files: OfficeParts, format: OfficeFormat): OfficeDocument {
  const cache = new Map<string, Document>()
  let limited = false
  let nodeCount = 0
  let characters = 0
  const boundedText = (value: string) => {
    characters += value.length
    if (characters > 1_000_000) throw new Error("office-limit")
    return value
  }
  const xml = (path: string) => {
    const existing = cache.get(path)
    if (existing) return existing
    const bytes = files[path]
    if (!bytes || bytes.length > 2 * 1024 * 1024) throw new Error("office-missing-part")
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error("office-unsafe-xml")
    const document = new DOMParser().parseFromString(value, "application/xml")
    const nodes = document.getElementsByTagName("*")
    nodeCount += nodes.length
    if (nodeCount > 100_000) throw new Error("office-limit")
    if (!document.documentElement || elements(document, "parsererror").length) throw new Error("office-invalid-xml")
    cache.set(path, document)
    return document
  }
  const relationships = (part: string) => {
    const slash = part.lastIndexOf("/")
    const path = part ? part.slice(0, slash + 1) + "_rels/" + part.slice(slash + 1) + ".rels" : "_rels/.rels"
    const result = new Map<string, { path: string; type: string }>()
    if (!files[path]) return result
    for (const relationship of elements(xml(path), "Relationship")) {
      if (attr(relationship, "TargetMode").toLowerCase() === "external") continue
      const target = resolveOfficePart(part, attr(relationship, "Target"))
      if (!target || !files[target]) continue
      result.set(attr(relationship, "Id"), { path: target, type: attr(relationship, "Type") })
    }
    return result
  }
  const types = xml("[Content_Types].xml")
  if (elements(types, "Override").some((item) => /macroenabled/i.test(attr(item, "ContentType")))) throw new Error("office-macro-format")
  const main = [...relationships("").values()].find((item) => item.type.endsWith("/officeDocument"))?.path
  if (!main) throw new Error("office-missing-part")
  const document = xml(main)
  const root = local(document.documentElement)
  if (root !== { docx: "document", xlsx: "workbook", pptx: "presentation" }[format]) throw new Error("office-format-mismatch")
  const pictures = new Map<string, string | undefined>()
  const images = (node: Element, part: string): OfficeBlock[] => {
    const rels = relationships(part)
    return elements(node, "blip").flatMap((blip): OfficeBlock[] => {
      const relationship = rels.get(attr(blip, "embed"))
      if (!relationship?.type.endsWith("/image")) { limited = true; return [] }
      const path = relationship.path
      if (!pictures.has(path)) pictures.set(path, rasterSource(files[path]))
      const source = pictures.get(path)
      if (!source) { limited = true; return [] }
      return [{ kind: "image", source }]
    })
  }
  const paragraph = (node: Element, heading = false): OfficeBlock => {
    const runs = elements(node, "r").map((run): OfficeRun => {
      const value = [...run.getElementsByTagName("*")].map((item) => {
        const name = local(item)
        return name === "t" ? item.textContent ?? "" : name === "tab" ? "\t" : name === "br" ? "\n" : ""
      }).join("")
      const properties = elements(run, "rPr")[0]
      const enabled = (name: string) => {
        const property = properties && children(properties, name)[0]
        const value = property ? attr(property, "val") : properties ? attr(properties, name) : ""
        return !!(property || value) && !["0", "false", "off"].includes(value)
      }
      return { text: boundedText(value), bold: enabled("b"), italic: enabled("i") }
    })
    if (!runs.length) runs.push({ text: boundedText(text(node)) })
    const style = elements(node, "pStyle")[0]
    return { kind: "paragraph", runs, heading: heading || !!(style && /^heading[1-6]$/i.test(attr(style, "val"))) }
  }
  const pages: OfficePage[] = []
  if (format === "docx") {
    const body = elements(document, "body")[0]
    if (!body) throw new Error("office-missing-part")
    const blocks: OfficeBlock[] = []
    const add = (node: Element) => {
      if (blocks.length >= 1000) { limited = true; return }
      const name = local(node)
      if (name === "p") blocks.push(paragraph(node), ...images(node, main))
      else if (name === "tbl") {
        const rows = children(node, "tr")
        if (rows.length > 200) limited = true
        const values = rows.slice(0, 200).map((row) => {
          const cells = children(row, "tc")
          if (cells.length > 50) limited = true
          return cells.slice(0, 50).map((cell) => boundedText(text(cell)))
        })
        blocks.push({ kind: "table", rows: values, columns: Math.max(0, ...values.map((row) => row.length)) })
      } else if (name === "sdt" || name === "sdtContent") [...node.children].forEach(add)
    }
    ;[...body.children].forEach(add)
    pages.push({ label: "Document", blocks })
  } else if (format === "xlsx") {
    const rels = relationships(main)
    const sharedPart = [...rels.values()].find((item) => item.type.endsWith("/sharedStrings"))?.path
    const shared = sharedPart ? elements(xml(sharedPart), "si").map((node) => boundedText(text(node))) : []
    const sheets = elements(document, "sheet")
    if (sheets.length > 50) limited = true
    for (const sheet of sheets.slice(0, 50)) {
      const part = rels.get(attr(sheet, "id"))
      if (!part?.type.endsWith("/worksheet")) { limited = true; continue }
      const rows: string[][] = []
      let columns = 0
      for (const cell of elements(xml(part.path), "c")) {
        const position = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(attr(cell, "r"))
        if (!position) throw new Error("office-invalid-cell")
        const row = Number(position[2])
        const column = [...position[1]].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0)
        if (row > 200 || column > 50) { limited = true; continue }
        const kind = attr(cell, "t")
        const stored = elements(cell, "v")[0]?.textContent ?? ""
        let value = kind === "inlineStr" ? text(cell) : stored
        if (kind === "s") {
          if (!/^[0-9]+$/.test(stored) || shared[Number(stored)] === undefined) throw new Error("office-invalid-cell")
          value = shared[Number(stored)]
        } else if (kind === "b") value = stored === "1" ? "TRUE" : "FALSE"
        const formula = elements(cell, "f")[0]
        if (formula && !stored) value = "=" + (formula.textContent ?? "")
        rows[row - 1] ??= []
        rows[row - 1][column - 1] = boundedText(value)
        columns = Math.max(columns, column)
      }
      const normalized = Array.from({ length: rows.length }, (_, row) =>
        Array.from({ length: columns }, (_, column) => rows[row]?.[column] ?? ""))
      pages.push({ label: attr(sheet, "name"), blocks: [{ kind: "table", rows: normalized, columns, sheet: true }] })
    }
  } else {
    const rels = relationships(main)
    const slides = elements(document, "sldId")
    if (slides.length > 200) limited = true
    for (const slide of slides.slice(0, 200)) {
      const relationshipId = slide.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
        ?? slide.getAttributeNS("http://purl.oclc.org/ooxml/officeDocument/relationships", "id")
        ?? slide.getAttribute("r:id")
      const part = relationshipId ? rels.get(relationshipId) : undefined
      if (!part?.type.endsWith("/slide")) throw new Error("office-missing-part")
      const content = xml(part.path)
      const paragraphs = elements(content, "p")
      if (paragraphs.length > 500) limited = true
      const blocks = paragraphs.slice(0, 500).map((node, index) => paragraph(node, index === 0))
      blocks.push(...images(content.documentElement, part.path))
      pages.push({ label: String(pages.length + 1), blocks })
    }
  }
  if (!pages.length) throw new Error("office-empty-document")
  return { format, pages, limited }
}
