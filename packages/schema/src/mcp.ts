export * as Mcp from "./mcp"

import { Schema } from "effect"

export const Status = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs_auth") }),
  Schema.Struct({
    status: Schema.Literal("needs_client_registration"),
    error: Schema.String,
  }),
]).annotate({ identifier: "McpStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

export const Server = Schema.Struct({
  name: Schema.String,
  status: Status,
  integrationID: Schema.optional(Schema.String),
}).annotate({ identifier: "McpServer" })
export type Server = Schema.Schema.Type<typeof Server>

export const Resource = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ResourceTemplate = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  uriTemplate: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "McpResourceTemplate" })
export type ResourceTemplate = Schema.Schema.Type<typeof ResourceTemplate>

export const ResourceCatalog = Schema.Struct({
  resources: Schema.Array(Resource),
  templates: Schema.Array(ResourceTemplate),
}).annotate({ identifier: "McpResourceCatalog" })
export type ResourceCatalog = Schema.Schema.Type<typeof ResourceCatalog>
