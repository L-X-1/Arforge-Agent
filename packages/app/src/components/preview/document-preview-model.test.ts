import { describe, expect, test } from "bun:test"
import { decodePdfBytes, decodePreviewBytes, DOCUMENT_PREVIEW_MAX_BYTES, pdfCanvasScale, PDF_MAX_CANVAS_PIXELS, PDF_MAX_CANVAS_SIDE } from "./document-preview-model"

describe("document preview bytes", () => {
  test("preserves binary bytes from base64", () => {
    expect([...decodePdfBytes({ type: "binary", encoding: "base64", content: btoa("%PDF-1.7\n\x00\xff") })])
      .toEqual([...new TextEncoder().encode("%PDF-1.7\n"), 0, 255])
  })
  test("preserves ASCII PDFs classified as text", () => {
    expect(new TextDecoder().decode(decodePdfBytes({ type: "text", content: "%PDF-1.4\n" }))).toBe("%PDF-1.4\n")
  })
  test.each(["", "%not-base64", "YQ", "AA=A", "AA==="])("rejects malformed encoding: %s", (content) => {
    expect(() => decodePreviewBytes({ type: "binary", encoding: "base64", content })).toThrow()
  })
  test("does not reinterpret unknown binary encodings as text", () => {
    expect(() => decodePreviewBytes({ type: "binary", content: "%PDF-1.7" })).toThrow("invalid-document-encoding")
  })
  test("checks the signature rather than trusting an extension or MIME type", () => {
    expect(() => decodePdfBytes({ type: "text", content: "<script>unsafe()</script>" })).toThrow("invalid-pdf-signature")
  })
  test("bounds the encoded input before decoding it", () => {
    expect(() => decodePreviewBytes({ encoding: "base64", content: "A".repeat(Math.ceil(DOCUMENT_PREVIEW_MAX_BYTES / 3) * 4 + 8) }))
      .toThrow("document-too-large")
  })
  test("bounds decoded UTF-8 bytes, not just character count", () => {
    expect(() => decodePreviewBytes({ type: "text", content: "\u4e2d".repeat(Math.ceil(DOCUMENT_PREVIEW_MAX_BYTES / 3)) }))
      .toThrow("document-too-large")
  })
})

describe("PDF render bounds", () => {
  test("keeps ordinary pages sharp on high density displays", () => {
    expect(pdfCanvasScale(612, 792, 1, 3)).toEqual({ scale: 1, outputScale: 2 })
  })
  test.each([[100000, 100000], [10, 1000000], [1000000, 10]])("bounds oversized pages %s x %s", (width, height) => {
    const { scale, outputScale } = pdfCanvasScale(width, height, 3, 2)
    expect(Math.floor(width * scale * outputScale)).toBeLessThanOrEqual(PDF_MAX_CANVAS_SIDE)
    expect(Math.floor(height * scale * outputScale)).toBeLessThanOrEqual(PDF_MAX_CANVAS_SIDE)
    expect(Math.floor(width * scale * outputScale) * Math.floor(height * scale * outputScale)).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS)
  })
  test.each([0, -1, Infinity, NaN])("rejects invalid page dimensions %s", (width) => {
    expect(() => pdfCanvasScale(width, 792, 1, 1)).toThrow("invalid-pdf-dimensions")
  })
})
