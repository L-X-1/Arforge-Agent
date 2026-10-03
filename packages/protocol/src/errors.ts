import { Schema } from "effect"

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "ConflictError",
  {
    message: Schema.String,
    resource: Schema.optional(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

export class RateLimitedError extends Schema.TaggedErrorClass<RateLimitedError>()(
  "RateLimitedError",
  {
    message: Schema.String,
    retryAfterSeconds: Schema.Number,
  },
  { httpApiStatus: 429 },
) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
  "ServiceUnavailableError",
  {
    message: Schema.String,
    service: Schema.optional(Schema.String),
  },
  { httpApiStatus: 503 },
) {}

export class UnknownError extends Schema.TaggedErrorClass<UnknownError>()(
  "UnknownError",
  {
    message: Schema.String,
    ref: Schema.optional(Schema.String),
  },
  { httpApiStatus: 500 },
) {}

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "ProviderNotFoundError",
  {
    providerID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    server: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "MessageNotFoundError",
  {
    sessionID: Schema.String,
    messageID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class GoalNotFoundError extends Schema.TaggedErrorClass<GoalNotFoundError>()(
  "GoalNotFoundError",
  {
    sessionID: Schema.String,
    goalID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class CheckpointNotFoundError extends Schema.TaggedErrorClass<CheckpointNotFoundError>()(
  "CheckpointNotFoundError",
  {
    sessionID: Schema.String,
    checkpointID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ScheduledPromptNotFoundError extends Schema.TaggedErrorClass<ScheduledPromptNotFoundError>()(
  "ScheduledPromptNotFoundError",
  {
    sessionID: Schema.String,
    scheduleID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PersonalJobNotFoundError extends Schema.TaggedErrorClass<PersonalJobNotFoundError>()(
  "PersonalJobNotFoundError",
  {
    sessionID: Schema.String,
    jobID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "TaskNotFoundError",
  {
    sessionID: Schema.String,
    taskID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class TeamNotFoundError extends Schema.TaggedErrorClass<TeamNotFoundError>()(
  "TeamNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class TeamMemberNotFoundError extends Schema.TaggedErrorClass<TeamMemberNotFoundError>()(
  "TeamMemberNotFoundError",
  {
    sessionID: Schema.String,
    member: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class SubagentControlNotFoundError extends Schema.TaggedErrorClass<SubagentControlNotFoundError>()(
  "SubagentControlNotFoundError",
  {
    parentRunID: Schema.String,
    childRunID: Schema.String,
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class WaitNotFoundError extends Schema.TaggedErrorClass<WaitNotFoundError>()(
  "WaitNotFoundError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class MemoryNotFoundError extends Schema.TaggedErrorClass<MemoryNotFoundError>()(
  "MemoryNotFoundError",
  {
    memoryID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class TriggerRequestError extends Schema.TaggedErrorClass<TriggerRequestError>()(
  "TriggerRequestError",
  {
    code: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()(
  "InvalidCursorError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class PermissionNotFoundError extends Schema.TaggedErrorClass<PermissionNotFoundError>()(
  "PermissionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class QuestionNotFoundError extends Schema.TaggedErrorClass<QuestionNotFoundError>()(
  "QuestionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
  "ForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
  "PtyNotFoundError",
  {
    ptyID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}
