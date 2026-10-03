import { createHash } from "node:crypto"
import path from "node:path"
import type { HtmlSelectionEdit } from "@arforge-ai/schema/html-selection-edit"

export class HtmlSelectionEditError extends Error {
  override readonly name = "HtmlSelectionEditError"

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const reject = (code: string, message: string): never => {
  throw new HtmlSelectionEditError(code, message)
}

const identity = (value: string) => {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Validate the captured source before handing the write to FileMutation CAS. */
export function prepareHtmlSelectionEdit(input: {
  readonly directory: string
  readonly path: string
  readonly content: Uint8Array
  readonly guard: HtmlSelectionEdit.Guard
  readonly oldString: string
  readonly newString: string
  readonly replaceAll?: boolean
}) {
  const guard = input.guard
  if (guard.mode !== "file-preview") {
    reject("html_snapshot_unsaved", "Editor snapshots are reference-only. Save the file, reopen its read-only preview, and capture a new selection before editing.")
  }
  if (input.replaceAll) reject("html_snapshot_scope", "A captured HTML selection cannot use replaceAll.")
  if (!guard.path || guard.path.length > 4096 || guard.path.includes("\0") ||
      !guard.directory || guard.directory.length > 8192 || guard.directory.includes("\0") ||
      !path.isAbsolute(guard.directory) || !/\.html?$/i.test(input.path)) {
    reject("html_snapshot_scope", "The HTML snapshot has an invalid file or workspace identity.")
  }
  const root = identity(input.directory)
  const requested = identity(path.resolve(input.directory, input.path))
  const captured = identity(path.resolve(guard.directory, guard.path))
  const relative = path.relative(root, requested)
  if (identity(guard.directory) !== root || requested !== captured || !relative ||
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    reject("html_snapshot_scope", "The captured HTML file does not belong to this edit's file and workspace.")
  }
  if (!/^[a-f0-9]{64}$/.test(guard.revision) || !Number.isSafeInteger(guard.start) ||
      !Number.isSafeInteger(guard.end) || guard.start < 0 || guard.end <= guard.start ||
      guard.end > 500000 || guard.end - guard.start > 8000 || input.newString.length > 8000) {
    reject("html_snapshot_range", "The HTML selection must be a complete, bounded source range. Capture a smaller element instead of using a truncated excerpt.")
  }
  if (input.content.byteLength > 2000003) reject("html_snapshot_encoding", "The HTML source exceeds the preview size limit.")
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.content)
  } catch {
    return reject("html_snapshot_encoding", "The HTML source is not valid UTF-8.")
  }
  if (text.length > 500000 || text.includes("\0")) reject("html_snapshot_encoding", "The HTML source is not a supported preview document.")
  if (createHash("sha256").update(text, "utf8").digest("hex") !== guard.revision) {
    reject("html_snapshot_revision_mismatch", "The HTML source changed after this selection was captured. Refresh the preview and capture a new selection; do not retry without its guard.")
  }
  if (guard.end > text.length || text.slice(guard.start, guard.end) !== input.oldString) {
    reject("html_snapshot_range_mismatch", "oldString must match the entire captured HTML source range exactly, including line endings.")
  }
  const ending = text.includes("\r\n") ? "\r\n" : "\n"
  const replacement = input.newString.replace(/\r\n?|\n/g, ending)
  const after = text.slice(0, guard.start) + replacement + text.slice(guard.end)
  if (after === text) reject("html_snapshot_noop", "The captured HTML edit does not change the source.")
  if (after.length > 500000) reject("html_snapshot_range", "The replacement exceeds the HTML preview size limit.")
  return { after }
}
