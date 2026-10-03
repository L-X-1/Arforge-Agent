import { officeFormat } from "./office-format"

export type PreviewKind = "text" | "markdown" | "html" | "image" | "audio" | "video" | "pdf" | "office" | "binary"

export type PreviewMetadata = {
  type?: string
  mimeType?: string
  encoding?: string
}

export type PreviewDescriptor = {
  kind: PreviewKind
  renderer: "existing" | "unavailable"
  mode: "source" | "preview" | "unavailable"
  capabilities: { readonly source: boolean; readonly preview: boolean; readonly edit: false }
}

const extensions: Readonly<Record<string, PreviewKind>> = {
  md: "markdown", markdown: "markdown", mdx: "markdown",
  html: "html", htm: "html", xhtml: "html",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", svg: "image", ico: "image",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio", opus: "audio",
  mp4: "video", m4v: "video", webm: "video", ogv: "video",
  pdf: "pdf",
  doc: "office", docx: "office", docm: "office", xls: "office", xlsx: "office", xlsm: "office", ppt: "office", pptx: "office", pptm: "office",
}

function mimeKind(value: string): PreviewKind | undefined {
  const mime = value.split(";", 1)[0].trim().toLowerCase()
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html"
  if (mime === "text/markdown") return "markdown"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (
    mime === "application/msword" ||
    mime.startsWith("application/vnd.openxmlformats-officedocument.") ||
    mime.startsWith("application/vnd.ms-")
  ) return "office"
}

// Routing metadata is not a security or file-signature check. HTML preview is
// opt-in and uses a sanitized, script-disabled sandbox rather than execution.
export function resolvePreview(path: string, content?: PreviewMetadata): PreviewDescriptor {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? ""
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() ?? "" : ""
  const encoded = content?.encoding === "base64"
  const binary = content?.type === "binary" || encoded
  const kind = mimeKind(content?.mimeType ?? "") ?? extensions[extension] ?? (binary ? "binary" : "text")
  const media = kind === "image" || kind === "audio" || kind === "video"
  const document = kind === "pdf" || (kind === "office" && !!officeFormat(path, content?.mimeType))
  const source = !binary && (kind === "text" || kind === "markdown" || kind === "html")
  const markdown = source && kind === "markdown" && extension !== "mdx"
  return {
    kind,
    renderer: source || media || document ? "existing" : "unavailable",
    mode: source ? "source" : media || document ? "preview" : "unavailable",
    capabilities: { source, preview: media || document || markdown || (source && kind === "html"), edit: false },
  }
}

export const previewRegistry = { resolve: resolvePreview } as const
