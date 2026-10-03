export * as MultimodalDiagnosis from "./multimodal-diagnosis"

import { Schema } from "effect"
import { FrontendDiagnosis } from "./frontend-diagnosis"
import { NonNegativeInt, PositiveInt, optional } from "./schema"

export const SignalKind = Schema.Literals([
  "file_line",
  "exception",
  "missing_name",
  "missing_module",
  "missing_import",
  "file_reference",
]).annotate({ identifier: "MultimodalDiagnosis.SignalKind" })
export type SignalKind = typeof SignalKind.Type

export const Signal = Schema.Struct({
  kind: SignalKind,
  value: Schema.String,
  line: PositiveInt.pipe(optional),
  detail: Schema.String.pipe(optional),
  raw: Schema.String,
}).annotate({ identifier: "MultimodalDiagnosis.Signal" })
export interface Signal extends Schema.Schema.Type<typeof Signal> {}

export const Match = Schema.Struct({
  file: Schema.String,
  line: PositiveInt,
  terms: Schema.Array(Schema.String),
  preview: Schema.String,
}).annotate({ identifier: "MultimodalDiagnosis.Match" })
export interface Match extends Schema.Schema.Type<typeof Match> {}

export const ImageMetadata = Schema.Struct({
  bytes: NonNegativeInt,
  width: PositiveInt.pipe(optional),
  height: PositiveInt.pipe(optional),
  format: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "MultimodalDiagnosis.ImageMetadata" })
export interface ImageMetadata extends Schema.Schema.Type<typeof ImageMetadata> {}

export const SourceType = Schema.Literals([
  "provided_text",
  "document",
  "image_ocr",
  "missing",
  "unsupported",
]).annotate({ identifier: "MultimodalDiagnosis.SourceType" })
export type SourceType = typeof SourceType.Type

export const Source = Schema.Struct({
  success: Schema.Boolean,
  type: SourceType,
  path: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
  error: Schema.String.pipe(optional),
  engine: Schema.String.pipe(optional),
  image: ImageMetadata.pipe(optional),
}).annotate({ identifier: "MultimodalDiagnosis.Source" })
export interface Source extends Schema.Schema.Type<typeof Source> {}

export const Summary = Schema.Struct({
  textChars: NonNegativeInt,
  signals: NonNegativeInt,
  searchTerms: NonNegativeInt,
  matches: NonNegativeInt,
}).annotate({ identifier: "MultimodalDiagnosis.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const Result = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  localOnly: Schema.Literal(true),
  modelCalls: Schema.Literal(0),
  /** `error` is the historical default; frontend and javascript fuse the
   * former Python validators into this same deterministic read-only tool. */
  mode: Schema.Literals(["error", "frontend", "javascript"]),
  success: Schema.Boolean,
  path: Schema.String,
  source: Source,
  signals: Schema.Array(Signal),
  searchTerms: Schema.Array(Schema.String),
  matches: Schema.Array(Match),
  suggestions: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  summary: Summary,
  frontend: FrontendDiagnosis.Report.pipe(optional),
}).annotate({ identifier: "MultimodalDiagnosis.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}
