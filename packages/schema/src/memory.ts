export * as Memory from "./memory"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("mem_")).pipe(
  Schema.brand("MemoryID"),
  statics((schema) => ({
    create: () => schema.make("mem_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const Content = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_000)).annotate(
  { identifier: "MemoryContent" },
)
export type Content = typeof Content.Type

export const Type = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(50)).annotate({
  identifier: "MemoryType",
})
export type Type = typeof Type.Type

export const Tag = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)).annotate({
  identifier: "MemoryTag",
})
export type Tag = typeof Tag.Type

export const Tags = Schema.Array(Tag).check(Schema.isMaxLength(32)).annotate({ identifier: "MemoryTags" })
export type Tags = typeof Tags.Type

export const Importance = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).annotate({
  identifier: "MemoryImportance",
})
export type Importance = typeof Importance.Type

export const Strength = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
  identifier: "MemoryStrength",
})
export type Strength = typeof Strength.Type

export const ReviewLevel = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).annotate({
  identifier: "MemoryReviewLevel",
})
export type ReviewLevel = typeof ReviewLevel.Type

export const Source = Schema.Literals([
  "user",
  "user-corrected",
  "imported",
  "auto",
  "model",
  "quarantined",
  "quarantined:auto",
  "quarantined:model",
]).annotate({ identifier: "MemorySource" })
export type Source = typeof Source.Type

export const Scope = Schema.Literals(["workspace", "global"]).annotate({ identifier: "MemoryScope" })
export type Scope = typeof Scope.Type

export const Info = Schema.Struct({
  id: ID,
  version: NonNegativeInt,
  content: Content,
  type: Type,
  tags: Tags,
  importance: Importance,
  source: Source,
  scope: Scope,
  projectID: Schema.NonEmptyString.pipe(optional),
  workspacePath: Schema.NonEmptyString.pipe(optional),
  relatedTo: ID.pipe(optional),
  strength: Strength,
  reviewLevel: ReviewLevel,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    reviewed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Memory.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Page = Schema.Struct({
  items: Schema.Array(Info),
  count: NonNegativeInt,
  total: NonNegativeInt,
}).annotate({ identifier: "Memory.Page" })
export interface Page extends Schema.Schema.Type<typeof Page> {}

export const SemanticHit = Schema.Struct({
  memory: Info,
  score: Schema.Finite,
  lexicalScore: Schema.Finite,
  vectorScore: Schema.Finite,
  matchedTerms: Schema.Array(Schema.String),
}).annotate({ identifier: "Memory.SemanticHit" })
export interface SemanticHit extends Schema.Schema.Type<typeof SemanticHit> {}

export const SemanticResults = Schema.Struct({
  algorithm: Schema.Literals(["hybrid_bm25_embedding_api", "hybrid_bm25_hashing_vector"]),
  /** False when a remote embedding transport was sent or may have run. */
  localOnly: Schema.Boolean,
  /** Transport fact used by clients to explain local fallback or remote use. */
  embeddingEgress: Schema.Literals(["none", "denied", "sent", "unknown"]),
  embeddingFallback: Schema.Literals(["remote-not-authorized", "remote-failed"]).pipe(optional),
  items: Schema.Array(SemanticHit),
  count: NonNegativeInt,
}).annotate({ identifier: "Memory.SemanticResults" })
export interface SemanticResults extends Schema.Schema.Type<typeof SemanticResults> {}

export const FacetValue = Schema.Struct({
  value: Schema.String,
  count: NonNegativeInt,
}).annotate({ identifier: "Memory.FacetValue" })

export const Facets = Schema.Struct({
  projects: Schema.Array(FacetValue),
  workspaces: Schema.Array(FacetValue),
  types: Schema.Array(FacetValue),
  sources: Schema.Array(FacetValue),
  tags: Schema.Array(FacetValue),
}).annotate({ identifier: "Memory.Facets" })
export interface Facets extends Schema.Schema.Type<typeof Facets> {}

export const Status = Schema.Struct({
  total: NonNegativeInt,
  important: NonNegativeInt,
  workspace: NonNegativeInt,
  global: NonNegativeInt,
  quarantined: NonNegativeInt,
  pendingConflicts: NonNegativeInt,
  recent: Schema.Array(Info),
}).annotate({ identifier: "Memory.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const RecallExample = Schema.Struct({
  memoryID: ID,
  query: Schema.String,
  rank: NonNegativeInt,
  reciprocalRank: Schema.Finite,
}).annotate({ identifier: "Memory.RecallExample" })

export const RecallQuality = Schema.Struct({
  status: Schema.Literal("operational_baseline"),
  sampleSize: NonNegativeInt,
  top1Rate: Schema.Finite,
  meanReciprocalRank: Schema.Finite,
  noResultRate: Schema.Finite,
  examples: Schema.Array(RecallExample),
  caveat: Schema.String,
}).annotate({ identifier: "Memory.RecallQuality" })
export interface RecallQuality extends Schema.Schema.Type<typeof RecallQuality> {}

export const DeleteResult = Schema.Struct({
  deleted: Schema.Array(ID),
  notFound: Schema.Array(ID),
}).annotate({ identifier: "Memory.DeleteResult" })
export interface DeleteResult extends Schema.Schema.Type<typeof DeleteResult> {}

export const CorrectionID = Schema.String.check(Schema.isStartsWith("mcor_")).pipe(
  Schema.brand("MemoryCorrectionID"),
  statics((schema) => ({
    create: () => schema.make("mcor_" + ascending()),
  })),
)
export type CorrectionID = typeof CorrectionID.Type

export const CorrectionReason = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
).annotate({ identifier: "MemoryCorrectionReason" })
export type CorrectionReason = typeof CorrectionReason.Type

export const CorrectionStatus = Schema.Literals(["active", "undone"]).annotate({
  identifier: "MemoryCorrectionStatus",
})
export type CorrectionStatus = typeof CorrectionStatus.Type

export const CorrectionInfo = Schema.Struct({
  id: CorrectionID,
  originalMemoryID: ID,
  successorMemoryID: ID,
  originalSource: Source,
  reason: CorrectionReason,
  status: CorrectionStatus,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    undone: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Memory.CorrectionInfo" })
export interface CorrectionInfo extends Schema.Schema.Type<typeof CorrectionInfo> {}

export const CorrectionResult = Schema.Struct({
  correction: CorrectionInfo,
  original: Info,
  successor: Info,
}).annotate({ identifier: "Memory.CorrectionResult" })
export interface CorrectionResult extends Schema.Schema.Type<typeof CorrectionResult> {}

export const CorrectionHistory = Schema.Struct({
  items: Schema.Array(CorrectionInfo),
  count: NonNegativeInt,
}).annotate({ identifier: "Memory.CorrectionHistory" })
export interface CorrectionHistory extends Schema.Schema.Type<typeof CorrectionHistory> {}

export const ConflictID = Schema.String.check(Schema.isStartsWith("mcf_")).pipe(
  Schema.brand("MemoryConflictID"),
  statics((schema) => ({
    create: () => schema.make("mcf_" + ascending()),
  })),
)
export type ConflictID = typeof ConflictID.Type

export const ConflictKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(160),
).annotate({ identifier: "MemoryConflictKey" })
export type ConflictKey = typeof ConflictKey.Type

export const ConflictReason = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
).annotate({ identifier: "MemoryConflictReason" })
export type ConflictReason = typeof ConflictReason.Type

export const ConflictBasis = Schema.Literals(["explicit-tag", "deterministic-pattern-v1"]).annotate({
  identifier: "MemoryConflictBasis",
})
export type ConflictBasis = typeof ConflictBasis.Type

export const ConflictStatus = Schema.Literals(["pending", "resolved", "dismissed", "undone"]).annotate({
  identifier: "MemoryConflictStatus",
})
export type ConflictStatus = typeof ConflictStatus.Type

export const ConflictInfo = Schema.Struct({
  id: ConflictID,
  conflictKey: ConflictKey,
  basis: ConflictBasis,
  leftMemoryID: ID,
  rightMemoryID: ID,
  status: ConflictStatus,
  chosenMemoryID: ID.pipe(optional),
  retiredMemoryID: ID.pipe(optional),
  decisionReason: ConflictReason.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    decided: DateTimeUtcFromMillis.pipe(optional),
    undone: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Memory.ConflictInfo" })
export interface ConflictInfo extends Schema.Schema.Type<typeof ConflictInfo> {}

export const ConflictCandidate = Schema.Struct({
  conflict: ConflictInfo,
  left: Info,
  right: Info,
}).annotate({ identifier: "Memory.ConflictCandidate" })
export interface ConflictCandidate extends Schema.Schema.Type<typeof ConflictCandidate> {}

export const ConflictPage = Schema.Struct({
  detectorVersion: Schema.Literal("deterministic-v1"),
  scanned: NonNegativeInt,
  detected: NonNegativeInt,
  newCandidates: NonNegativeInt,
  items: Schema.Array(ConflictCandidate),
  count: NonNegativeInt,
  truncated: Schema.Boolean,
}).annotate({ identifier: "Memory.ConflictPage" })
export interface ConflictPage extends Schema.Schema.Type<typeof ConflictPage> {}

export const ConflictDecisionResult = Schema.Struct({
  conflict: ConflictInfo,
  left: Info,
  right: Info,
}).annotate({ identifier: "Memory.ConflictDecisionResult" })
export interface ConflictDecisionResult extends Schema.Schema.Type<typeof ConflictDecisionResult> {}

export const GovernanceCandidate = Schema.Struct({
  id: ID,
  reason: Schema.String,
  type: Type,
  source: Source,
  projectID: Schema.NonEmptyString.pipe(optional),
  workspacePath: Schema.NonEmptyString.pipe(optional),
  contentPreview: Schema.String,
}).annotate({ identifier: "Memory.GovernanceCandidate" })

export const GovernancePreview = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scanned: NonNegativeInt,
  candidateCount: NonNegativeInt,
  alreadyQuarantined: NonNegativeInt,
  reasons: Schema.Array(Schema.Struct({ reason: Schema.String, count: NonNegativeInt })),
  candidates: Schema.Array(GovernanceCandidate),
  truncated: Schema.Boolean,
  action: Schema.Literal("quarantine"),
  reversible: Schema.Literal(true),
}).annotate({ identifier: "Memory.GovernancePreview" })
export interface GovernancePreview extends Schema.Schema.Type<typeof GovernancePreview> {}

export const GovernanceApplied = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  scanned: NonNegativeInt,
  quarantined: NonNegativeInt,
  quarantinedIDs: Schema.Array(ID),
  reversible: Schema.Literal(true),
  status: Schema.Literal("applied"),
}).annotate({ identifier: "Memory.GovernanceApplied" })
export interface GovernanceApplied extends Schema.Schema.Type<typeof GovernanceApplied> {}
