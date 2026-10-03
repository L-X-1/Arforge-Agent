export const DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
export const PDF_MAX_CANVAS_PIXELS = 16_000_000
export const PDF_MAX_CANVAS_SIDE = 8192

export type PreviewBytes = { content: string; encoding?: string; type?: string }

export function decodePreviewBytes(input: PreviewBytes): Uint8Array<ArrayBuffer> {
  if (input.content.length > Math.ceil(DOCUMENT_PREVIEW_MAX_BYTES / 3) * 4 + 4) {
    throw new Error("document-too-large")
  }
  let bytes: Uint8Array<ArrayBuffer>
  if (input.encoding === "base64") {
    const encoded = input.content.replace(/\s/g, "")
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error("invalid-document-encoding")
    }
    const raw = atob(encoded)
    bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0))
  } else if (input.type === "text" && (!input.encoding || input.encoding === "utf8")) {
    // The file API can classify an ASCII-only PDF as text. Preserve its bytes.
    bytes = new TextEncoder().encode(input.content)
  } else {
    throw new Error("invalid-document-encoding")
  }
  if (bytes.byteLength > DOCUMENT_PREVIEW_MAX_BYTES) throw new Error("document-too-large")
  if (!bytes.byteLength) throw new Error("empty-document")
  return bytes
}

export function decodePdfBytes(input: PreviewBytes) {
  const bytes = decodePreviewBytes(input)
  if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new Error("invalid-pdf-signature")
  }
  return bytes
}

export function pdfCanvasScale(width: number, height: number, requestedScale: number, devicePixelRatio: number) {
  if (![width, height, requestedScale, devicePixelRatio].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("invalid-pdf-dimensions")
  }
  const scale = Math.min(requestedScale, PDF_MAX_CANVAS_SIDE / width, PDF_MAX_CANVAS_SIDE / height,
    Math.sqrt(PDF_MAX_CANVAS_PIXELS / (width * height)))
  const outputScale = Math.min(Math.max(1, devicePixelRatio), 2,
    PDF_MAX_CANVAS_SIDE / (width * scale), PDF_MAX_CANVAS_SIDE / (height * scale),
    Math.sqrt(PDF_MAX_CANVAS_PIXELS / (width * height * scale * scale)))
  return { scale, outputScale }
}
