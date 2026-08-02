export * as Learning from "./learning"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

export const OutcomeID = Schema.String.check(Schema.isStartsWith("lout_")).pipe(
  Schema.brand("LearningOutcomeID"),
  statics((schema) => ({
    create: () => schema.make("lout_" + ascending()),
  })),
)
export type OutcomeID = typeof OutcomeID.Type

export const PatternID = Schema.String.check(Schema.isStartsWith("lpat_")).pipe(
  Schema.brand("LearningPatternID"),
  statics((schema) => ({
    create: () => schema.make("lpat_" + ascending()),
  })),
)
export type PatternID = typeof PatternID.Type

export const Outcome = Schema.Struct({
  id: OutcomeID,
  sessionID: SessionID.pipe(optional),
  projectID: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
  turnIndex: NonNegativeInt,
  userInput: Schema.String,
  intent: Schema.String,
  route: Schema.String,
  tools: Schema.Array(Schema.String),
  success: Schema.Boolean,
  errorType: Schema.String,
  errorMessage: Schema.String,
  userFeedback: Schema.String,
  fixStrategy: Schema.String,
  regression: Schema.Boolean,
  tokenCount: NonNegativeInt,
  responseTimeMs: NonNegativeInt,
  tags: Schema.Array(Schema.String),
  importance: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  injectedContextSize: NonNegativeInt,
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}).annotate({ identifier: "Learning.Outcome" })
export interface Outcome extends Schema.Schema.Type<typeof Outcome> {}

export const Pattern = Schema.Struct({
  id: PatternID,
  projectID: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
  type: Schema.String,
  description: Schema.String,
  frequency: Schema.Int.check(Schema.isGreaterThan(0)),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  tags: Schema.Array(Schema.String),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "Learning.Pattern" })
export interface Pattern extends Schema.Schema.Type<typeof Pattern> {}

export const Impact = Schema.Struct({
  status: Schema.Literals(["insufficient_data", "observed"]),
  injectedCount: NonNegativeInt,
  baselineCount: NonNegativeInt,
  injectedSuccessRate: Schema.Finite,
  baselineSuccessRate: Schema.Finite,
  uplift: Schema.Finite,
  caveat: Schema.String,
}).annotate({ identifier: "Learning.Impact" })
export interface Impact extends Schema.Schema.Type<typeof Impact> {}

export const Status = Schema.Struct({
  totalTurns: NonNegativeInt,
  successfulTurns: NonNegativeInt,
  failedTurns: NonNegativeInt,
  successRate: Schema.Finite,
  patternCount: NonNegativeInt,
  fixCount: NonNegativeInt,
  regressionCount: NonNegativeInt,
  correctionCount: NonNegativeInt,
  injectionCount: NonNegativeInt,
  averageInjectedContextSize: Schema.Finite,
  topTags: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      count: NonNegativeInt,
    }),
  ),
  recent: Schema.Array(Outcome),
  patterns: Schema.Array(Pattern),
  impact: Impact,
}).annotate({ identifier: "Learning.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const UndoResult = Schema.Struct({
  outcomeID: OutcomeID,
  deleted: Schema.Boolean,
  linkedPatterns: Schema.Array(
    Schema.Struct({
      patternID: PatternID,
      action: Schema.Literals(["decremented", "deleted"]),
    }),
  ),
}).annotate({ identifier: "Learning.UndoResult" })
export interface UndoResult extends Schema.Schema.Type<typeof UndoResult> {}

export const SyncResult = Schema.Struct({
  seen: NonNegativeInt,
  imported: NonNegativeInt,
  skipped: NonNegativeInt,
  failedCandidates: NonNegativeInt,
}).annotate({ identifier: "Learning.SyncResult" })
export interface SyncResult extends Schema.Schema.Type<typeof SyncResult> {}
