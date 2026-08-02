export * as Trigger from "./trigger"

import { Schema } from "effect"

export const ProfileName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/)).annotate({
  identifier: "TriggerProfileName",
})
export type ProfileName = typeof ProfileName.Type

export const Kind = Schema.Literals(["local", "http"])
export type Kind = typeof Kind.Type

export const Action = Schema.Literals(["list", "get", "create", "update", "run"])
export type Action = typeof Action.Type

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

// HttpApi performs the recursive JSON-value validation at the response boundary.
// Keep the AST opaque so the client generator does not recursively expand an
// arbitrary provider response, while retaining the accurate no-service codec type.
export const JsonValue = (Schema.Unknown as unknown as Schema.Codec<JsonValue, JsonValue>).annotate({
  identifier: "Trigger.JsonValue",
  description: "A recursively valid JSON value.",
})

const BearerAuth = Schema.Struct({
  type: Schema.Literal("bearer_environment"),
  environmentVariable: Schema.String,
  configured: Schema.Boolean,
})

const OAuthAuth = Schema.Struct({
  type: Schema.Literal("oauth_client_credentials"),
  tokenUrl: Schema.String,
  clientIdEnvironment: Schema.String,
  clientSecretEnvironment: Schema.String,
  scopes: Schema.Array(Schema.String),
  audience: Schema.String,
  configured: Schema.Boolean,
})

export const Profile = Schema.Struct({
  name: ProfileName,
  kind: Kind,
  baseUrl: Schema.String,
  timeout: Schema.Finite,
  headerNames: Schema.Array(Schema.String),
  auth: Schema.optional(Schema.Union([BearerAuth, OAuthAuth])),
}).annotate({ identifier: "Trigger.Profile" })
export interface Profile extends Schema.Schema.Type<typeof Profile> {}

export const Profiles = Schema.Struct({
  items: Schema.Array(Profile),
  count: Schema.Int,
}).annotate({ identifier: "Trigger.Profiles" })
export interface Profiles extends Schema.Schema.Type<typeof Profiles> {}

export const Result = Schema.Struct({
  profile: ProfileName,
  kind: Kind,
  action: Action,
  status: Schema.Int,
  ok: Schema.Boolean,
  data: JsonValue,
}).annotate({ identifier: "Trigger.Result" })
export interface Result extends Schema.Schema.Type<typeof Result> {}
