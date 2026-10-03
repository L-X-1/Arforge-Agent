export const HTML_PREVIEW_MAX_CHARACTERS = 500_000
export const HTML_PREVIEW_DEBOUNCE_MS = 200

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

export const isHtmlDocument = (path: string) => /\.(?:html?|xhtml)$/i.test(path)
export const htmlPreviewFits = (text: string) => text.length <= HTML_PREVIEW_MAX_CHARACTERS

export const isEmbeddedRasterImage = (value: string) =>
  /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i.test(value)

export const escapePreviewText = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!)
