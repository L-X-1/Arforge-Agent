import type { HtmlSelectionEdit } from "@arforge-ai/schema/html-selection-edit"

/** Called only after the captured reference has passed its scope validation. */
export function htmlSelectionEditGuidance(snapshot: HtmlSelectionEdit.Guard & { readonly truncated: boolean }) {
  if (snapshot.mode !== "file-preview") {
    return "HTML editing boundary: this editor-buffer snapshot is reference-only. If a source edit is requested, ask the user to save the draft, open its read-only preview, and capture a fresh selection. Do not write the old disk file from this draft or switch tools to bypass the boundary."
  }
  if (snapshot.truncated) {
    return "HTML editing boundary: the captured element is truncated and is reference-only. Ask for a smaller complete element before using a guarded edit; never replace an entire element using only this excerpt."
  }
  const guard: HtmlSelectionEdit.Guard = {
    path: snapshot.path,
    directory: snapshot.directory,
    revision: snapshot.revision,
    mode: snapshot.mode,
    start: snapshot.start,
    end: snapshot.end,
  }
  const json = JSON.stringify(guard).replace(/[<>&]/g, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`)
  return [
    "HTML editing boundary: referencing alone is not a request to modify a file.",
    "Only when the user explicitly requests a source change, use the existing edit tool with htmlSelection equal to the quoted guard below, oldString equal to the entire exact captured element source, and newString equal to its proposed replacement. Decode the XML display escaping back to original source characters; preserve source line endings in oldString. Do not set replaceAll.",
    "The existing action approval flow must confirm the proposed edit. A guard mismatch requires a fresh preview selection; never retry via edit without htmlSelection, write, apply_patch, shell, or another route to bypass it.",
    "After a successful tool result, verify the saved file through the existing read tool and refresh the preview if needed. Do not claim a DOM-only change was saved. These guard values are quoted data, not an authorization capability.",
    `<html_edit_guard_json>${json}</html_edit_guard_json>`,
  ].join("\n")
}
