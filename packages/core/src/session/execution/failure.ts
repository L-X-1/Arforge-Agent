import { Cause, Effect, Schema } from "effect"
import type { EventV2 } from "../../event"
import type { SessionSchema } from "../schema"
import { SessionEvent } from "../event"
import { SessionV1 } from "../../v1/session"
import { redact } from "../../redact"

const publicMessage = (message: string) =>
  redact(message)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 500) || "Session execution failed"

function publicError(failure: unknown): NonNullable<SessionV1.Assistant["error"]> {
  if (failure && Schema.is(SessionV1.Assistant.fields.error)(failure)) {
    // Keep the existing error semantics, but expose only the fields needed by
    // clients. Provider response headers/body/metadata remain on the Cause.
    switch (failure.name) {
      case "APIError":
        return {
          name: failure.name,
          data: {
            message: publicMessage(failure.data.message),
            isRetryable: failure.data.isRetryable,
            ...(failure.data.statusCode === undefined ? {} : { statusCode: failure.data.statusCode }),
          },
        }
      case "ProviderAuthError":
        return {
          name: failure.name,
          data: { providerID: publicMessage(failure.data.providerID), message: publicMessage(failure.data.message) },
        }
      case "StructuredOutputError":
        return { name: failure.name, data: { message: publicMessage(failure.data.message), retries: failure.data.retries } }
      case "MessageOutputLengthError":
        return { name: failure.name, data: {} }
      default:
        return { name: failure.name, data: { message: publicMessage(failure.data.message) } }
    }
  }
  const message =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "Session execution failed"
  return { name: "UnknownError", data: { message: publicMessage(message) } }
}

export function reportDrainFailure<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  input: {
    sessionID: SessionSchema.ID
    events: Pick<EventV2.Interface, "publish" | "listen">
    location?: EventV2.PublishOptions["location"] | (() => EventV2.PublishOptions["location"])
  },
) {
  return Effect.gen(function* () {
    let reported = false
    const unsubscribe = yield* input.events.listen((event) =>
      Effect.sync(() => {
        if (
          typeof event.data === "object" &&
          event.data !== null &&
          "sessionID" in event.data &&
          event.data.sessionID === input.sessionID &&
          (event.type === SessionV1.Event.Error.type || event.type === SessionEvent.Step.Failed.type)
        )
          reported = true
      }),
    )
    return yield* effect.pipe(
      Effect.tapCause((cause) => {
        if (reported || Cause.hasInterruptsOnly(cause)) return Effect.void
        const error = publicError(Cause.squash(cause))
        const location = typeof input.location === "function" ? input.location() : input.location
        // This live observation cannot promote queued inputs, settle a lease,
        // create an assistant message, or replace the original execution cause.
        return input.events.publish(SessionV1.Event.Error, { sessionID: input.sessionID, error }, { location }).pipe(
          Effect.asVoid,
          Effect.catchCause((publicationCause) =>
            Effect.logWarning("Could not publish session drain failure", {
              sessionID: input.sessionID,
              cause: publicationCause,
            }),
          ),
        )
      }),
      Effect.ensuring(unsubscribe),
    )
  })
}
