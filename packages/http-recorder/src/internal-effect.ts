import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Layer, Option, Ref } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/unstable/http"
import * as CassetteService from "./cassette.js"
import { defaultMatcher, selectSequential } from "./matching.js"
import { makeReplayState, resolveAutoMode } from "./recorder.js"
import { make, type Redactor } from "./redactor.js"
import { redactUrl } from "./redaction.js"
import { httpInteractions } from "./schema.js"
import {
  RECORDED_TRANSPORT_FAILURE,
  type CassetteMetadata,
  type HttpInteraction,
  type RequestMatcher,
  type RequestSnapshot,
  type ResponseSnapshot,
} from "./types.js"

export { defaultMatcher }

export type RecordReplayMode = "auto" | "record" | "replay" | "passthrough"

export interface RecordReplayOptions {
  readonly mode?: RecordReplayMode
  readonly directory?: string
  readonly metadata?: CassetteMetadata
  readonly redactor?: Redactor
  readonly match?: RequestMatcher
  readonly maxRequestBodyBytes?: number
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024

const TEXT_CONTENT_TYPES = new Set([
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/sql",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
])

const isTextContentType = (contentType: string | undefined) => {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase()
  if (!mediaType) return false
  return (
    mediaType.startsWith("text/") ||
    mediaType.endsWith("+json") ||
    mediaType.endsWith("+xml") ||
    TEXT_CONTENT_TYPES.has(mediaType)
  )
}

class RequestBodyCaptureFailure extends Error {
  constructor(readonly reason: "read" | "limit" | "content-length") {
    super(reason)
  }
}

const readRequestBody = (web: Request, maximumBytes: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!web.body) return new Uint8Array()
      const reader = web.body.getReader()
      const cancel = () => void reader.cancel().catch(() => undefined)
      signal.addEventListener("abort", cancel, { once: true })
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          length += next.value.length
          if (length > maximumBytes) {
            await reader.cancel()
            throw new RequestBodyCaptureFailure("limit")
          }
          chunks.push(next.value)
        }
      } finally {
        signal.removeEventListener("abort", cancel)
        reader.releaseLock()
      }
      const body = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.length
      }
      return body
    },
    catch: (cause) => (cause instanceof RequestBodyCaptureFailure ? cause : new RequestBodyCaptureFailure("read")),
  })

const canonicalMultipartBody = (formData: FormData) =>
  Effect.tryPromise({
    try: async () => {
      const entries: Array<Record<string, unknown>> = []
      const iterable = formData.entries() as Iterable<[string, string | (Blob & { readonly name: string })]>
      for (const [name, value] of iterable) {
        if (typeof value === "string") {
          entries.push({ [name]: { kind: "text", value } })
          continue
        }
        entries.push({
          [name]: {
            kind: "file",
            name: value.name,
            type: value.type,
            body: Buffer.from(await value.arrayBuffer()).toString("base64"),
            bodyEncoding: "base64",
          },
        })
      }
      return JSON.stringify({ entries })
    },
    catch: () => new RequestBodyCaptureFailure("read"),
  })

const captureResponseBody = (response: HttpClientResponse.HttpClientResponse, contentType: string | undefined) =>
  response.arrayBuffer.pipe(
    Effect.map((bytes) =>
      isTextContentType(contentType)
        ? { body: new TextDecoder().decode(bytes) }
        : { body: Buffer.from(bytes).toString("base64"), bodyEncoding: "base64" as const },
    ),
  )

const decodeResponseBody = (snapshot: ResponseSnapshot) =>
  snapshot.bodyEncoding === "base64" ? Buffer.from(snapshot.body, "base64") : snapshot.body

const responseFromSnapshot = (request: HttpClientRequest.HttpClientRequest, snapshot: ResponseSnapshot) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      request.method === "HEAD" || snapshot.status === 204 || snapshot.status === 205 || snapshot.status === 304
        ? null
        : decodeResponseBody(snapshot),
      snapshot,
    ),
  )

export const redactedErrorRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientRequest.makeWith(
    request.method,
    redactUrl(request.url),
    UrlParams.empty,
    Option.none(),
    Headers.empty,
    HttpBody.empty,
  )

const transportError = (request: HttpClientRequest.HttpClientRequest, description: string) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request: redactedErrorRequest(request), description }),
  })

export const recordingLayer = (
  name: string,
  options: Omit<RecordReplayOptions, "directory"> = {},
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient | CassetteService.Service> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const upstream = yield* HttpClient.HttpClient
      const cassetteService = yield* CassetteService.Service
      const redactor = options.redactor ?? make()
      const match = options.match ?? defaultMatcher
      const requested = options.mode ?? "auto"
      const mode = requested === "auto" ? yield* resolveAutoMode(cassetteService, name) : requested
      const maximumRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
      if (!Number.isSafeInteger(maximumRequestBodyBytes) || maximumRequestBodyBytes <= 0) {
        return yield* Effect.die(new Error("HttpRecorder maxRequestBodyBytes must be a positive safe integer"))
      }

      const snapshotRequest = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(
            Effect.mapError(() => transportError(request, "Recorder could not materialize the request URL and body")),
          )
          const bytes = yield* readRequestBody(web, maximumRequestBodyBytes).pipe(
            Effect.mapError((failure) =>
              transportError(
                request,
                failure.reason === "limit"
                  ? `Recorder request body exceeds maxRequestBodyBytes (${maximumRequestBodyBytes} bytes)`
                  : "Recorder could not read the request body for deterministic reconstruction",
              ),
            ),
          )
          const declaredLength = web.headers.get("content-length")
          if (declaredLength !== null && Number(declaredLength) !== bytes.length) {
            return yield* Effect.fail(
              transportError(request, "Recorder request body does not match its declared content-length"),
            )
          }
          const contentType = web.headers.get("content-type") ?? undefined
          const multipart = request.body._tag === "FormData"
          const capturedBody: Pick<RequestSnapshot, "body" | "bodyEncoding"> =
            request.body._tag === "Empty"
              ? { body: "" }
              : multipart
                ? {
                    body: yield* canonicalMultipartBody(request.body.formData).pipe(
                      Effect.mapError(() =>
                        transportError(request, "Recorder could not canonicalize the multipart request body"),
                      ),
                    ),
                    bodyEncoding: "multipart",
                  }
                : isTextContentType(contentType)
                  ? { body: new TextDecoder().decode(bytes) }
                  : { body: Buffer.from(bytes).toString("base64"), bodyEncoding: "base64" }
          const headers = Object.fromEntries(web.headers.entries())
          if (multipart) headers["content-type"] = "multipart/form-data"
          const snapshot = redactor.request({
            method: web.method,
            url: web.url,
            headers,
            ...capturedBody,
          })
          const reconstructed =
            request.body._tag === "Empty"
              ? request
              : HttpClientRequest.setBody(
                  request,
                  HttpBody.raw(bytes, {
                    contentType,
                    contentLength: declaredLength === null ? undefined : bytes.length,
                  }),
                )
          return { snapshot, reconstructed } as const
        })

      if (mode === "passthrough") return upstream

      if (mode === "record") {
        const initial = yield* Deferred.make<void>()
        yield* Deferred.succeed(initial, undefined)
        const tail = yield* Ref.make(initial)
        const recorded = yield* Ref.make<ReadonlyArray<HttpInteraction>>([])
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            // Every request completes its ordering token even when interrupted,
            // so scope settlement can deterministically observe the full batch.
            yield* Deferred.await(yield* Ref.get(tail))
            if (!Exit.isSuccess(exit)) return
            const interactions = yield* Ref.get(recorded)
            if (interactions.length === 0) return
            yield* cassetteService.commit(name, interactions, options.metadata).pipe(Effect.orDie)
          }),
        )
        return HttpClient.make((request) =>
          Effect.gen(function* () {
            const completed = yield* Deferred.make<void>()
            const previous = yield* Ref.modify(tail, (current) => [current, completed])
            return yield* Effect.gen(function* () {
              const prepared = yield* snapshotRequest(request)
              const result = yield* Effect.exit(upstream.execute(prepared.reconstructed))
              if (Exit.isFailure(result)) {
                // Cancellation is lifecycle control, not an upstream transport
                // outcome. Never persist a synthetic network failure for it.
                if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause)
                const interaction: HttpInteraction = {
                  transport: "http",
                  request: prepared.snapshot,
                  error: { kind: "transport", description: RECORDED_TRANSPORT_FAILURE },
                }
                yield* Deferred.await(previous)
                yield* Ref.update(recorded, (current) => [...current, interaction])
                return yield* Effect.failCause(result.cause)
              }
              const captured = yield* captureResponseBody(result.value, result.value.headers["content-type"])
              const responseSnapshot: ResponseSnapshot = {
                status: result.value.status,
                headers: result.value.headers as Record<string, string>,
                ...captured,
              }
              const interaction: HttpInteraction = {
                transport: "http",
                request: prepared.snapshot,
                response: redactor.response(responseSnapshot),
              }
              yield* Deferred.await(previous)
              yield* Ref.update(recorded, (current) => [...current, interaction])
              return responseFromSnapshot(request, responseSnapshot)
            }).pipe(Effect.ensuring(Deferred.succeed(completed, undefined)))
          }),
        )
      }

      const replay = yield* makeReplayState(cassetteService, name, httpInteractions)
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const incoming = (yield* snapshotRequest(request)).snapshot
          const claimed = yield* replay
            .claim((interaction, index, interactions) => {
              const result = selectSequential(interactions, incoming, match, index)
              if (result.interaction) return Effect.void
              return Effect.fail(
                transportError(request, `Fixture "${name}" does not match the current request: ${result.detail}.`),
              )
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "CassetteNotFoundError"
                  ? transportError(
                      request,
                      `Fixture "${name}" not found. Run locally to record it (CI=true forces replay).`,
                    )
                  : error._tag === "CassetteInvalidError"
                    ? transportError(
                        request,
                        `Fixture "${name}" is invalid: ${error.reason === "invalid-json" ? "invalid JSON" : "schema validation failed"}.`,
                      )
                    : error,
              ),
            )
          if (claimed.interaction.error) {
            return yield* Effect.fail(transportError(request, claimed.interaction.error.description))
          }
          return responseFromSnapshot(request, claimed.interaction.response)
        }),
      )
    }),
  )

export const cassetteLayer = (name: string, options: RecordReplayOptions = {}): Layer.Layer<HttpClient.HttpClient> =>
  recordingLayer(name, options).pipe(
    Layer.provide(CassetteService.fileSystem({ directory: options.directory })),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeFileSystem.layer),
  )
