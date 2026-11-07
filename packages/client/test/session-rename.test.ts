import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  Arforge,
  isConflictError,
  isSessionNotFoundError,
  type SessionsRenameInput,
  type SessionsRenameOutput,
} from "../src"
import { Arforge as EffectArforge, Session } from "../src/effect"

const title = "  manual\r\n" + "🧪".repeat(150) + "  "
const input: SessionsRenameInput = { sessionID: "ses_transport_fixture", title }

test("generated Promise rename sends only the exact title and decodes empty 204", async () => {
  let observed: Request | undefined
  const abort = new AbortController()
  const client = Arforge.make({
    baseUrl: "http://fixture.invalid",
    fetch: async (url, init) => {
      observed = new Request(url, init)
      return new Response(null, { status: 204 })
    },
  })
  const result: SessionsRenameOutput = await client.sessions.rename(input, { signal: abort.signal })
  expect(result).toBeUndefined()
  if (!observed) throw new Error("Generated rename did not request transport")
  expect(observed.url).toBe("http://fixture.invalid/api/session/ses_transport_fixture/rename")
  expect(observed.method).toBe("POST")
  expect(await observed.json()).toEqual({ title })
})

test("generated Promise rename preserves typed 404 and 409 failures", async () => {
  for (const [status, body, guard] of [
    [
      404,
      { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Missing session" },
      isSessionNotFoundError,
    ],
    [409, { _tag: "ConflictError", resource: input.sessionID, message: "Source changed" }, isConflictError],
  ] as const) {
    const client = Arforge.make({
      baseUrl: "http://fixture.invalid",
      fetch: async () => Response.json(body, { status }),
    })
    const error = await client.sessions.rename(input).then(
      () => {
        throw new Error("Unexpected rename success")
      },
      (error) => error,
    )
    expect(guard(error)).toBe(true)
    expect(error).toMatchObject(body)
  }
})

test("generated Effect rename preserves the exact typed input and NoContent result", async () => {
  let observed: { url: string; method: string; body: unknown } | undefined
  const transport = HttpClient.make((request) => {
    observed = {
      url: request.url,
      method: request.method,
      body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined,
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
  })
  const result: void = await Effect.gen(function* () {
    const client = yield* EffectArforge.make({ baseUrl: "http://fixture.invalid" })
    return yield* client.sessions.rename({ sessionID: Session.ID.make(input.sessionID), title })
  }).pipe(Effect.provideService(HttpClient.HttpClient, transport), Effect.runPromise)
  expect(result).toBeUndefined()
  expect(observed).toEqual({
    url: "http://fixture.invalid/api/session/ses_transport_fixture/rename",
    method: "POST",
    body: { title },
  })
})

test("generated Effect rename decodes the canonical conflict error", async () => {
  const transport = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ _tag: "ConflictError", resource: input.sessionID, message: "Source changed" }, { status: 409 }),
      ),
    ),
  )
  const outcome = await Effect.gen(function* () {
    const client = yield* EffectArforge.make({ baseUrl: "http://fixture.invalid" })
    return yield* client.sessions.rename({ sessionID: Session.ID.make(input.sessionID), title }).pipe(Effect.result)
  }).pipe(Effect.provideService(HttpClient.HttpClient, transport), Effect.runPromise)
  expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "ConflictError", resource: input.sessionID } })
})
