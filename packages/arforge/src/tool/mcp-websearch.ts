import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpClientResponse } from "effect/unstable/http"
import { Egress } from "@arforge-ai/core/egress"

export const EXA_URL = "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"

/** Resolve the Exa credential only when the inner provider executor runs. */
export const exaUrl = () => {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return EXA_URL
  const url = new URL(EXA_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String,
      }),
    ),
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return undefined
    const data = yield* decode(trimmed)
    return data.result.content.find((item) => item.text)?.text
  })

export const parseResponse = Effect.fn("McpWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : undefined
  if (direct) return direct

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (data) return data
  }
  return undefined
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const ParallelSearchArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
  egress: Egress.Authorizer = Egress.make({
    action: tool,
    networkScope: [url],
    secretScope: [],
    allowedMethods: ["POST"],
  }),
  credentialScope: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    let target = url
    let redirectFrom: string | undefined
    for (let redirects = 0; ; redirects++) {
      yield* egress.assert({
        url: target,
        method: "POST",
        credentialScope,
        ...(redirectFrom === undefined ? {} : { redirectFrom }),
      })
      const request = HttpClientRequest.post(target).pipe(
        HttpClientRequest.accept("application/json, text/event-stream"),
        HttpClientRequest.setHeaders(headers ?? {}),
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0" as const,
          id: 1 as const,
          method: "tools/call" as const,
          params: { name: tool, arguments: value },
        }),
      )
      const response = yield* http.execute(request).pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error(`${tool} request timed out`)) }),
      )
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location
        if (!location) return yield* Effect.fail(new Error("HTTP redirect did not include a Location header"))
        if (redirects >= 3) return yield* Effect.fail(new Error("HTTP redirect limit exceeded"))
        redirectFrom = target
        target = yield* Effect.try({
          try: () => new URL(location, target).toString(),
          catch: (error) => error,
        })
        continue
      }
      const ok = yield* HttpClientResponse.filterStatusOk(response)
      return yield* parseResponse(yield* ok.text)
    }
  })
