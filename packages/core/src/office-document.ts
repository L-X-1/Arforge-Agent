import { inflateRawSync } from "node:zlib"

export {
  encodeDocx,
  encodePptx,
  encodePptxJson,
  encodeXlsx,
  encodeXlsxJson,
  OfficeDocumentWriteError,
} from "./office-document-writer"
export type { XlsxCell, XlsxInput } from "./office-document-writer"
export { encodePdf, MAX_PDF_BYTES, MAX_PDF_LINES, MAX_PDF_TEXT_CHARS } from "./pdf-document-writer"

/**
 * Small, dependency-free OOXML text reader used by the canonical Core
 * multimodal diagnosis service. Office files are ZIP containers, but the
 * diagnostic path only needs a bounded subset of their XML parts; it must not
 * materialize an arbitrary archive on disk or execute a desktop application.
 */

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const MAX_ENTRIES = 512
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_EXPANDED_BYTES = 80 * 1024 * 1024
const ZIP_EOCD_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 65_535

type ZipEntry = {
  readonly name: string
  readonly method: number
  readonly crc32: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

type ZipArchive = {
  readonly data: Buffer
  readonly entries: ReadonlyMap<string, ZipEntry>
}

export type OfficeExtraction =
  | { readonly ok: true; readonly text: string; readonly engine: "ooxml" }
  | { readonly ok: false; readonly error: string }

/**
 * Extract user-visible text from the supported OOXML containers. The function
 * is intentionally pure and fail-closed so callers can turn parser failures
 * into a structured diagnostic source instead of leaking archive exceptions.
 */
export const extractOfficeText = (bytes: Uint8Array, extension: string): OfficeExtraction => {
  const normalized = extension.toLowerCase()
  if (normalized !== ".docx" && normalized !== ".xlsx" && normalized !== ".pptx") {
    return { ok: false, error: `Unsupported Office format: ${extension || "(none)"}` }
  }

  try {
    const archive = parseZip(bytes)
    const text =
      normalized === ".docx"
        ? extractDocx(archive)
        : normalized === ".xlsx"
          ? extractXlsx(archive)
          : extractPptx(archive)
    if (text.trim().length === 0) {
      return { ok: false, error: `The ${normalized.toUpperCase()} document contained no textual content` }
    }
    return { ok: true, text, engine: "ooxml" }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof OfficeDocumentError ? error.message : "The Office document could not be decoded",
    }
  }
}

class OfficeDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OfficeDocumentError"
  }
}

const parseZip = (bytes: Uint8Array): ZipArchive => {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new OfficeDocumentError(`Office archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`)
  const data = Buffer.from(bytes)
  const eocd = findEocd(data)
  if (eocd < 0) throw new OfficeDocumentError("Office document is not a valid ZIP container")

  const disk = data.readUInt16LE(eocd + 4)
  const centralDirectoryDisk = data.readUInt16LE(eocd + 6)
  const entriesOnDisk = data.readUInt16LE(eocd + 8)
  const entries = data.readUInt16LE(eocd + 10)
  const centralDirectorySize = data.readUInt32LE(eocd + 12)
  const centralDirectoryOffset = data.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entries)
    throw new OfficeDocumentError("Multi-disk Office archives are unsupported")
  if (entries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff)
    throw new OfficeDocumentError("ZIP64 Office archives are unsupported")
  if (entries > MAX_ENTRIES) throw new OfficeDocumentError(`Office archive contains more than ${MAX_ENTRIES} entries`)
  if (centralDirectoryOffset + centralDirectorySize > eocd)
    throw new OfficeDocumentError("Office archive central directory is out of bounds")

  const result = new Map<string, ZipEntry>()
  let offset = centralDirectoryOffset
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new OfficeDocumentError("Office archive has an invalid central-directory entry")
    const flags = data.readUInt16LE(offset + 8)
    const method = data.readUInt16LE(offset + 10)
    const crc32 = data.readUInt32LE(offset + 16)
    const compressedSize = data.readUInt32LE(offset + 20)
    const uncompressedSize = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const localHeaderOffset = data.readUInt32LE(offset + 42)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > data.length || end > centralDirectoryOffset + centralDirectorySize)
      throw new OfficeDocumentError("Office archive central-directory entry is out of bounds")
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8")
    const safeName = validateEntryName(name)
    if (result.has(safeName)) throw new OfficeDocumentError(`Office archive contains duplicate entry: ${safeName}`)
    if (flags & 0x1) throw new OfficeDocumentError(`Encrypted Office entries are unsupported: ${safeName}`)
    if (uncompressedSize > MAX_ENTRY_BYTES)
      throw new OfficeDocumentError(`Office entry exceeds the ${MAX_ENTRY_BYTES}-byte limit: ${safeName}`)
    result.set(safeName, {
      name: safeName,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    offset = end
  }
  if (offset !== centralDirectoryOffset + centralDirectorySize)
    throw new OfficeDocumentError("Office archive central-directory size does not match its entries")

  let expanded = 0
  for (const entry of result.values()) {
    expanded += entry.uncompressedSize
    if (expanded > MAX_EXPANDED_BYTES)
      throw new OfficeDocumentError(`Office archive expands beyond the ${MAX_EXPANDED_BYTES}-byte limit`)
  }
  return { data, entries: result }
}

const readZipEntry = (archive: ZipArchive, name: string): Buffer | undefined => {
  const entry = archive.entries.get(name)
  if (!entry) return undefined
  const offset = entry.localHeaderOffset
  if (offset + 30 > archive.data.length || archive.data.readUInt32LE(offset) !== 0x04034b50)
    throw new OfficeDocumentError(`Office entry has an invalid local header: ${name}`)
  const localFlags = archive.data.readUInt16LE(offset + 6)
  const localMethod = archive.data.readUInt16LE(offset + 8)
  const nameLength = archive.data.readUInt16LE(offset + 26)
  const extraLength = archive.data.readUInt16LE(offset + 28)
  const payloadStart = offset + 30 + nameLength + extraLength
  const payloadEnd = payloadStart + entry.compressedSize
  if (localFlags & 0x1) throw new OfficeDocumentError(`Encrypted Office entries are unsupported: ${name}`)
  if (localMethod !== entry.method || payloadStart > archive.data.length || payloadEnd > archive.data.length)
    throw new OfficeDocumentError(`Office entry payload is out of bounds: ${name}`)
  const localName = archive.data.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
  if (validateEntryName(localName) !== name)
    throw new OfficeDocumentError(`Office entry name changed in local header: ${name}`)
  const payload = archive.data.subarray(payloadStart, payloadEnd)
  let result: Buffer
  try {
    result =
      entry.method === 0
        ? Buffer.from(payload)
        : entry.method === 8
          ? inflateRawSync(payload, { maxOutputLength: MAX_ENTRY_BYTES })
          : (() => {
              throw new OfficeDocumentError(`Unsupported Office compression method ${entry.method}: ${name}`)
            })()
  } catch (error) {
    if (error instanceof OfficeDocumentError) throw error
    throw new OfficeDocumentError(`Office entry could not be decompressed: ${name}`)
  }
  if (result.byteLength !== entry.uncompressedSize)
    throw new OfficeDocumentError(`Office entry size metadata is inconsistent: ${name}`)
  if (crc32(result) !== entry.crc32) throw new OfficeDocumentError(`Office entry integrity check failed: ${name}`)
  return result
}

const extractDocx = (archive: ZipArchive): string => {
  const document = "word/document.xml"
  if (!archive.entries.has(document)) throw new OfficeDocumentError("DOCX is missing word/document.xml")
  const parts = [
    document,
    ...[...archive.entries.keys()]
      .filter((name) => /^word\/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
      .sort(compareOfficeNames),
  ]
  return parts
    .map((name) => extractParagraphs(readXml(archive, name), "p", "t", "tab", "br"))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const extractPptx = (archive: ZipArchive): string => {
  const slides = [...archive.entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort(compareOfficeNames)
  if (slides.length === 0) throw new OfficeDocumentError("PPTX is missing ppt/slides/slideN.xml")
  const notes = [...archive.entries.keys()]
    .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name))
    .sort(compareOfficeNames)
  return [...slides, ...notes]
    .map((name) => extractParagraphs(readXml(archive, name), "p", "t", "tab", "br"))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const extractXlsx = (archive: ZipArchive): string => {
  const sheets = [...archive.entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort(compareOfficeNames)
  if (sheets.length === 0) throw new OfficeDocumentError("XLSX is missing xl/worksheets/sheetN.xml")
  const sharedStrings = archive.entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(readXml(archive, "xl/sharedStrings.xml"))
    : []
  return sheets
    .map((name) => extractSheet(readXml(archive, name), sharedStrings))
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const extractSheet = (xml: string, sharedStrings: ReadonlyArray<string>): string => {
  const rows: string[] = []
  for (const match of xml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?row(?=[\s/>])[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row\s*>/gi,
  )) {
    const values: string[] = []
    for (const cell of match[1].matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?c(?=[\s/>])([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c\s*>)/gi,
    )) {
      const attributes = xmlAttributes(cell[1])
      const body = cell[2] ?? ""
      if (cell[2] === undefined) {
        values.push("")
        continue
      }
      const raw = xmlElementText(body, "v")
      const type = attributes.get("t")
      if (type === "s" && /^\d+$/.test(raw)) values.push(sharedStrings[Number(raw)] ?? raw)
      else if (type === "inlineStr") values.push(xmlText(body, "t"))
      else if (type === "b") values.push(raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw)
      else values.push(raw)
    }
    while (values.at(-1) === "") values.pop()
    if (values.some((value) => value.length > 0)) rows.push(values.join("\t"))
  }
  return rows.join("\n")
}

const parseSharedStrings = (xml: string): string[] => {
  const values: string[] = []
  for (const match of xml.matchAll(
    /<(?:[A-Za-z_][\w.-]*:)?si(?=[\s/>])[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si\s*>/gi,
  ))
    values.push(xmlText(match[1], "t"))
  return values
}

const extractParagraphs = (xml: string, paragraphTag: string, textTag: string, tabTag: string, breakTag: string) => {
  const paragraphs: string[] = []
  const qualified = (tag: string) => `(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tag)}`
  const paragraphPattern = new RegExp(
    `<${qualified(paragraphTag)}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/${qualified(paragraphTag)}\\s*>`,
    "gi",
  )
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(paragraphPattern)) {
    const body = match[1]
      .replace(
        new RegExp(
          `<${qualified(breakTag)}(?=[\\s/>])(?=[^>]*(?:[A-Za-z_][\\w.-]*:)?type\\s*=\\s*["']page["'])[^>]*/>`,
          "gi",
        ),
        "",
      )
      .replace(
        new RegExp(`<${qualified(tabTag)}(?=[\\s/>])[^>]*/>`, "gi"),
        `<${escapeRegExp(textTag)}>${"\t"}</${escapeRegExp(textTag)}>`,
      )
      .replace(
        new RegExp(`<${qualified(breakTag)}(?=[\\s/>])[^>]*/>`, "gi"),
        `<${escapeRegExp(textTag)}>${"\n"}</${escapeRegExp(textTag)}>`,
      )
    const text = xmlText(body, textTag)
    if (text.length > 0) paragraphs.push(text)
  }
  if (paragraphs.length > 0) return paragraphs.join("\n")
  return xmlText(xml, textTag)
}

const readXml = (archive: ZipArchive, name: string): string => {
  const bytes = readZipEntry(archive, name)
  if (!bytes) throw new OfficeDocumentError(`Office entry is missing: ${name}`)
  return bytes.toString("utf8").replace(/^\uFEFF/, "")
}

const xmlText = (xml: string, tag: string): string => {
  const values: string[] = []
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tag)}(?=[\\s/>])(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tag)}\\s*>`,
    "gi",
  )
  for (const match of xml.matchAll(pattern)) values.push(decodeXmlEntities(match[1].replace(/<[^>]+>/g, "")))
  return values.join("")
}

const xmlElementText = (xml: string, tag: string): string => xmlText(xml, tag).trim()

const xmlAttributes = (raw: string): Map<string, string> => {
  const attributes = new Map<string, string>()
  for (const match of raw.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    attributes.set(match[1], decodeXmlEntities(match[2] ?? match[3] ?? ""))
  return attributes
}

const decodeXmlEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized === "amp") return "&"
    if (normalized === "lt") return "<"
    if (normalized === "gt") return ">"
    if (normalized === "quot") return '"'
    if (normalized === "apos") return "'"
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number(normalized.slice(1))
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ""
  })

const validateEntryName = (name: string): string => {
  const normalized = name.replaceAll("\\", "/")
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  )
    throw new OfficeDocumentError("Office archive contains an unsafe entry path")
  return normalized
}

const findEocd = (data: Buffer): number => {
  const start = Math.max(0, data.length - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES)
  for (let offset = data.length - ZIP_EOCD_BYTES; offset >= start; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = data.readUInt16LE(offset + 20)
      if (offset + ZIP_EOCD_BYTES + commentLength <= data.length) return offset
    }
  }
  return -1
}

const compareOfficeNames = (a: string, b: string): number => {
  const aParts = a.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const bParts = b.split(/(\d+)/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index++) {
    const left = aParts[index]
    const right = bParts[index]
    if (left === right) continue
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (typeof left === "number" && typeof right === "number") return left - right
    return String(left).localeCompare(String(right))
  }
  return a.localeCompare(b)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
