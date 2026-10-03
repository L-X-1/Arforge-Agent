export * as ConfigMCP from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Timeout extends Schema.Class<Timeout>("ConfigV2.MCP.Timeout")({
  startup: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to establish and initialize the MCP server.",
  }),
  request: PositiveInt.pipe(Schema.optional).annotate({
    description: "Maximum time in milliseconds to wait for each MCP request after initialization.",
  }),
}) {}

export const DefaultTimeout = 30_000

/** One phase-specific precedence rule; the returned execution settings cannot drift. */
export function resolveTimeouts(timeout?: typeof Timeout.Type, defaults?: typeof Timeout.Type) {
  return Object.freeze({
    startup: timeout?.startup ?? defaults?.startup ?? DefaultTimeout,
    request: timeout?.request ?? defaults?.request ?? DefaultTimeout,
  })
}

export const ReadOnlyPaths = Schema.Array(Schema.String.check(Schema.isPattern(/^[^\0]*[^\0\s][^\0]*$/u))).annotate({
  description:
    "Additional dependency directories approved for reads, relative to the workspace. Never adds write permission or removes an existing writable-root grant. Changes require a new local MCP approval.",
})

export class Local extends Schema.Class<Local>("ConfigV2.MCP.Local")({
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array),
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  read_only_paths: ReadOnlyPaths.pipe(Schema.optional),
  environment: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

export class OAuth extends Schema.Class<OAuth>("ConfigV2.MCP.OAuth")({
  client_id: Schema.String.pipe(Schema.optional),
  client_secret: Schema.String.pipe(Schema.optional),
  scope: Schema.String.pipe(Schema.optional),
  callback_port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })).pipe(Schema.optional),
  redirect_uri: Schema.String.pipe(Schema.optional),
}) {}

export class Remote extends Schema.Class<Remote>("ConfigV2.MCP.Remote")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  oauth: Schema.Union([OAuth, Schema.Literal(false)]).pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout.pipe(Schema.optional),
}) {}

// A higher-priority document may only toggle a server declared below it.
export const Override = Schema.Struct({ disabled: Schema.Boolean, type: Schema.optional(Schema.Never) })
export const Server = Schema.Union([Local, Remote, Override])

export class Info extends Schema.Class<Info>("ConfigV2.MCP")({
  timeout: Timeout.pipe(Schema.optional),
  servers: Schema.Record(Schema.String, Server).pipe(Schema.optional),
}) {}
