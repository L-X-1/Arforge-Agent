export * as SessionRevert from "./revert"

import { Effect, Schema } from "effect"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}

export class MutationUnavailableError extends Schema.TaggedErrorClass<MutationUnavailableError>()(
  "SessionRevert.MutationUnavailableError",
  {
    operation: Schema.Literals(["stage", "clear", "commit"]),
  },
) {
  override get message() {
    return `Session revert ${this.operation} is disabled until controlled restore runs through a sealed ControlRun worker`
  }
}

export const stage = Effect.fn("SessionRevert.stage")(function* (_input: {
  readonly session: SessionSchema.Info
  readonly messageID: SessionMessage.ID
  readonly files?: boolean
}) {
  return yield* new MutationUnavailableError({ operation: "stage" })
})

export const clear = Effect.fn("SessionRevert.clear")(function* (_session: SessionSchema.Info) {
  return yield* new MutationUnavailableError({ operation: "clear" })
})

export const commit = Effect.fn("SessionRevert.commit")(function* (_session: SessionSchema.Info) {
  return yield* new MutationUnavailableError({ operation: "commit" })
})
