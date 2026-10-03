export * as PrimaryDelivery from "./primary-delivery"

import { Schema } from "effect"
import { AgentRuntime } from "./agent-runtime"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"

export const Status = Schema.Literals(["normal", "proactive"])
export type Status = typeof Status.Type

export const Artifact = Schema.Struct({
  artifactID: Schema.String,
  /** Storage-safe receipt; `path` remains a local-only compatibility projection. */
  artifactRef: Schema.suspend(() => AgentRuntime.OpaqueArtifactRef).pipe(optional),
  path: Schema.String,
  displayName: Schema.String,
  mime: Schema.String,
  sizeBytes: NonNegativeInt,
  createdAt: DateTimeUtcFromMillis,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  source: Schema.Literal("user_message"),
  isImage: Schema.Boolean,
}).annotate({ identifier: "PrimaryDelivery.Artifact" })
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export const Metadata = Schema.Struct({
  status: Status,
  sentAt: DateTimeUtcFromMillis,
  attachmentCount: NonNegativeInt,
  attachments: Schema.Array(Artifact).check(Schema.isMaxLength(8)),
  localOnly: Schema.Literal(true),
  uploaded: Schema.Literal(false),
}).annotate({ identifier: "PrimaryDelivery.Metadata" })
export interface Metadata extends Schema.Schema.Type<typeof Metadata> {}
