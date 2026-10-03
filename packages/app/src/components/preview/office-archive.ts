import { Unzip, UnzipInflate } from "fflate"
import { DOCUMENT_PREVIEW_MAX_BYTES } from "./document-preview-model"

export type OfficeParts = Record<string, Uint8Array>
export const OFFICE_XML_LIMIT = 2 * 1024 * 1024
const totalLimit = 32 * 1024 * 1024

export function unpackOffice(bytes: Uint8Array): OfficeParts {
  if (bytes.length > DOCUMENT_PREVIEW_MAX_BYTES) throw new Error("office-limit")
  if (bytes.length < 22 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x04034b50) {
    throw new Error("office-invalid-archive")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset
      break
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("office-invalid-archive")
  const entries = view.getUint16(end + 10, true)
  if (!entries || entries > 1000 || view.getUint16(end + 8, true) !== entries ||
    view.getUint32(end + 16, true) + view.getUint32(end + 12, true) !== end) throw new Error("office-limit")
  const files: OfficeParts = Object.create(null)
  const names = new Set<string>()
  let total = 0
  let pending = 0
  const unzip = new Unzip((file) => {
    if (names.has(file.name) || file.name.startsWith("/") || /[\\:\x00]/.test(file.name) ||
      file.name.split("/").some((part) => part === "." || part === "..")) throw new Error("office-invalid-path")
    names.add(file.name)
    if (names.size > 1000) throw new Error("office-limit")
    if (!/\.(xml|rels|png|jpe?g)$/i.test(file.name)) return
    const limit = /\.(xml|rels)$/i.test(file.name) ? OFFICE_XML_LIMIT : 4 * 1024 * 1024
    if (file.originalSize !== undefined && file.originalSize > limit) throw new Error("office-limit")
    let size = 0
    const chunks: Uint8Array[] = []
    pending++
    file.ondata = (error, data, final) => {
      if (error) throw error
      size += data.length
      total += data.length
      if (size > limit || total > totalLimit) throw new Error("office-limit")
      chunks.push(data.slice())
      if (!final) return
      const content = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
      files[file.name] = content
      pending--
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  // Bound each inflate input chunk as well as the declared and actual output.
  // The caller runs this synchronous loop in a disposable, time-limited Worker.
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length)
  }
  if (pending || names.size !== entries || !files["[Content_Types].xml"] || !files["_rels/.rels"]) {
    throw new Error("office-invalid-archive")
  }
  return files
}
