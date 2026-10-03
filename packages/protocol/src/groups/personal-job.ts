import { Credential } from "@arforge-ai/schema/credential"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { Session } from "@arforge-ai/schema/session"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidRequestError,
  PersonalJobNotFoundError,
  SessionNotFoundError,
} from "../errors"

const root = "/api/session/:sessionID/personal-job"
const params = { sessionID: Session.ID }
const itemParams = { ...params, jobID: PersonalJob.ID }
const notificationParams = { ...itemParams, notificationID: PersonalJob.NotificationID }
const revisionPayload = Schema.Struct({ expectedRevision: PositiveInt })
const dispatchPayload = Schema.Struct({ limit: PositiveInt.pipe(Schema.optional) })
const dispatchResult = Schema.Struct({
  recovered: NonNegativeInt,
  advanced: NonNegativeInt,
  attempted: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  skipped: NonNegativeInt,
})
const mutationErrors = [
  ConflictError,
  InvalidRequestError,
  PersonalJobNotFoundError,
  SessionNotFoundError,
]

const createPayload = Schema.Struct({
  idempotencyKey: PersonalJob.IdempotencyKey,
  title: PersonalJob.Title,
  prompt: PersonalJob.Prompt,
  schedule: PersonalJob.Schedule,
  credentialIDs: Schema.Array(Credential.ID).pipe(Schema.optional),
  budget: PersonalJob.BudgetLimits,
  approvalPolicy: PersonalJob.ApprovalPolicy,
  quietHours: PersonalJob.QuietHours.pipe(Schema.optional),
  notificationPolicy: PersonalJob.NotificationPolicy.pipe(Schema.optional),
  retainUntil: DateTimeUtcFromMillis.pipe(Schema.optional),
})

export const makePersonalJobGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.personalJob")
    .add(
      HttpApiEndpoint.post("personalJob.create", root, {
        params,
        payload: createPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.personalJob.create",
            summary: "Create visible background personal job",
            description:
              "Durably admit a user-visible background job with an explicit schedule, approval policy, credentials, and budget.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("personalJob.list", root, {
        params,
        query: { status: PersonalJob.Status.pipe(Schema.optional) },
        success: Schema.Struct({ data: Schema.Array(PersonalJob.Info) }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.list", summary: "List visible background jobs" })),
    )
    .add(
      HttpApiEndpoint.get("personalJob.get", `${root}/:jobID`, {
        params: itemParams,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.get", summary: "Get a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.approve", `${root}/:jobID/approve`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.approve", summary: "Approve a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.reject", `${root}/:jobID/reject`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt, reason: Schema.String.pipe(Schema.optional) }),
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.reject", summary: "Reject a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.start", `${root}/:jobID/start`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.start", summary: "Start a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.execute", `${root}/:jobID/execute`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.personalJob.execute",
            summary: "Execute a queued background job",
            description:
              "Durably start the queued job, return its running snapshot, and continue trusted Session Runner execution in the local background.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("personalJob.dispatch", `${root}/dispatch`, {
        params,
        payload: dispatchPayload,
        success: Schema.Struct({ data: dispatchResult }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.personalJob.dispatch",
            summary: "Dispatch due background jobs",
            description:
              "Advance and launch a bounded set of due jobs for the current user and session; non-runnable jobs remain fail-closed.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("personalJob.pause", `${root}/:jobID/pause`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.pause", summary: "Pause a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.resume", `${root}/:jobID/resume`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.resume", summary: "Resume a background job" })),
    )
    .add(
      HttpApiEndpoint.post("personalJob.cancel", `${root}/:jobID/cancel`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt, reason: Schema.String.pipe(Schema.optional) }),
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.cancel", summary: "Cancel a background job" })),
    )
    .add(
      HttpApiEndpoint.get("personalJob.notifications", `${root}/:jobID/notifications`, {
        params: itemParams,
        success: Schema.Struct({ data: Schema.Array(PersonalJob.Notification) }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.personalJob.notifications", summary: "List unread job notifications" }),
        ),
    )
    .add(
      HttpApiEndpoint.post("personalJob.notificationRead", `${root}/:jobID/notifications/:notificationID/read`, {
        params: notificationParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: PersonalJob.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.personalJob.notificationRead", summary: "Mark a job notification read" })),
    )
    .add(
      HttpApiEndpoint.delete("personalJob.delete", `${root}/:jobID`, {
        params: itemParams,
        payload: revisionPayload,
        success: HttpApiSchema.NoContent,
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.personalJob.delete",
            summary: "Delete a terminal background job",
            description: "Deletion is logical and preserves the durable audit stream; active retention blocks it.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "personal jobs",
        description: "Durable, visible, user-controlled Personal AI OS background job lifecycle.",
      }),
    )
