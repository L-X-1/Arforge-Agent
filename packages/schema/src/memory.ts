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
  algorithm: Schema.Literal("hybrid_bm25_hashing_vector"),
  localOnly: Schema.Literal(true),
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
