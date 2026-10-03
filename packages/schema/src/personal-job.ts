export * as PersonalJob from "./personal-job"

import { AgentRuntime } from "./agent-runtime"
import { Credential } from "./credential"
import { define, inventory } from "./event"
import { descending } from "./identifier"
import { ScheduledPrompt } from "./scheduled-prompt"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { ID, Occurrence, Digest } from "./personal-job-input"
import { Schema } from "effect"

export { ID, Occurrence, Digest } from "./personal-job-input"

export const NotificationID = Schema.String.check(Schema.isStartsWith("pjn_")).pipe(
  Schema.brand("PersonalJobNotificationID"),
  statics((schema) => ({
    create: () => schema.make("pjn_" + descending()),
  })),
)
export type NotificationID = typeof NotificationID.Type

export const IdempotencyKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(160),
).annotate({ identifier: "PersonalJobIdempotencyKey" })
export type IdempotencyKey = typeof IdempotencyKey.Type

export const Title = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(240),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
).annotate({ identifier: "PersonalJobTitle" })
export type Title = typeof Title.Type

export const Prompt = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(20_000)).annotate(
  { identifier: "PersonalJobPrompt" },
)
export type Prompt = typeof Prompt.Type

/** Every automatic task is explicitly marked as visible background work. */
export const Visibility = Schema.Struct({
  mode: Schema.Literal("background"),
  label: Schema.Literal("后台自动"),
  userVisible: Schema.Literal(true),
}).annotate({ identifier: "PersonalJob.Visibility" })
export interface Visibility extends Schema.Schema.Type<typeof Visibility> {}

export const Schedule = Schema.Struct({
  kind: Schema.Literals(["once", "cron"]),
  label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  cron: ScheduledPrompt.Cron.pipe(optional),
  nextRunAt: DateTimeUtcFromMillis,
  timezone: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)),
  scheduledPromptID: ScheduledPrompt.ID.pipe(optional),
}).annotate({ identifier: "PersonalJob.Schedule" })
export interface Schedule extends Schema.Schema.Type<typeof Schedule> {}

export const BudgetLimits = Schema.Struct({
  maxAttempts: PositiveInt,
  maxDurationMs: PositiveInt,
  maxCostMicros: NonNegativeInt,
}).annotate({ identifier: "PersonalJob.BudgetLimits" })
export interface BudgetLimits extends Schema.Schema.Type<typeof BudgetLimits> {}

export const Budget = Schema.Struct({
  ...BudgetLimits.fields,
  attemptsUsed: NonNegativeInt,
  durationMsUsed: NonNegativeInt,
  costMicrosUsed: NonNegativeInt,
}).annotate({ identifier: "PersonalJob.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const ApprovalPolicy = Schema.Struct({
  mode: Schema.Literals(["automatic", "user_once", "user_each_run"]),
  rationale: Schema.String.check(Schema.isMaxLength(1_000)),
}).annotate({ identifier: "PersonalJob.ApprovalPolicy" })
export interface ApprovalPolicy extends Schema.Schema.Type<typeof ApprovalPolicy> {}

export const ApprovalState = Schema.Literals(["not_required", "pending", "approved", "rejected"]).annotate({
  identifier: "PersonalJob.ApprovalState",
})
export type ApprovalState = typeof ApprovalState.Type

export const QuietHours = Schema.Struct({
  timezone: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)),
  startMinute: NonNegativeInt,
  endMinute: NonNegativeInt,
}).annotate({ identifier: "PersonalJob.QuietHours" })
export interface QuietHours extends Schema.Schema.Type<typeof QuietHours> {}

export const NotificationKind = Schema.Literals([
  "approval_required",
  "started",
  "completed",
  "failed",
  "paused",
  "cancelled",
  "budget_exhausted",
]).annotate({ identifier: "PersonalJob.NotificationKind" })
export type NotificationKind = typeof NotificationKind.Type

export const NotificationPolicy = Schema.Struct({
  mode: Schema.Literals(["none", "in_app"]),
  events: Schema.Array(NotificationKind).check(Schema.isMaxLength(8)),
}).annotate({ identifier: "PersonalJob.NotificationPolicy" })
export interface NotificationPolicy extends Schema.Schema.Type<typeof NotificationPolicy> {}

export const Notification = Schema.Struct({
  id: NotificationID,
  jobID: ID,
  kind: NotificationKind,
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)),
  body: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  availableAt: DateTimeUtcFromMillis,
  readAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "PersonalJob.Notification" })
export interface Notification extends Schema.Schema.Type<typeof Notification> {}

/**
 * A bounded, durable receipt for an output produced by a background run.
 *
 * The receipt deliberately contains metadata and a content digest only.  It
 * never embeds file bytes or provider credentials in the Personal Job event
 * stream.  The URI remains owned by the session/workspace that produced it.
 */
export const ResultArtifact = Schema.Struct({
  id: AgentRuntime.ArtifactID,
  /** Canonical receipt when the source delivery has already been retained. */
  artifactRef: Schema.suspend(() => AgentRuntime.OpaqueArtifactRef).pipe(optional),
  kind: Schema.Literals(["primary_delivery", "tool_output", "session_snapshot"]),
  uri: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  name: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)),
  mime: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  sizeBytes: NonNegativeInt,
  digest: Digest,
}).annotate({ identifier: "PersonalJob.ResultArtifact" })
export interface ResultArtifact extends Schema.Schema.Type<typeof ResultArtifact> {}

/** Durable execution fence used to recover an abandoned local worker. */
export const Execution = Schema.Struct({
  leaseID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
  heartbeatAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PersonalJob.Execution" })
export interface Execution extends Schema.Schema.Type<typeof Execution> {}

export const Result = Schema.Struct({
  status: Schema.Literals(["completed", "failed"]),
  summary: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(8_000)),
  digest: Digest,
  artifactRefs: Schema.Array(AgentRuntime.ArtifactID).check(Schema.isMaxLength(32)),
  artifacts: Schema.Array(ResultArtifact).check(Schema.isMaxLength(32)).pipe(optional),
  usage: Schema.Struct({
    durationMs: NonNegativeInt,
    costMicros: NonNegativeInt,
  }),
  recordedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "PersonalJob.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}

export const Retention = Schema.Struct({
  retainUntil: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "PersonalJob.Retention" })
export interface Retention extends Schema.Schema.Type<typeof Retention> {}

export const Status = Schema.Literals([
  "awaiting_approval",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "PersonalJob.Status" })
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  title: Title,
  prompt: Prompt,
  status: Status,
  visibility: Visibility,
  schedule: Schedule,
  credentialIDs: Schema.Array(Credential.ID).check(Schema.isMaxLength(32)),
  budget: Budget,
  approvalPolicy: ApprovalPolicy,
  approvalState: ApprovalState,
  execution: Execution.pipe(optional),
  occurrence: Occurrence.pipe(optional),
  quietHours: QuietHours.pipe(optional),
  notificationPolicy: NotificationPolicy,
  notifications: Schema.Array(Notification).check(Schema.isMaxLength(32)),
  result: Result.pipe(optional),
  retention: Retention,
  admissionDigest: Digest,
  lastError: Schema.String.check(Schema.isMaxLength(2_000)),
  revision: PositiveInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    started: DateTimeUtcFromMillis.pipe(optional),
    finished: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "PersonalJob.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Created = define({
  type: "personal.job.created",
  durable: { version: 1, aggregate: "jobID" },
  schema: { jobID: ID, job: Info },
})
const Changed = define({
  type: "personal.job.changed",
  durable: { version: 1, aggregate: "jobID" },
  schema: {
    jobID: ID,
    job: Info,
    reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
    changedAt: DateTimeUtcFromMillis,
  },
})
const Deleted = define({
  type: "personal.job.deleted",
  durable: { version: 1, aggregate: "jobID" },
  schema: {
    jobID: ID,
    deletedAt: DateTimeUtcFromMillis,
    reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(1_000)),
  },
})

export const Event = {
  Created,
  Changed,
  Deleted,
  Definitions: inventory(Created, Changed, Deleted),
}

export const DurableEvent = Schema.Union(Event.Definitions, { mode: "oneOf" })
export type DurableEvent = typeof DurableEvent.Type
