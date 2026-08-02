import { Session } from "@arforge-ai/schema/session"
import { Trigger } from "@arforge-ai/schema/trigger"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { SessionNotFoundError, TriggerRequestError } from "../errors"

const root = "/api/session/:sessionID/trigger/:profile"
const params = { sessionID: Session.ID, profile: Trigger.ProfileName }
const body = Schema.Record(Schema.String, Schema.Unknown)

export const makeTriggerGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.trigger")
    .add(
      HttpApiEndpoint.get("trigger.profiles", "/api/trigger/profile", {
        success: Schema.Struct({ data: Trigger.Profiles }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.trigger.profiles",
          summary: "List host trigger profiles",
          description: "Returns safe profile metadata only; credential values are never included.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("trigger.list", root, {
        params,
        success: Schema.Struct({ data: Trigger.Result }),
        error: [SessionNotFoundError, TriggerRequestError],
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.get("trigger.get", `${root}/:triggerID`, {
        params: { ...params, triggerID: Schema.String },
        success: Schema.Struct({ data: Trigger.Result }),
        error: [SessionNotFoundError, TriggerRequestError],
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.post("trigger.create", root, {
        params,
        payload: Schema.Struct({ body }),
        success: Schema.Struct({ data: Trigger.Result }),
        error: [SessionNotFoundError, TriggerRequestError],
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.patch("trigger.update", `${root}/:triggerID`, {
        params: { ...params, triggerID: Schema.String },
        payload: Schema.Struct({ body }),
        success: Schema.Struct({ data: Trigger.Result }),
        error: [SessionNotFoundError, TriggerRequestError],
      }).middleware(sessionLocationMiddleware),
    )
    .add(
      HttpApiEndpoint.post("trigger.run", `${root}/:triggerID/run`, {
        params: { ...params, triggerID: Schema.String },
        success: Schema.Struct({ data: Trigger.Result }),
        error: [SessionNotFoundError, TriggerRequestError],
      }).middleware(sessionLocationMiddleware),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "triggers",
        description: "Provider-neutral local and host-configured authenticated HTTP trigger lifecycle.",
      }),
    )
