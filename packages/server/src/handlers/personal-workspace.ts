import { PersonalWorkspaceV2 } from "@arforge-ai/core/personal-workspace"
import { InvalidRequestError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const PersonalWorkspaceHandler = HttpApiBuilder.group(Api, "server.personalWorkspace", (handlers) =>
  handlers.handle(
    "personalWorkspace.snapshot",
    Effect.fn(function* (ctx) {
      return yield* (yield* PersonalWorkspaceV2.Service).snapshot({ limit: ctx.query.limit }).pipe(
        Effect.catchTag(
          "PersonalWorkspace.CorruptHistoryError",
          (error) =>
            new InvalidRequestError({
              field: "history",
              message: `Personal Workspace cannot be projected safely: ${error.reason}`,
            }),
        ),
      )
    }),
  ),
)
