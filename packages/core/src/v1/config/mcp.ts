export * as ConfigMCPV1 from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigMCP } from "../../config/mcp"

/** Legacy numbers are accepted only at the compatibility boundary. */
// Reuse the canonical fields while keeping this compatibility projection a
// plain record, so the original document merger can merge individual phases.
export const Timeout = Schema.Union([PositiveInt, Schema.Struct(ConfigMCP.Timeout.fields)])

export function canonicalTimeout(input: typeof Timeout.Type | undefined, scope: "server" | "defaults") {
  if (input === undefined) return undefined
  if (typeof input !== "number") return { ...input }
  // Historically a server number bounded startup as well as requests. The
  // old experimental global number applied to requests only.
  return { ...(scope === "server" ? { startup: input } : {}), request: input }
}

/** Split spellings without decoding twice or treating legacy server names as reserved fields. */
export function split(input: unknown): { legacy?: unknown; canonical?: unknown } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { canonical: input }
  const legacy: [string, unknown][] = []
  const canonical: [string, unknown][] = []
  for (const [key, value] of Object.entries(input)) {
    const server = typeof value === "object" && value !== null && ("type" in value || "enabled" in value)
    if ((key === "servers" || key === "timeout") && !server) canonical.push([key, value])
    else legacy.push([key, value])
  }
  return {
    ...(legacy.length ? { legacy: Object.fromEntries(legacy) } : {}),
    ...(canonical.length ? { canonical: Object.fromEntries(canonical) } : {}),
  }
}

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "Working directory for the MCP server process. Relative paths resolve from the workspace directory.",
  }),
  read_only_paths: Schema.optional(Schema.mutable(ConfigMCP.ReadOnlyPaths)),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  timeout: Schema.optional(Timeout).annotate({
    description:
      "Startup and request timeouts in milliseconds. A legacy number applies to both phases. Each phase defaults to 30000 unless configured globally.",
  }),
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "Port for the local OAuth callback server (default: 19876). Shorthand for redirectUri when only the port needs changing. Ignored if redirectUri is set.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  timeout: Schema.optional(Timeout).annotate({
    description:
      "Startup and request timeouts in milliseconds. A legacy number applies to both phases. Each phase defaults to 30000 unless configured globally.",
  }),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>

/** Read-only view for the existing MCP supervisor; the canonical document remains authoritative. */
export function fromCanonical(input: typeof ConfigMCP.Server.Type): Info | { enabled: boolean } {
  if (input.type === undefined) return { enabled: !input.disabled }
  const common = {
    ...(input.disabled === undefined ? {} : { enabled: !input.disabled }),
    ...(input.timeout === undefined ? {} : { timeout: canonicalTimeout(input.timeout, "server") }),
  }
  if (input.type === "local")
    return {
      ...common,
      type: "local",
      command: [...input.command],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.read_only_paths === undefined ? {} : { read_only_paths: [...input.read_only_paths] }),
      ...(input.environment === undefined ? {} : { environment: { ...input.environment } }),
    }
  return {
    ...common,
    type: "remote",
    url: input.url,
    ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
    ...(input.oauth === undefined
      ? {}
      : {
          oauth:
            input.oauth === false
              ? false
              : {
                  ...(input.oauth.client_id === undefined ? {} : { clientId: input.oauth.client_id }),
                  ...(input.oauth.client_secret === undefined ? {} : { clientSecret: input.oauth.client_secret }),
                  ...(input.oauth.scope === undefined ? {} : { scope: input.oauth.scope }),
                  ...(input.oauth.callback_port === undefined ? {} : { callbackPort: input.oauth.callback_port }),
                  ...(input.oauth.redirect_uri === undefined ? {} : { redirectUri: input.oauth.redirect_uri }),
                },
        }),
  }
}
