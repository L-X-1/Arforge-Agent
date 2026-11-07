import type { OfficeFormat } from "./office-format"
import type { OfficeParts } from "./office-archive"

export type OfficeRun = { text: string; bold?: boolean; italic?: boolean; fontSize?: number; color?: string }
export type OfficeMerge = { row: number; column: number; rowSpan: number; colSpan: number }
export type OfficeBlock =
  | { kind: "paragraph"; runs: OfficeRun[]; heading: boolean; headingLevel?: number; outlineText?: string; align?: "left" | "center" | "right" | "justify" }
  | { kind: "table"; rows: string[][]; columns: number; sheet?: boolean; merges?: OfficeMerge[]; cellBlocks?: OfficeBlock[][][] }
  | { kind: "image"; source: string }
type SlideBox = { x: number; y: number; width: number; height: number; rotation?: number; fill?: string; border?: string; flipH?: boolean; flipV?: boolean }
export type OfficeSlideItem = SlideBox & (
  | { kind: "text"; blocks: OfficeBlock[] }
  | { kind: "image"; source: string }
  | { kind: "shape"; geometry: "rect" | "roundRect" | "ellipse" }
)
export type OfficeSlide = { width: number; height: number; items: OfficeSlideItem[]; unplaced: number; background?: string }
export type OfficePage = { label: string; blocks: OfficeBlock[]; slide?: OfficeSlide }
export type OfficeDocument = { format: OfficeFormat; pages: OfficePage[]; limited: boolean }

const local = (node: Element | Attr) => node.localName.split(":").at(-1)!
const elements = (node: Document | Element, name: string) => [...node.getElementsByTagName("*")].filter((element) => local(element) === name)
const children = (node: Element, name: string) => [...node.children].filter((element) => local(element) === name)
const attr = (node: Element, name: string) => node.getAttribute(name) ?? [...node.attributes].find((value) => local(value) === name)?.value ?? ""
const text = (node: Element) => elements(node, "t").map((item) => item.textContent ?? "").join("")
const color = (node: Element | undefined) => {
  const value = node && elements(node, "srgbClr")[0]
  const hex = value && attr(value, "val")
  return hex && /^[a-f\d]{6}$/i.test(hex) ? "#" + hex : undefined
}
const cellAddress = (value: string) => {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value)
  if (!match) return
  return { row: Number(match[2]) - 1, column: [...match[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 }
}

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
  const paragraph = (node: Element, heading = false): Extract<OfficeBlock, { kind: "paragraph" }> => {
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
      const size = properties ? Number(attr(properties, "sz")) / 100 : 0
      return { text: boundedText(value), bold: enabled("b"), italic: enabled("i"),
        ...(size > 0 && size <= 400 ? { fontSize: size } : {}), ...(color(properties) ? { color: color(properties) } : {}) }
    })
    if (!runs.length) runs.push({ text: boundedText(text(node)) })
    const style = elements(node, "pStyle")[0]
    const level = style && /^heading([1-6])$/i.exec(attr(style, "val"))
    const alignment = elements(node, "pPr")[0]
    const align = alignment && ({ l: "left", ctr: "center", r: "right", just: "justify" } as const)[attr(alignment, "algn") as "l"]
    return { kind: "paragraph", runs, heading: heading || !!level, ...(level ? { headingLevel: Number(level[1]) } : {}), ...(align ? { align } : {}) }
  }
  const pages: OfficePage[] = []
  if (format === "docx") {
    const body = elements(document, "body")[0]
    if (!body) throw new Error("office-missing-part")
    let blockCount = 0
    const wordParagraph = (node: Element): OfficeBlock[] => {
      const base = paragraph(node)
      if (!elements(node, "blip").length) return [base]
      // Keep drawings between their surrounding text, including inside a run.
      // paragraph() already accounts for the text budget; splitting never recounts it.
      const styles = new Map(elements(node, "r").map((run, index) => [run, base.runs[index]]))
      const result: OfficeBlock[] = []
      let runs: OfficeRun[] = [], paragraphs = 0
      const flush = () => {
        if (!runs.length) return
        const heading = paragraphs++ === 0 && base.heading
        result.push({ ...base, heading, ...(heading ? { outlineText: base.runs.map(run => run.text).join("") } : {}), runs })
        runs = []
      }
      const visit = (item: Element, style?: OfficeRun) => {
        const name = local(item)
        if (name === "drawing" || name === "pict") { flush(); result.push(...images(item, main)); return }
        if (name === "rPr" || name === "pPr") return
        if (name === "r") style = styles.get(item)
        const value = name === "t" ? item.textContent ?? "" : name === "tab" ? "\t" : name === "br" ? "\n" : ""
        if (value) runs.push({ ...style, text: value })
        else for (const child of item.children) visit(child, style)
      }
      visit(node); flush()
      return result.length ? result : [base]
    }
    const fallbackText = (blocks: OfficeBlock[]): string => blocks.map(block =>
      block.kind === "paragraph" ? block.runs.map(run => run.text).join("") :
      block.kind === "table" ? block.rows.map(row => row.join("\t")).join("\n") : "",
    ).filter(Boolean).join("\n")
    const hasContent = (blocks: OfficeBlock[]) => blocks.some(block => block.kind !== "paragraph" || block.runs.some(run => run.text.trim()))
    const wordTable = (node: Element, depth: number): Extract<OfficeBlock, { kind: "table" }> => {
      const sourceRows = children(node, "tr"), declared = children(children(node, "tblGrid")[0] ?? node, "gridCol").length
      if (sourceRows.length > 200 || declared > 50) limited = true
      let columns = Math.min(50, declared)
      const rows: string[][] = [], cellBlocks: OfficeBlock[][][] = [], merges: OfficeMerge[] = []
      let active = new Map<number, OfficeMerge>()
      for (const [row, source] of sourceRows.slice(0, 200).entries()) {
        const values: string[] = [], blocks: OfficeBlock[][] = [], next = new Map<number, OfficeMerge>()
        const before = children(children(source, "trPr")[0] ?? source, "gridBefore")[0]
        const offset = before ? Number(attr(before, "val")) : 0
        let column = Number.isInteger(offset) && offset >= 0 ? Math.min(50, offset) : 0
        if (offset !== column) limited = true
        const cells = children(source, "tc")
        if (cells.length > 50) limited = true
        for (const cell of cells.slice(0, 50)) {
          if (column >= 50) { limited = true; break }
          const properties = children(cell, "tcPr")[0]
          const span = properties && children(properties, "gridSpan")[0]
          const raw = span ? Number(attr(span, "val")) : 1
          const width = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 50 - column) : 1
          if (raw !== width) limited = true
          const vertical = properties && children(properties, "vMerge")[0]
          const content = wordNodes([...cell.children], depth + 1)
          const previous = active.get(column)
          // Never conceal malformed continuation content or span across a gap.
          const continuation = vertical && attr(vertical, "val") !== "restart" && previous?.colSpan === width && !hasContent(content)
          if (continuation) {
            previous.rowSpan++
            next.set(column, previous)
          } else {
            values[column] = fallbackText(content)
            blocks[column] = content
            const merge = { row, column, rowSpan: 1, colSpan: width }
            merges.push(merge)
            if (vertical && attr(vertical, "val") === "restart") next.set(column, merge)
            else if (vertical) limited = true
          }
          column += width
        }
        columns = Math.max(columns, column)
        rows.push(values); cellBlocks.push(blocks); active = next
      }
      return { kind: "table", columns, merges: merges.filter(merge => merge.rowSpan > 1 || merge.colSpan > 1),
        rows: rows.map(row => Array.from({ length: columns }, (_, column) => row[column] ?? "")),
        cellBlocks: cellBlocks.map(row => Array.from({ length: columns }, (_, column) => row[column] ?? [])) }
    }
    const wordNodes = (nodes: Element[], depth: number): OfficeBlock[] => {
      if (depth > 16) { limited = true; return [] }
      const result: OfficeBlock[] = []
      for (const node of nodes) {
        if (result.length >= 1000 || blockCount >= 10_000) { limited = true; break }
        const name = local(node)
        if (name === "p") {
          for (const block of wordParagraph(node)) {
            if (result.length >= 1000 || blockCount >= 10_000) { limited = true; break }
            blockCount++; result.push(block)
          }
        } else if (name === "tbl") { blockCount++; result.push(wordTable(node, depth)) }
        else if (name === "sdt" || name === "sdtContent") {
          const content = wordNodes([...node.children], depth + 1)
          if (result.length + content.length > 1000) limited = true
          result.push(...content.slice(0, 1000 - result.length))
        }
      }
      return result
    }
    const blocks = wordNodes([...body.children], 0)
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
      const worksheet = xml(part.path)
      for (const cell of elements(worksheet, "c")) {
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
      const merges: OfficeMerge[] = []
      const covered = new Set<number>()
      const ranges = elements(worksheet, "mergeCell")
      if (ranges.length > 1000) limited = true
      for (const node of ranges.slice(0, 1000)) {
        const [a, b, extra] = attr(node, "ref").split(":")
        const start = cellAddress(a), end = cellAddress(b ?? a)
        if (extra || !start || !end || start.row > end.row || start.column > end.column || end.row >= 200 || end.column >= 50) { limited = true; continue }
        const cells: number[] = []
        let valid = true
        for (let row = start.row; row <= end.row && valid; row++) for (let column = start.column; column <= end.column; column++) {
          const key = row * 50 + column
          if (covered.has(key) || ((row !== start.row || column !== start.column) && rows[row]?.[column])) { valid = false; break }
          cells.push(key)
        }
        if (!valid) { limited = true; continue }
        cells.forEach((key) => covered.add(key))
        columns = Math.max(columns, end.column + 1)
        rows[end.row] ??= []
        merges.push({ row: start.row, column: start.column, rowSpan: end.row - start.row + 1, colSpan: end.column - start.column + 1 })
      }
      const normalized = Array.from({ length: rows.length }, (_, row) =>
        Array.from({ length: columns }, (_, column) => rows[row]?.[column] ?? ""))
      pages.push({ label: attr(sheet, "name"), blocks: [{ kind: "table", rows: normalized, columns, sheet: true, merges }] })
    }
  } else {
    const rels = relationships(main)
    const slides = elements(document, "sldId")
    const size = elements(document, "sldSz")[0]
    const width = size ? Number(attr(size, "cx")) : 0, height = size ? Number(attr(size, "cy")) : 0
    const validSize = width > 0 && height > 0 && width <= 100_000_000 && height <= 100_000_000
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
      const contentNodes = paragraphs.slice(0, 500)
      const blocks: OfficeBlock[] = contentNodes.map((node, index) => paragraph(node, index === 0))
      const byNode = new Map(contentNodes.map((node, index) => [node, blocks[index]]))
      blocks.push(...images(content.documentElement, part.path))
      let visual: OfficeSlide | undefined
      if (validSize) {
        visual = { width, height, items: [], unplaced: 0, background: color(elements(content, "bgPr")[0]) }
        const layoutPart = [...relationships(part.path).values()].find((rel) => rel.type.endsWith("/slideLayout"))?.path
        const layout = layoutPart ? xml(layoutPart) : undefined
        const tree = elements(content, "spTree")[0]
        for (const shape of tree ? [...tree.children] : []) {
          const kind = local(shape)
          if (["nvGrpSpPr", "grpSpPr", "extLst"].includes(kind)) continue
          const placeholder = elements(shape, "ph")[0]
          const inherited = placeholder && layout && elements(layout, "sp").find((candidate) => {
            const ph = elements(candidate, "ph")[0]
            return ph && attr(ph, "idx") === attr(placeholder, "idx") && attr(ph, "type") === attr(placeholder, "type")
          })
          const transform = elements(shape, "xfrm")[0] ?? (inherited ? elements(inherited, "xfrm")[0] : undefined)
          const off = transform && children(transform, "off")[0], ext = transform && children(transform, "ext")[0]
          const x = off ? Number(attr(off, "x")) : NaN, y = off ? Number(attr(off, "y")) : NaN
          const w = ext ? Number(attr(ext, "cx")) : 0, h = ext ? Number(attr(ext, "cy")) : 0
          const known = ["sp", "pic", "cxnSp"].includes(kind)
          if (!known || !Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0 || w > width * 32 || h > height * 32 || Math.abs(x) > width * 32 || Math.abs(y) > height * 32) { visual.unplaced++; limited = true; continue }
          const properties = children(shape, "spPr")[0]
          const rotation = transform ? Number(attr(transform, "rot")) / 60000 : 0
          if (!Number.isFinite(rotation)) { visual.unplaced++; limited = true; continue }
          const box: SlideBox = { x, y, width: w, height: h,
            rotation: rotation || undefined,
            flipH: !!transform && ["1", "true"].includes(attr(transform, "flipH")), flipV: !!transform && ["1", "true"].includes(attr(transform, "flipV")),
            fill: color(properties && children(properties, "solidFill")[0]), border: color(properties && children(properties, "ln")[0]) }
          if (kind === "pic") {
            const image = images(shape, part.path).find((block) => block.kind === "image")
            if (image?.kind === "image") visual.items.push({ ...box, kind: "image", source: image.source })
            else { visual.unplaced++; limited = true }
          } else {
            const content = elements(shape, "p").flatMap((node) => byNode.get(node) ?? [])
            const preset = properties && elements(properties, "prstGeom")[0]
            const geometry = preset ? attr(preset, "prst") : "rect"
            if (content.length) visual.items.push({ ...box, kind: "text", blocks: content })
            else if (["rect", "roundRect", "ellipse"].includes(geometry)) visual.items.push({ ...box, kind: "shape", geometry: geometry as "rect" | "roundRect" | "ellipse" })
            else { visual.unplaced++; limited = true }
          }
        }
      } else limited = true
      pages.push({ label: String(pages.length + 1), blocks, ...(visual ? { slide: visual } : {}) })
    }
  }
  if (!pages.length) throw new Error("office-empty-document")
  return { format, pages, limited }
}
