import { TriggerV2 } from "@arforge-ai/core/trigger"
import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { SessionV2 } from "@arforge-ai/core/session"
import { TriggerRequestError } from "@arforge-ai/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const TriggerHandler = HttpApiBuilder.group(Api, "server.trigger", (handlers) =>
  Effect.gen(function* () {
    const triggers = yield* TriggerV2.Service
    const schedules = yield* ScheduledPromptV2.Service
    return handlers
      .handle("trigger.profiles", () => Effect.succeed({ data: triggers.profiles() }))
      .handle("trigger.list", (ctx) => execute(triggers, ctx.params, "list"))
      .handle("trigger.get", (ctx) => execute(triggers, ctx.params, "get"))
      .handle("trigger.create", (ctx) => execute(triggers, { ...ctx.params, body: ctx.payload.body }, "create"))
      .handle("trigger.update", (ctx) => execute(triggers, { ...ctx.params, body: ctx.payload.body }, "update"))
      .handle("trigger.run", (ctx) => run(triggers, schedules, ctx.params))
  }),
)

function execute(
  triggers: TriggerV2.Interface,
  input: {
    readonly sessionID: Parameters<TriggerV2.Interface["execute"]>[0]["sessionID"]
    readonly profile: TriggerV2.ProfileName
    readonly triggerID?: string
    readonly body?: Readonly<Record<string, unknown>>
  },
  action: TriggerV2.Action,
) {
  return Effect.gen(function* () {
    return {
      data: yield* triggers
        .execute({ ...input, action })
        .pipe(
          Effect.catchTag("Trigger.RuntimeError", (error) =>
            Effect.fail(new TriggerRequestError({ code: error.code, message: error.message })),
          ),
        ),
    }
  })
}

function run(
  triggers: TriggerV2.Interface,
  schedules: ScheduledPromptV2.Interface,
  input: {
    readonly sessionID: Parameters<TriggerV2.Interface["execute"]>[0]["sessionID"]
    readonly profile: TriggerV2.ProfileName
    readonly triggerID: string
  },
) {
  if (input.profile !== "local") return execute(triggers, input, "run")
  return Effect.gen(function* () {
    const requested = yield* triggers
      .execute({ ...input, action: "run" })
      .pipe(
        Effect.catchTag("Trigger.RuntimeError", (error) =>
          Effect.fail(new TriggerRequestError({ code: error.code, message: error.message })),
        ),
      )
    const data = requested.data
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      !("revision" in data) ||
      typeof data.revision !== "number"
    )
      return yield* new TriggerRequestError({
        code: "INVALID_RESPONSE",
        message: "local trigger returned an invalid schedule",
      })
    const updated = yield* schedules
      .run({
        sessionID: input.sessionID,
        scheduleID: ScheduledPromptV2.ID.make(input.triggerID),
        expectedRevision: data.revision,
      })
      .pipe(
        Effect.catch((error) => {
          if (error instanceof SessionV2.BusyError || error instanceof SessionV2.PromptConflictError)
            return Effect.fail(new TriggerRequestError({ code: "SESSION_BUSY", message: "session is already busy" }))
          if (error instanceof ScheduledPromptV2.NotFoundError)
            return Effect.fail(
              new TriggerRequestError({ code: "TRIGGER_NOT_FOUND", message: "scheduled prompt not found" }),
            )
          if (error instanceof SessionV2.NotFoundError)
            return Effect.fail(new TriggerRequestError({ code: "SESSION_NOT_FOUND", message: "session not found" }))
          if (error instanceof ScheduledPromptV2.StaleRevisionError)
            return Effect.fail(
              new TriggerRequestError({ code: "STALE_REVISION", message: "scheduled prompt changed concurrently" }),
            )
          if (error instanceof ScheduledPromptV2.InvalidStateError)
            return Effect.fail(
              new TriggerRequestError({
                code: "INVALID_STATE",
                message: `scheduled prompt cannot run while ${error.status}`,
              }),
            )
          if (error instanceof ScheduledPromptV2.InvalidCronError)
            return Effect.fail(new TriggerRequestError({ code: "INVALID_CRON", message: error.message }))
          return Effect.fail(error)
        }),
      )
    return {
      data: {
        ...requested,
        data: Schema.encodeUnknownSync(ScheduledPromptV2.Info)(updated),
      },
    }
  })
}
