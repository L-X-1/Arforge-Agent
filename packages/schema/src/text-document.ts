export * as TextDocument from "./text-document"

import { Schema } from "effect"

export const MAX_TEXT_LENGTH = 500_000
export const MAX_FILE_BYTES = 2_000_000

export const Info = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  version: Schema.String,
  bom: Schema.Boolean,
  lineEnding: Schema.Literals(["lf", "crlf"]),
}).annotate({ identifier: "TextDocument.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const SaveInput = Schema.Struct({
  path: Schema.String,
  baseVersion: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "TextDocument.SaveInput" })
export interface SaveInput extends Schema.Schema.Type<typeof SaveInput> {}

export const isInfo = Schema.is(Info)
