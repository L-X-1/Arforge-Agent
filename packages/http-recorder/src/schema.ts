import { Schema } from "effect"
import { RECORDED_TRANSPORT_FAILURE } from "./types.js"
import type {
  CassetteMetadata,
  HttpFailureSnapshot,
  HttpInteraction,
  RequestSnapshot,
  ResponseSnapshot,
  WebSocketEvent,
  WebSocketInteraction,
} from "./types.js"

export type {
  CassetteMetadata,
  HttpFailureSnapshot,
  HttpInteraction,
  RequestSnapshot,
  ResponseSnapshot,
  WebSocketEvent,
  WebSocketInteraction,
} from "./types.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const isCanonicalBase64 = (value: string) => {
  try {
    return Buffer.from(value, "base64").toString("base64") === value
  } catch {
    return false
  }
}

const isCanonicalMultipartBody = (body: string) => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.entries)) return false
    if (JSON.stringify(parsed) !== body) return false
    return parsed.entries.every((entry) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 1) return false
      const value = Object.values(entry)[0]
      if (value === "[REDACTED]") return true
      if (!isRecord(value)) return false
      if (value.kind === "text")
        return Object.keys(value).toSorted().join(",") === "kind,value" && typeof value.value === "string"
      if (value.kind !== "file") return false
      return (
        Object.keys(value).toSorted().join(",") === "body,bodyEncoding,kind,name,type" &&
        typeof value.name === "string" &&
        typeof value.type === "string" &&
        value.bodyEncoding === "base64" &&
        typeof value.body === "string" &&
        isCanonicalBase64(value.body)
      )
    })
  } catch {
    return false
  }
}

export const RequestSnapshotSchema = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyEncoding: Schema.optional(Schema.Literals(["text", "base64", "multipart"])),
}).pipe(
  Schema.refine(
    (snapshot): snapshot is RequestSnapshot =>
      snapshot.bodyEncoding === "base64"
        ? isCanonicalBase64(snapshot.body)
        : snapshot.bodyEncoding === "multipart"
          ? isCanonicalMultipartBody(snapshot.body)
          : true,
    { message: "Request snapshot body does not match its declared encoding" },
  ),
)

export const ResponseSnapshotSchema = Schema.Struct({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  bodyEncoding: Schema.optional(Schema.Literals(["text", "base64"])),
}).pipe(
  Schema.refine(
    (snapshot): snapshot is ResponseSnapshot => snapshot.bodyEncoding !== "base64" || isCanonicalBase64(snapshot.body),
    { message: "Response snapshot body is not canonical base64" },
  ),
)

export const CassetteMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)

export const HttpFailureSnapshotSchema = Schema.Struct({
  kind: Schema.tag("transport"),
  description: Schema.Literal(RECORDED_TRANSPORT_FAILURE),
})

export const HttpSuccessInteractionSchema = Schema.Struct({
  transport: Schema.tag("http"),
  request: RequestSnapshotSchema,
  response: ResponseSnapshotSchema,
})

export const HttpFailureInteractionSchema = Schema.Struct({
  transport: Schema.tag("http"),
  request: RequestSnapshotSchema,
  error: HttpFailureSnapshotSchema,
})

export const HttpInteractionSchema = Schema.Struct({
  transport: Schema.tag("http"),
  request: RequestSnapshotSchema,
  response: Schema.optional(ResponseSnapshotSchema),
  error: Schema.optional(HttpFailureSnapshotSchema),
}).pipe(
  Schema.refine(
    (interaction): interaction is HttpInteraction =>
      (interaction.response !== undefined) !== (interaction.error !== undefined),
    { message: "HTTP interaction must contain exactly one of response or error" },
  ),
)

export const WebSocketEventSchema = Schema.Union([
  Schema.Struct({
    direction: Schema.Literals(["client", "server"]),
    kind: Schema.tag("text"),
    body: Schema.String,
  }),
  Schema.Struct({
    direction: Schema.Literals(["client", "server"]),
    kind: Schema.tag("binary"),
    body: Schema.String,
    bodyEncoding: Schema.Literal("base64"),
  }),
])

export const WebSocketInteractionSchema = Schema.Struct({
  transport: Schema.tag("websocket"),
  open: Schema.Struct({
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  events: Schema.Array(WebSocketEventSchema),
})

export const InteractionSchema = Schema.Union([HttpInteractionSchema, WebSocketInteractionSchema])
export type Interaction = Schema.Schema.Type<typeof InteractionSchema>

export const isHttpInteraction = Schema.is(HttpInteractionSchema)

export const isWebSocketInteraction = Schema.is(WebSocketInteractionSchema)

export const httpInteractions = (interactions: ReadonlyArray<Interaction>) => interactions.filter(isHttpInteraction)

export const webSocketInteractions = (interactions: ReadonlyArray<Interaction>) =>
  interactions.filter(isWebSocketInteraction)

export const CassetteSchema = Schema.Struct({
  version: Schema.Literal(1),
  metadata: Schema.optional(CassetteMetadataSchema),
  interactions: Schema.Array(InteractionSchema),
})
export type Cassette = Schema.Schema.Type<typeof CassetteSchema>

export const decodeCassette = Schema.decodeUnknownSync(CassetteSchema)
export const encodeCassette = Schema.encodeSync(CassetteSchema)
