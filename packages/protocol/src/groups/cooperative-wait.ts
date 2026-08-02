import { CooperativeWait } from "@arforge-ai/schema/wait"
import { Session } from "@arforge-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, SessionNotFoundError, WaitNotFoundError } from "../errors"

const root = "/api/session/:sessionID/wait"
const params = { sessionID: Session.ID }

export const makeCooperativeWaitGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.cooperativeWait")
    .add(
      HttpApiEndpoint.get("cooperativeWait.active", root, {
        params,
        success: Schema.Struct({ data: Schema.NullOr(CooperativeWait.Info) }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.cooperativeWait.active",
            summary: "Inspect active cooperative wait",
            description: "Returns the one active wait for this session, or null.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("cooperativeWait.wake", `${root}/:waitID/wake`, {
        params: { ...params, waitID: CooperativeWait.ID },
        success: Schema.Struct({
          data: Schema.Struct({ ...CooperativeWait.Info.fields, wakeRequested: Schema.Literal(true) }),
        }),
        error: [ConflictError, SessionNotFoundError, WaitNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.cooperativeWait.wake",
            summary: "Wake cooperative wait",
            description: "Wake only the current session's active wait using its backend-issued identifier.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "cooperative waits",
        description: "Run-local shell-free waits with observation, wake-up, cancellation, and liveness events.",
      }),
    )
