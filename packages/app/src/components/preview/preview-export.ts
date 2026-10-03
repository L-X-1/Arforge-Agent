import { decodePreviewBytes, type PreviewBytes } from "./document-preview-model"

export function previewDownloadName(path: string) {
  return path.replaceAll("\\", "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "_") || "download"
}

export function previewDownloadBytes(content: PreviewBytes) {
  if (content.type === "text" && !content.encoding && content.content === "") return new Uint8Array(0)
  return decodePreviewBytes(content)
}

// Native opening uses the existing local-server adapter, with an additional
// workspace boundary. Remote previews are still downloadable after authorization.
export function previewLocalPath(directory: string, path: string): string | undefined {
  if (!directory || !path || /[\u0000-\u001f\u007f]/.test(directory + path)) return
  const base = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  const value = path.replaceAll("\\", "/")
  if (value.split("/").some((part) => part === "..") || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return
  const absolute = value.startsWith("/") || /^[a-z]:\//i.test(value)
  const full = absolute ? value : base + "/" + value.replace(/^\.\//, "")
  const normalize = (text: string) => /^[a-z]:/i.test(base) ? text.toLowerCase() : text
  if (!normalize(full).startsWith(normalize(base + "/"))) return
  return full
}
