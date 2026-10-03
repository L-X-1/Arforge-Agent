import { OfficeDocumentWriteError } from "./office-document-writer"

/**
 * Bounded, deterministic text-PDF encoder used by the canonical Core write
 * tool. It deliberately returns bytes only; LocationMutation, permissions,
 * ActionGateway and FileMutation remain the mutation owners.
 */
export const MAX_PDF_TEXT_CHARS = 400_000
export const MAX_PDF_LINES = 20_000
export const MAX_PDF_BYTES = 25 * 1024 * 1024

type PdfTextRecord = Readonly<{
  readonly kind: "text"
  readonly text: string
  readonly size: number
  readonly leading: number
}>

type PdfPageRecord = Readonly<{ readonly kind: "pagebreak" }>
type PdfRecord = PdfTextRecord | PdfPageRecord

/** Encode bounded Markdown-like text as a deterministic A4-style text PDF. */
export const encodePdf = (content: string): Uint8Array => {
  if (typeof content !== "string" || content.length > MAX_PDF_TEXT_CHARS)
    throw new OfficeDocumentWriteError("PDF content must be a bounded text string")
  validatePdfText(content)
  const sourceLines = content.split(/\r\n?|\n/)
  if (sourceLines.length > MAX_PDF_LINES) throw new OfficeDocumentWriteError(`PDF is limited to ${MAX_PDF_LINES} lines`)

  const records: PdfRecord[] = []
  for (const rawLine of sourceLines) {
    const stripped = rawLine.trim()
    if (stripped === "<!-- pagebreak -->" || stripped === "\\pagebreak" || stripped === "[PAGE BREAK]") {
      records.push({ kind: "pagebreak" })
      continue
    }
    if (
      stripped === "---" ||
      stripped === "***" ||
      stripped === "___" ||
      stripped.startsWith("<!--") ||
      stripped.endsWith("-->") ||
      /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(stripped)
    )
      continue

    const heading = stripped.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    let text: string
    let size: number
    let leading: number
    let limit: number
    if (heading) {
      const level = heading[1].length
      text = cleanPdfInline(heading[2])
      if (
        records.length > 0 &&
        level <= 2 &&
        /^(?:目录|摘要|abstract|第[一二三四五六七八九十\d]+章|[一二三四五六七八九十]+、|参考文献|致谢)/i.test(text)
      )
        records.push({ kind: "pagebreak" })
      size = level === 1 ? 20 : level === 2 ? 16 : 14
      leading = size + 8
      limit = level === 1 ? 48 : 58
    } else {
      text = cleanPdfInline(stripped)
      if (text.startsWith("|") && text.endsWith("|"))
        text =
          "\u3000" +
          text
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
            .join("\u3000") +
          "\u3000"
      text = text.replace(/^\s*[-*+]\s+/, "• ")
      size = 12
      leading = 19
      limit = 82
    }

    if (displayWidth(text) <= limit) records.push({ kind: "text", text, size, leading })
    else for (const part of splitWidth(text, limit)) records.push({ kind: "text", text: part, size, leading })
  }

  const pages = paginate(records)
  const bytes = encodePdfObjects(pages)
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new OfficeDocumentWriteError(`PDF output exceeds the ${MAX_PDF_BYTES}-byte limit`)
  return bytes
}

const validatePdfText = (value: string): void => {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff)
        throw new OfficeDocumentWriteError("PDF content contains an unpaired surrogate")
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)
      throw new OfficeDocumentWriteError("PDF content contains an unpaired surrogate")
    const character = value[index]
    const codePoint = character.codePointAt(0)!
    if (codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd) continue
    if (codePoint < 0x20 || codePoint === 0x7f)
      throw new OfficeDocumentWriteError("PDF content contains an unsupported control character")
  }
}

const cleanPdfInline = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*>[ \t]?/, "")
    .replace(/\t/g, "    ")
    .trim()

const displayWidth = (value: string): number =>
  Array.from(value).reduce((width, character) => width + (isWide(character) ? 2 : 1), 0)

const isWide = (character: string): boolean => {
  const codePoint = character.codePointAt(0)!
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
}

const splitWidth = (value: string, limit: number): string[] => {
  if (!value) return [""]
  const result: string[] = []
  let remaining = value
  while (remaining) {
    let width = 0
    let cut = 0
    let lastSpace = -1
    for (let index = 0; index < remaining.length; ) {
      const codePoint = remaining.codePointAt(index)!
      const character = String.fromCodePoint(codePoint)
      const nextIndex = index + character.length
      width += isWide(character) ? 2 : 1
      if (/\s/u.test(character)) lastSpace = index
      if (width > limit) {
        cut = lastSpace >= Math.max(0, index - 24) ? lastSpace + 1 : index
        break
      }
      index = nextIndex
    }
    if (cut === 0) {
      result.push(remaining.trimEnd())
      break
    }
    cut = Math.max(1, cut)
    result.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  return result.length > 0 ? result : [""]
}

const paginate = (records: ReadonlyArray<PdfRecord>): ReadonlyArray<ReadonlyArray<PdfTextRecord>> => {
  const pages: PdfTextRecord[][] = []
  let current: PdfTextRecord[] = []
  let consumed = 0
  const input: ReadonlyArray<PdfRecord> =
    records.length > 0 ? records : [{ kind: "text", text: "", size: 12, leading: 19 }]
  for (const record of input) {
    if (record.kind === "pagebreak") {
      if (current.length > 0) pages.push(current)
      current = []
      consumed = 0
      continue
    }
    if (current.length > 0 && consumed + record.leading > 700) {
      pages.push(current)
      current = []
      consumed = 0
    }
    current.push(record)
    consumed += record.leading
  }
  if (current.length > 0) pages.push(current)
  return pages.length > 0 ? pages : [[{ kind: "text", text: "", size: 12, leading: 19 }]]
}

const encodePdfObjects = (pages: ReadonlyArray<ReadonlyArray<PdfTextRecord>>): Uint8Array => {
  const objects: Array<Buffer | undefined> = []
  objects[1] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii")
  objects[3] = Buffer.from(
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
    "ascii",
  )
  objects[4] = Buffer.from(
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /DW 1000 /FontDescriptor << /Type /FontDescriptor /Ascent 752 /CapHeight 737 /Descent -271 /Flags 6 /FontBBox [-25 -254 1000 880] /FontName /STSongStd-Light /ItalicAngle 0 /Leading 148 /MaxWidth 1000 /MissingWidth 500 /StemH 91 /StemV 58 /XHeight 553 >> /W [1 [207 270 342 467 462 797 710 239 374] 10 [374 423 605 238 375 238 334 462] 18 26 462 27 28 238 29 31 605 32 [344 748 684 560 695 739 563 511 729 793 318 312 666 526 896 758 772 544 772 628 465 607 753 711 972 647 620 607 374 333 374 606 500 239 417 503 427 529 415 264 444 518 241 230 495 228 793 527 524] 81 [524 504 338 336 277 517 450 652 466 452 407 370 258 370 605]] >>",
    "ascii",
  )
  objects[5] = Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "ascii")

  const pageIds: number[] = []
  for (const [index, page] of pages.entries()) {
    const pageId = 6 + index * 2
    const streamId = pageId + 1
    pageIds.push(pageId)
    const commands: Buffer[] = [Buffer.from("BT 50 790 Td", "ascii")]
    let previousLeading = 0
    for (const [lineIndex, record] of page.entries()) {
      if (lineIndex > 0) commands.push(Buffer.from(`0 -${previousLeading} Td`, "ascii"))
      commands.push(...pdfTextCommands(record.text, record.size))
      previousLeading = record.leading
    }
    commands.push(
      Buffer.from("ET", "ascii"),
      Buffer.from("BT /F2 9 Tf 285 28 Td", "ascii"),
      Buffer.from(`(${index + 1}) Tj`, "ascii"),
      Buffer.from("ET", "ascii"),
    )
    const stream = Buffer.concat(commands.map((command) => Buffer.concat([command, Buffer.from("\n", "ascii")])))
    objects[streamId] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.byteLength} >>\nstream\n`, "ascii"),
      stream,
      Buffer.from("endstream", "ascii"),
    ])
    objects[pageId] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 5 0 R >> >> /Contents ${streamId} 0 R >>`,
      "ascii",
    )
  }
  objects[2] = Buffer.from(
    `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
    "ascii",
  )

  const maximum = objects.length - 1
  const output: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")]
  const offsets = Array.from({ length: maximum + 1 }, () => 0)
  let offset = output[0].byteLength
  for (let objectId = 1; objectId <= maximum; objectId++) {
    const object = objects[objectId]
    if (!object) throw new OfficeDocumentWriteError(`PDF object ${objectId} is missing`)
    offsets[objectId] = offset
    const prefix = Buffer.from(`${objectId} 0 obj\n`, "ascii")
    const suffix = Buffer.from("\nendobj\n", "ascii")
    output.push(prefix, object, suffix)
    offset += prefix.byteLength + object.byteLength + suffix.byteLength
  }
  const xrefOffset = offset
  const xref: string[] = [`xref`, `0 ${maximum + 1}`, "0000000000 65535 f "]
  for (let objectId = 1; objectId <= maximum; objectId++)
    xref.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n `)
  xref.push(`trailer`, `<< /Size ${maximum + 1} /Root 1 0 R >>`, `startxref`, String(xrefOffset), "%%EOF", "")
  output.push(Buffer.from(xref.join("\n"), "ascii"))
  return Buffer.concat(output)
}

const pdfTextCommands = (line: string, size: number): Buffer[] => {
  if (!line) return [Buffer.from(`/F1 ${size} Tf`, "ascii"), Buffer.from("<FEFF> Tj", "ascii")]
  const commands: Buffer[] = []
  let start = 0
  let asciiRun = isAscii(line.codePointAt(0)!)
  for (let index = 0; index <= line.length; ) {
    const nextCodePoint = index < line.length ? line.codePointAt(index)! : undefined
    const nextAscii = nextCodePoint === undefined ? asciiRun : isAscii(nextCodePoint)
    if (nextCodePoint !== undefined && nextAscii === asciiRun) {
      index += String.fromCodePoint(nextCodePoint).length
      continue
    }
    const run = line.slice(start, index)
    if (asciiRun) {
      const escaped = run.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
      commands.push(Buffer.from(`/F2 ${size} Tf`, "ascii"), Buffer.from(`(${escaped}) Tj`, "ascii"))
    } else {
      commands.push(Buffer.from(`/F1 ${size} Tf`, "ascii"), Buffer.from(`<${utf16beHex(run)}> Tj`, "ascii"))
    }
    start = index
    asciiRun = nextAscii
    if (nextCodePoint === undefined) break
  }
  return commands
}

const isAscii = (codePoint: number): boolean => codePoint >= 0x20 && codePoint <= 0x7e

const utf16beHex = (value: string): string => {
  const littleEndian = Buffer.from(`\uFEFF${value}`, "utf16le")
  for (let index = 0; index + 1 < littleEndian.length; index += 2) {
    const first = littleEndian[index]
    littleEndian[index] = littleEndian[index + 1]
    littleEndian[index + 1] = first
  }
  return littleEndian.toString("hex").toUpperCase()
}
