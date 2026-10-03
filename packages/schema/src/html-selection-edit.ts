export * as HtmlSelectionEdit from "./html-selection-edit"

import { Schema } from "effect"

/** A conditional-edit precondition, not a permission or a trusted capability. */
export const Guard = Schema.Struct({
  path: Schema.String,
  directory: Schema.String,
  revision: Schema.String.annotate({ description: "SHA-256 of the complete BOM-free UTF-8 source, before newline normalization" }),
  mode: Schema.Literals(["file-preview", "editor-buffer"]),
  start: Schema.Int.annotate({ description: "Inclusive UTF-16 source offset of the captured element" }),
  end: Schema.Int.annotate({ description: "Exclusive UTF-16 source offset of the captured element" }),
}).annotate({ identifier: "HtmlSelectionEdit.Guard" })

export interface Guard extends Schema.Schema.Type<typeof Guard> {}
