import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { Session } from "@arforge-ai/schema/session"
import { PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidRequestError,
  ScheduledPromptNotFoundError,
  SessionNotFoundError,
} from "../errors"

const root = "/api/session/:sessionID/schedule"
const params = { sessionID: Session.ID }
const itemParams = { ...params, scheduleID: ScheduledPrompt.ID }
const mutationErrors = [ConflictError, InvalidRequestError, ScheduledPromptNotFoundError, SessionNotFoundError]

export const makeScheduledPromptGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.scheduledPrompt")
    .add(
      HttpApiEndpoint.post("scheduledPrompt.create", root, {
        params,
        payload: Schema.Struct({
          name: ScheduledPrompt.Name,
          cron: ScheduledPrompt.Cron,
          prompt: ScheduledPrompt.Prompt,
          recurring: Schema.Boolean.pipe(Schema.optional),
          durable: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: ScheduledPrompt.Info }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.create",
            summary: "Create scheduled prompt",
            description:
              "Create a bounded five-field local-time schedule. Schedules expire after seven days and are admitted through the normal session prompt queue.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("scheduledPrompt.list", root, {
        params,
        success: Schema.Struct({ data: Schema.Array(ScheduledPrompt.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.list",
            summary: "List scheduled prompts",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("scheduledPrompt.get", `${root}/:scheduleID`, {
        params: itemParams,
        success: Schema.Struct({ data: ScheduledPrompt.Info }),
        error: [ScheduledPromptNotFoundError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.get",
            summary: "Get scheduled prompt",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("scheduledPrompt.update", `${root}/:scheduleID`, {
        params: itemParams,
        payload: Schema.Struct({
          expectedRevision: PositiveInt,
          name: ScheduledPrompt.Name.pipe(Schema.optional),
          cron: ScheduledPrompt.Cron.pipe(Schema.optional),
          prompt: ScheduledPrompt.Prompt.pipe(Schema.optional),
          enabled: Schema.Boolean.pipe(Schema.optional),
          recurring: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: ScheduledPrompt.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.update",
            summary: "Update scheduled prompt",
            description: "Update a schedule using its revision as an optimistic-concurrency token.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("scheduledPrompt.delete", `${root}/:scheduleID`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt }),
        success: HttpApiSchema.NoContent,
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.delete",
            summary: "Delete scheduled prompt",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("scheduledPrompt.run", `${root}/:scheduleID/run`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt }),
        success: Schema.Struct({ data: ScheduledPrompt.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.run",
            summary: "Run scheduled prompt now",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("scheduledPrompt.runMissed", `${root}/:scheduleID/run-missed`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt }),
        success: Schema.Struct({ data: ScheduledPrompt.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.scheduledPrompt.runMissed",
            summary: "Run a missed one-shot prompt",
            description: "Explicitly admit a one-shot prompt that became due while Arforge was not running.",
          }),
        ),
    )
