import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { Headers, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { HttpRecorder } from "../src"
import { HttpRecorderInternal } from "../src/internal"
import { redactedErrorRequest } from "../src/internal-effect"
import type { Interaction } from "../src/schema"

const seedCassetteDirectory = (directory: string, name: string, interactions: ReadonlyArray<Interaction>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cassette = yield* HttpRecorderInternal.Cassette.Service
      yield* Effect.forEach(interactions, (interaction) => cassette.append(name, interaction))
    }).pipe(
      Effect.provide(HttpRecorderInternal.Cassette.fileSystem({ directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )

const post = (url: string, body: object) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(url, {
      headers: { "content-type": "application/json" },
      body: HttpBody.text(JSON.stringify(body), "application/json"),
    })
    const response = yield* http.execute(request)
    return yield* response.text
  })

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(HttpRecorder.http("record-replay/multi-step"))))

const runWith = <A, E>(
  name: string,
  options: HttpRecorder.RecorderOptions,
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(HttpRecorder.http(name, options))))

const runRecorder = <A, E>(effect: Effect.Effect<A, E, HttpRecorderInternal.Cassette.Service | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          HttpRecorderInternal.Cassette.fileSystem({
            directory: fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-")),
          }),
        ),
        Effect.provide(NodeFileSystem.layer),
      ),
    ),
  )

const failureText = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return ""
  return Cause.prettyErrors(exit.cause).join("\n")
}

describe("http-recorder", () => {
  test("redacts sensitive URL query parameters", () => {
    expect(
      HttpRecorderInternal.redactUrl(
        "https://example.test/path?key=secret-google-key&api_key=secret-openai-key&safe=value&X-Amz-Signature=secret-signature",
      ),
    ).toBe(
      "https://example.test/path?key=%5BREDACTED%5D&api_key=%5BREDACTED%5D&safe=value&X-Amz-Signature=%5BREDACTED%5D",
    )
  })

  test("redacts URL credentials", () => {
    expect(HttpRecorderInternal.redactUrl("https://user:password@example.test/path?safe=value")).toBe(
      "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/path?safe=value",
    )
  })

  test("applies custom URL redaction after built-in redaction", () => {
    expect(
      HttpRecorderInternal.redactUrl(
        "https://example.test/accounts/real-account/path?key=secret-key",
        undefined,
        (url) => url.replace("/accounts/real-account/", "/accounts/{account}/"),
      ),
    ).toBe("https://example.test/accounts/{account}/path?key=%5BREDACTED%5D")
  })

  test("redacts sensitive headers when allow-listed", () => {
    expect(
      HttpRecorderInternal.redactHeaders(
        {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "x-custom-token": "custom-secret",
          "x-api-key": "secret-key",
          "x-goog-api-key": "secret-google-key",
        },
        ["authorization", "content-type", "x-api-key", "x-goog-api-key", "x-custom-token"],
        ["x-custom-token"],
      ),
    ).toEqual({
      authorization: "[REDACTED]",
      "content-type": "application/json",
      "x-api-key": "[REDACTED]",
      "x-custom-token": "[REDACTED]",
      "x-goog-api-key": "[REDACTED]",
    })
  })

  test("redacts error requests without retaining headers, params, or body", () => {
    const request = HttpClientRequest.post("https://example.test/path", {
      headers: { authorization: "Bearer super-secret" },
      body: HttpBody.text("super-secret-body", "text/plain"),
    }).pipe(HttpClientRequest.setUrlParam("api_key", "super-secret-key"))

    expect(redactedErrorRequest(request).toJSON()).toMatchObject({
      url: "https://example.test/path",
      urlParams: { params: [] },
      headers: {},
      body: { _tag: "Empty" },
    })
  })

  test("detects secret-looking values without returning the secret", () => {
    expect(
      HttpRecorderInternal.secretFindings({
        version: 1,
        interactions: [
          {
            transport: "http",
            request: {
              method: "POST",
              url: "https://example.test/path?key=sk-123456789012345678901234",
              headers: {},
              body: JSON.stringify({ nested: "AIzaSyDHibiBRvJZLsFnPYPoiTwxY4ztQ55yqCE" }),
            },
            response: {
              status: 200,
              headers: {},
              body: "Bearer abcdefghijklmnopqrstuvwxyz",
            },
          },
        ],
      }),
    ).toEqual([
      { path: "interactions[0].request.url", reason: "API key" },
      { path: "interactions[0].request.body", reason: "Google API key" },
      { path: "interactions[0].response.body", reason: "bearer token" },
    ])
  })

  test("detects secret-looking values inside metadata", () => {
    expect(
      HttpRecorderInternal.secretFindings({
        version: 1,
        metadata: { token: "sk-123456789012345678901234" },
        interactions: [],
      }),
    ).toEqual([{ path: "metadata.token", reason: "API key" }])
  })

  test("redacts configured and common sensitive JSON fields", () => {
    const redactor = HttpRecorderInternal.Redactor.make({ jsonFields: ["account_id"] })
    const request = redactor.request({
      method: "POST",
      url: "https://example.test/path",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "secret-password",
        accessToken: "access-token",
        nested: { account_id: "account-123", safe: "visible" },
      }),
    })

    expect(JSON.parse(request.body)).toEqual({
      password: "[REDACTED]",
      accessToken: "[REDACTED]",
      nested: { account_id: "[REDACTED]", safe: "visible" },
    })
  })

  test("extends default header redaction and allow lists", () => {
    const redactor = HttpRecorderInternal.Redactor.make({
      headers: ["x-custom-token"],
      allowRequestHeaders: ["anthropic-version", "x-custom-token"],
    })

    expect(
      redactor.request({
        method: "GET",
        url: "https://example.test/path",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-custom-token": "secret",
        },
        body: "",
      }).headers,
    ).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-custom-token": "[REDACTED]",
    })
  })

  test("records WebSocket frames in observed client/server order", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    const response = JSON.stringify({ type: "response.completed", token: "server-secret" })
    let receive: ((message: string | Uint8Array) => Effect.Effect<unknown, unknown, unknown> | void) | undefined
    const upstream = Socket.make({
      runRaw: (handler, options) =>
        Effect.gen(function* () {
          receive = handler
          if (options?.onOpen) yield* options.onOpen
          receive = undefined
        }),
      writer: Effect.succeed(() =>
        Effect.suspend(() => {
          const result = receive?.(response)
          return Effect.isEffect(result) ? Effect.asVoid(result) : Effect.void
        }),
      ),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const write = yield* socket.writer
        yield* socket.runRaw(() => {}, {
          onOpen: write(JSON.stringify({ type: "response.create", token: "client-secret" })),
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/record",
            { url: "wss://example.test/realtime", headers: { "content-type": "application/json" } },
            { directory, metadata: { provider: "test" }, mode: "record" },
          ).pipe(Layer.provide(Layer.succeed(Socket.Socket, upstream))),
        ),
      ),
    )

    expect(JSON.parse(fs.readFileSync(path.join(directory, "websocket/record.json"), "utf8"))).toMatchObject({
      interactions: [
        {
          transport: "websocket",
          open: { url: "wss://example.test/realtime", headers: { "content-type": "application/json" } },
          events: [
            { direction: "client", kind: "text", body: '{"type":"response.create","token":"[REDACTED]"}' },
            { direction: "server", kind: "text", body: '{"type":"response.completed","token":"[REDACTED]"}' },
          ],
        },
      ],
    })
  })

  test("WebSocket replay preserves causal frame ordering", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    await seedCassetteDirectory(directory, "websocket/replay", [
      {
        transport: "websocket",
        open: { url: "wss://example.test/realtime", headers: {} },
        events: [
          { direction: "server", kind: "text", body: '{"type":"session.created"}' },
          { direction: "client", kind: "text", body: '{"type":"response.create","prompt":"hello"}' },
          { direction: "server", kind: "text", body: '{"type":"response.completed"}' },
        ],
      },
    ])

    const received: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const write = yield* socket.writer
        yield* socket.runRaw((message) => {
          if (typeof message !== "string") return
          received.push(message)
          if (JSON.parse(message).type === "session.created")
            return write('{"prompt":"hello","type":"response.create"}')
        })
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/replay",
            { url: "wss://example.test/realtime" },
            { directory, compareClientMessagesAsJson: true, mode: "replay" },
          ).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("unexpected live WebSocket run")),
                  writer: Effect.succeed(() => Effect.die(new Error("unexpected live WebSocket write"))),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(received).toEqual(['{"type":"session.created"}', '{"type":"response.completed"}'])
  })

  test("the public socket decorator replays a provided Effect socket", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    await seedCassetteDirectory(directory, "websocket/public-layer", [
      {
        transport: "websocket",
        open: { url: "", headers: {} },
        events: [
          { direction: "client", kind: "text", body: "hello" },
          { direction: "server", kind: "text", body: "hello" },
        ],
      },
    ])

    const received: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const write = yield* socket.writer
        yield* socket.runString(
          (message) =>
            Effect.gen(function* () {
              received.push(message)
              yield* write(new Socket.CloseEvent(1000))
            }),
          { onOpen: write("hello") },
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorder.socket("websocket/public-layer", { directory }).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("unexpected live WebSocket run")),
                  writer: Effect.succeed(() => Effect.die(new Error("unexpected live WebSocket write"))),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(received).toEqual(["hello"])
  })

  test("WebSocket replay runs message handlers concurrently", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    await seedCassetteDirectory(directory, "websocket/concurrent-handlers", [
      {
        transport: "websocket",
        open: { url: "wss://example.test/realtime", headers: {} },
        events: [
          { direction: "server", kind: "text", body: "first" },
          { direction: "server", kind: "text", body: "second" },
        ],
      },
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const second = yield* Deferred.make<void>()
        yield* socket.runString((message) =>
          message === "first" ? Deferred.await(second) : Deferred.succeed(second, undefined),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/concurrent-handlers",
            { url: "wss://example.test/realtime" },
            { directory, mode: "replay" },
          ).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("unexpected live WebSocket run")),
                  writer: Effect.succeed(() => Effect.die(new Error("unexpected live WebSocket write"))),
                }),
              ),
            ),
          ),
        ),
      ),
    )
  })

  test("WebSocket replay rejects close with unconsumed events", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    await seedCassetteDirectory(directory, "websocket/early-close", [
      {
        transport: "websocket",
        open: { url: "wss://example.test/realtime", headers: {} },
        events: [{ direction: "client", kind: "text", body: "expected" }],
      },
    ])

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const write = yield* socket.writer
        return yield* Effect.exit(socket.runRaw(() => {}, { onOpen: write(new Socket.CloseEvent(1000)) }))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/early-close",
            { url: "wss://example.test/realtime" },
            { directory, mode: "replay" },
          ).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("unexpected live WebSocket run")),
                  writer: Effect.succeed(() => Effect.die(new Error("unexpected live WebSocket write"))),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(failureText(exit)).toContain("closed with unconsumed events")
  })

  test("failed WebSocket runs do not write complete cassettes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        return yield* Effect.exit(socket.runRaw(() => {}))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/failed-run",
            { url: "wss://example.test/realtime" },
            { directory, mode: "record" },
          ).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("connection failed")),
                  writer: Effect.succeed(() => Effect.void),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fs.existsSync(path.join(directory, "websocket/failed-run.json"))).toBe(false)
  })

  test("WebSocket replay preserves binary frame kinds across reconnects", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-websocket-"))
    const interaction = {
      transport: "websocket" as const,
      open: { url: "wss://example.test/binary", headers: {} },
      events: [
        {
          direction: "client" as const,
          kind: "binary" as const,
          body: Buffer.from([1, 2]).toString("base64"),
          bodyEncoding: "base64" as const,
        },
        {
          direction: "server" as const,
          kind: "binary" as const,
          body: Buffer.from([3, 4]).toString("base64"),
          bodyEncoding: "base64" as const,
        },
      ],
    }
    await seedCassetteDirectory(directory, "websocket/binary", [interaction, interaction])

    const received: number[][] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const socket = yield* Socket.Socket
        const write = yield* socket.writer
        const run = socket.runRaw(
          (message) => {
            if (typeof message === "string") throw new Error("Expected a binary WebSocket frame")
            received.push([...message])
          },
          { onOpen: write(new Uint8Array([1, 2])) },
        )
        yield* run
        yield* run
      }).pipe(
        Effect.scoped,
        Effect.provide(
          HttpRecorderInternal.socketLayer(
            "websocket/binary",
            { url: "wss://example.test/binary" },
            { directory, mode: "replay" },
          ).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.Socket,
                Socket.make({
                  runRaw: () => Effect.die(new Error("unexpected live WebSocket run")),
                  writer: Effect.succeed(() => Effect.die(new Error("unexpected live WebSocket write"))),
                }),
              ),
            ),
          ),
        ),
      ),
    )

    expect(received).toEqual([
      [3, 4],
      [3, 4],
    ])
  })

  test("replay returns recorded responses in order for identical requests", async () => {
    await runWith(
      "record-replay/retry",
      {},
      Effect.gen(function* () {
        expect(yield* post("https://example.test/poll", { id: "job_1" })).toBe('{"status":"pending"}')
        expect(yield* post("https://example.test/poll", { id: "job_1" })).toBe('{"status":"complete"}')
      }),
    )
  })

  test("replay reports cursor exhaustion when more requests are made than recorded", async () => {
    await run(
      Effect.gen(function* () {
        yield* post("https://example.test/echo", { step: 1 })
        yield* post("https://example.test/echo", { step: 2 })
        const exit = yield* Effect.exit(post("https://example.test/echo", { step: 3 }))
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  test("replay validates each recorded request in order", async () => {
    await run(
      Effect.gen(function* () {
        yield* post("https://example.test/echo", { step: 1 })
        const exit = yield* Effect.exit(post("https://example.test/echo", { step: 3 }))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(failureText(exit)).toContain("$.step expected 2, received 3")
        expect(yield* post("https://example.test/echo", { step: 2 })).toBe('{"reply":"second"}')
      }),
    )
  })

  test("concurrent replay claims each interaction once", async () => {
    const results = await runWith(
      "record-replay/retry",
      {},
      Effect.all(
        [post("https://example.test/poll", { id: "job_1" }), post("https://example.test/poll", { id: "job_1" })],
        { concurrency: "unbounded" },
      ),
    )

    expect(results.toSorted()).toEqual(['{"status":"complete"}', '{"status":"pending"}'])
  })

  test("replay fails when a built cassette scope consumes zero recorded interactions", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          yield* HttpClient.HttpClient
        }).pipe(Effect.provide(HttpRecorder.http("record-replay/multi-step"))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureText(exit)).toContain("Unused recorded interactions in record-replay/multi-step: used 0 of 2")
  })

  test("replays when the cassette exists", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-auto-"))
    await seedCassetteDirectory(directory, "auto-replay", [
      {
        transport: "http",
        request: {
          method: "POST",
          url: "https://example.test/echo",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ step: 1 }),
        },
        response: { status: 200, headers: { "content-type": "application/json" }, body: '{"reply":"hi"}' },
      },
    ])

    const result = await runWith("auto-replay", { directory }, post("https://example.test/echo", { step: 1 }))
    expect(result).toBe('{"reply":"hi"}')
  })

  test("forces replay when CI=true even if cassette is missing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-auto-ci-"))
    const previous = process.env.CI
    process.env.CI = "true"
    try {
      const exit = await Effect.runPromise(
        Effect.exit(
          post("https://example.test/echo", { step: 1 }).pipe(
            Effect.provide(HttpRecorder.http("missing-cassette", { directory })),
          ),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(failureText(exit)).toContain('Fixture "missing-cassette" not found')
    } finally {
      if (previous === undefined) delete process.env.CI
      else process.env.CI = previous
    }
  })

  test("distinguishes invalid JSON and invalid cassette schema without echoing fixture contents", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-invalid-"))
    const secret = "sk-123456789012345678901234"
    fs.writeFileSync(path.join(directory, "broken-json.json"), `{${secret}`)
    fs.writeFileSync(
      path.join(directory, "broken-schema.json"),
      JSON.stringify({ version: 1, metadata: { name: "broken-schema" }, interactions: [{ secret }] }),
    )
    fs.writeFileSync(
      path.join(directory, "unbounded-failure.json"),
      JSON.stringify({
        version: 1,
        interactions: [
          {
            transport: "http",
            request: {
              method: "POST",
              url: "https://example.test/echo",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ step: 1 }),
            },
            error: { kind: "transport", description: secret },
          },
        ],
      }),
    )
    for (const [name, bodyEncoding, body] of [
      ["invalid-base64", "base64", "not-base64!"],
      ["invalid-multipart", "multipart", "{}"],
    ] as const) {
      fs.writeFileSync(
        path.join(directory, `${name}.json`),
        JSON.stringify({
          version: 1,
          interactions: [
            {
              transport: "http",
              request: {
                method: "POST",
                url: "https://example.test/echo",
                headers: { "content-type": "application/json" },
                body,
                bodyEncoding,
              },
              response: { status: 200, headers: {}, body: "unused" },
            },
          ],
        }),
      )
    }

    const replay = (name: string) =>
      Effect.runPromise(
        Effect.exit(
          post("https://example.test/echo", { step: 1 }).pipe(
            Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "replay" })),
          ),
        ),
      )
    const invalidJson = failureText(await replay("broken-json"))
    const invalidSchema = failureText(await replay("broken-schema"))
    const unboundedFailure = failureText(await replay("unbounded-failure"))
    const invalidBase64 = failureText(await replay("invalid-base64"))
    const invalidMultipart = failureText(await replay("invalid-multipart"))

    expect(invalidJson).toContain('Fixture "broken-json" is invalid: invalid JSON')
    expect(invalidSchema).toContain('Fixture "broken-schema" is invalid: schema validation failed')
    expect(unboundedFailure).toContain('Fixture "unbounded-failure" is invalid: schema validation failed')
    expect(invalidBase64).toContain('Fixture "invalid-base64" is invalid: schema validation failed')
    expect(invalidMultipart).toContain('Fixture "invalid-multipart" is invalid: schema validation failed')
    expect(invalidJson).not.toContain(secret)
    expect(invalidSchema).not.toContain(secret)
    expect(unboundedFailure).not.toContain(secret)
  })

  test("mismatch diagnostics show redacted request differences against the expected interaction", async () => {
    await run(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          post("https://example.test/echo?api_key=secret-value", { step: 3, token: "sk-123456789012345678901234" }),
        )
        const message = failureText(exit)
        expect(message).toContain("url:")
        expect(message).toContain("https://example.test/echo?api_key=%5BREDACTED%5D")
        expect(message).toContain("body:")
        expect(message).toContain("$.step expected 1, received 3")
        expect(message).toContain('$.token expected undefined, received "[REDACTED]"')
        expect(message).not.toContain("sk-123456789012345678901234")
        // A failed match does not advance the replay cursor. Consume the
        // cassette afterward so the strict success-path completeness gate can
        // distinguish diagnostic recovery from a silently unused fixture.
        expect(yield* post("https://example.test/echo", { step: 1 })).toBe('{"reply":"first"}')
        expect(yield* post("https://example.test/echo", { step: 2 })).toBe('{"reply":"second"}')
      }),
    )
  })

  test("records to disk when the cassette is missing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-auto-record-"))
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response('{"reply":"recorded"}', { headers: { "content-type": "application/json" } }),
    })
    const url = `http://127.0.0.1:${server.port}/echo`
    // CI=true forces replay; clear it so we exercise the local-dev auto-record path.
    const previous = process.env.CI
    delete process.env.CI
    try {
      const result = await runWith("auto-record", { directory }, post(url, { step: 1 }))
      expect(result).toBe('{"reply":"recorded"}')
      expect(fs.existsSync(path.join(directory, "auto-record.json"))).toBe(true)
    } finally {
      if (previous !== undefined) process.env.CI = previous
    }
  })

  test("promotes an HTTP recording only after the complete scope succeeds", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-transaction-"))
    const target = path.join(directory, "transactional-record.json")
    using server = Bun.serve({
      port: 0,
      fetch: (request) => new Response(new URL(request.url).pathname),
    })
    const url = `http://127.0.0.1:${server.port}`

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* post(`${url}/first`, { step: 1 })
        expect(fs.existsSync(target)).toBe(false)
        yield* post(`${url}/second`, { step: 2 })
        expect(fs.existsSync(target)).toBe(false)
      }).pipe(
        Effect.provide(HttpRecorderInternal.cassetteLayer("transactional-record", { directory, mode: "record" })),
      ),
    )

    const cassette = JSON.parse(fs.readFileSync(target, "utf8"))
    expect(cassette.interactions.map((interaction: Interaction) => interaction.request.url)).toEqual([
      `${url}/first`,
      `${url}/second`,
    ])
    expect(fs.readdirSync(directory).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })

  test("successful recording scopes atomically replace an existing cassette", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-replace-"))
    const name = "transactional-replace"
    const target = path.join(directory, `${name}.json`)
    await seedCassetteDirectory(directory, name, [
      {
        transport: "http",
        request: { method: "GET", url: "https://previous.test", headers: {}, body: "" },
        response: { status: 200, headers: {}, body: "previous" },
      },
    ])
    const previous = fs.readFileSync(target, "utf8")
    using server = Bun.serve({ port: 0, fetch: () => new Response("replacement") })
    const url = `http://127.0.0.1:${server.port}/replacement`

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* post(url, { step: 1 })
        expect(fs.readFileSync(target, "utf8")).toBe(previous)
      }).pipe(Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record" }))),
    )

    const cassette = JSON.parse(fs.readFileSync(target, "utf8"))
    expect(cassette.interactions).toHaveLength(1)
    expect(cassette.interactions[0].request.url).toBe(url)
    expect(cassette.interactions[0].response.body).toBe("replacement")
    expect(fs.readdirSync(directory).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })

  test("failed recording scopes preserve the previous cassette without partial promotion", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-rollback-"))
    const name = "transactional-rollback"
    const target = path.join(directory, `${name}.json`)
    const previousInteraction: Interaction = {
      transport: "http",
      request: { method: "GET", url: "https://previous.test", headers: {}, body: "" },
      response: { status: 200, headers: {}, body: "previous" },
    }
    await seedCassetteDirectory(directory, name, [previousInteraction])
    const previous = fs.readFileSync(target, "utf8")
    using server = Bun.serve({ port: 0, fetch: () => new Response("new") })

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          yield* post(`http://127.0.0.1:${server.port}/new`, { step: 1 })
          return yield* Effect.fail(new Error("abort the recording scope"))
        }).pipe(Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record" }))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(fs.readFileSync(target, "utf8")).toBe(previous)
    expect(fs.readdirSync(directory).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })

  test("records concurrent requests in request-start order", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-order-"))
    const first = Promise.withResolvers<void>()
    const completed: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const name = new URL(request.url).pathname.slice(1)
        if (name === "first") {
          await first.promise
          completed.push(name)
          return new Response(name)
        }
        completed.push(name)
        first.resolve()
        return new Response(name)
      },
    })
    const previous = process.env.CI
    delete process.env.CI
    try {
      const request = (name: string) =>
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          const response = yield* http.execute(HttpClientRequest.get(`http://127.0.0.1:${server.port}/${name}`))
          return yield* response.text
        })
      const responses = await Effect.runPromise(
        Effect.all([request("first"), request("second")], { concurrency: "unbounded" }).pipe(
          Effect.provide(HttpRecorder.http("concurrent-order", { directory })),
        ),
      )
      const cassette = JSON.parse(fs.readFileSync(path.join(directory, "concurrent-order.json"), "utf8"))

      expect(completed).toEqual(["second", "first"])
      expect(responses).toEqual(["first", "second"])
      expect(cassette.interactions.map((interaction: Interaction) => interaction.request.url)).toEqual([
        `http://127.0.0.1:${server.port}/first`,
        `http://127.0.0.1:${server.port}/second`,
      ])
    } finally {
      if (previous !== undefined) process.env.CI = previous
    }
  })

  test("returns the live response while persisting its redacted snapshot", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-live-response-"))
    using server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ access_token: "live-secret", safe: true }), {
          headers: { "content-type": "application/json", "x-request-id": "request-1" },
        }),
    })
    const previous = process.env.CI
    delete process.env.CI
    try {
      const body = await runWith(
        "live-response",
        { directory },
        post(`http://127.0.0.1:${server.port}/response`, { ok: true }),
      )
      const cassette = JSON.parse(fs.readFileSync(path.join(directory, "live-response.json"), "utf8"))

      expect(body).toBe('{"access_token":"live-secret","safe":true}')
      expect(cassette.interactions[0].response.body).toBe('{"access_token":"[REDACTED]","safe":true}')
    } finally {
      if (previous !== undefined) process.env.CI = previous
    }
  })

  test("reconstructs responses with null-body statuses", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-no-content-"))
    using server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) })
    const previous = process.env.CI
    delete process.env.CI
    try {
      const program = Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        return yield* http.execute(HttpClientRequest.get(`http://127.0.0.1:${server.port}/empty`))
      })
      const response = await Effect.runPromise(
        program.pipe(Effect.provide(HttpRecorder.http("no-content", { directory }))),
      )

      expect(response.status).toBe(204)
    } finally {
      if (previous !== undefined) process.env.CI = previous
    }
  })

  test("records and replays arbitrary binary responses without changing bytes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-binary-"))
    const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80])
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response(expected, { headers: { "content-type": "image/png" } }),
    })
    const url = `http://127.0.0.1:${server.port}/image.png`
    const previous = process.env.CI
    delete process.env.CI
    try {
      const program = Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const response = yield* http.execute(HttpClientRequest.get(url))
        return new Uint8Array(yield* response.arrayBuffer)
      })
      const record = await Effect.runPromise(program.pipe(Effect.provide(HttpRecorder.http("binary", { directory }))))
      await server.stop()
      const replay = await Effect.runPromise(program.pipe(Effect.provide(HttpRecorder.http("binary", { directory }))))
      const cassette = JSON.parse(fs.readFileSync(path.join(directory, "binary.json"), "utf8"))

      expect(record).toEqual(expected)
      expect(replay).toEqual(expected)
      expect(cassette.interactions[0].response.bodyEncoding).toBe("base64")
    } finally {
      if (previous !== undefined) process.env.CI = previous
    }
  })

  test("reconstructs one-shot streaming request bodies without consuming the upstream payload", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-one-shot-request-"))
    const name = "one-shot-request"
    const expected = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff])
    const received: Uint8Array[] = []
    using server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push(new Uint8Array(await request.arrayBuffer()))
        return new Response("uploaded")
      },
    })
    const url = `http://127.0.0.1:${server.port}/upload`
    const upload = () =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(expected)
            controller.close()
          },
        })
        const request = HttpClientRequest.post(url, {
          body: HttpBody.raw(stream, {
            contentType: "application/octet-stream",
            contentLength: expected.length,
          }),
        })
        return yield* (yield* http.execute(request)).text
      })

    const recorded = await Effect.runPromise(
      upload().pipe(Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record" }))),
    )
    expect(recorded).toBe("uploaded")
    expect(received).toEqual([expected])
    const cassette = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), "utf8"))
    expect(cassette.interactions[0].request.bodyEncoding).toBe("base64")
    expect(cassette.interactions[0].request.body).toBe(Buffer.from(expected).toString("base64"))

    await server.stop()
    const replayed = await Effect.runPromise(upload().pipe(Effect.provide(HttpRecorder.http(name, { directory }))))
    expect(replayed).toBe("uploaded")
    expect(received).toHaveLength(1)
  })

  test("canonically records multipart fields and files independent of the generated boundary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-multipart-request-"))
    const name = "multipart-request"
    const fileBytes = new Uint8Array([0x00, 0x41, 0x80, 0xff])
    const received: Array<{ note: FormDataEntryValue | null; password: FormDataEntryValue | null; file: File }> = []
    using server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const form = await request.formData()
        received.push({
          note: form.get("note"),
          password: form.get("password"),
          file: form.get("upload") as File,
        })
        return new Response("accepted")
      },
    })
    const url = `http://127.0.0.1:${server.port}/form`
    const submit = () =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const form = new FormData()
        form.append("note", "visible")
        form.append("note", "second")
        form.append("password", "must-not-be-recorded")
        form.append(
          "upload",
          new File([fileBytes], "payload.bin", { type: "application/octet-stream", lastModified: 1234 }),
        )
        const request = HttpClientRequest.post(url).pipe(HttpClientRequest.bodyFormData(form))
        return yield* (yield* http.execute(request)).text
      })

    expect(
      await Effect.runPromise(
        submit().pipe(Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record" }))),
      ),
    ).toBe("accepted")
    expect(received).toHaveLength(1)
    expect(received[0]?.note).toBe("visible")
    expect(received[0]?.password).toBe("must-not-be-recorded")
    expect(new Uint8Array(await received[0]!.file.arrayBuffer())).toEqual(fileBytes)

    const cassette = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), "utf8"))
    const snapshot = cassette.interactions[0].request
    expect(snapshot.headers["content-type"]).toBe("multipart/form-data")
    expect(snapshot.bodyEncoding).toBe("multipart")
    expect(JSON.parse(snapshot.body)).toEqual({
      entries: [
        { note: { kind: "text", value: "visible" } },
        { note: { kind: "text", value: "second" } },
        { password: "[REDACTED]" },
        {
          upload: {
            kind: "file",
            name: "payload.bin",
            type: "application/octet-stream",
            body: Buffer.from(fileBytes).toString("base64"),
            bodyEncoding: "base64",
          },
        },
      ],
    })
    expect(fs.readFileSync(path.join(directory, `${name}.json`), "utf8")).not.toContain("must-not-be-recorded")

    await server.stop()
    expect(await Effect.runPromise(submit().pipe(Effect.provide(HttpRecorder.http(name, { directory }))))).toBe(
      "accepted",
    )
    expect(received).toHaveLength(1)
  })

  test("rejects oversized request bodies before contacting the upstream service", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-request-limit-"))
    const name = "request-limit"
    let hits = 0
    using server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return new Response("unexpected")
      },
    })
    const program = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return yield* http.execute(
        HttpClientRequest.post(`http://127.0.0.1:${server.port}/upload`, {
          body: HttpBody.text("12345", "text/plain"),
        }),
      )
    })

    const exit = await Effect.runPromise(
      Effect.exit(
        program.pipe(
          Effect.provide(
            HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record", maxRequestBodyBytes: 4 }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureText(exit)).toContain("request body exceeds maxRequestBodyBytes (4 bytes)")
    expect(hits).toBe(0)
    expect(fs.existsSync(path.join(directory, `${name}.json`))).toBe(false)
  })

  test("rejects request bodies that disagree with their declared content length", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-content-length-"))
    let hits = 0
    using server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1
        return new Response("unexpected")
      },
    })
    const program = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const request = HttpClientRequest.post(`http://127.0.0.1:${server.port}/upload`, {
        body: HttpBody.raw(new Uint8Array([1, 2, 3]), {
          contentType: "application/octet-stream",
          contentLength: 9,
        }),
      })
      return yield* http.execute(request)
    })

    const exit = await Effect.runPromise(
      Effect.exit(
        program.pipe(
          Effect.provide(HttpRecorderInternal.cassetteLayer("content-length", { directory, mode: "record" })),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureText(exit)).toContain("request body does not match its declared content-length")
    expect(hits).toBe(0)
  })

  test("cancels a blocked one-shot body reader when the recording fiber is interrupted", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-request-interrupt-"))
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let cancellations = 0
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([1]))
          return
        }
        started.resolve()
        return release.promise
      },
      cancel() {
        cancellations += 1
        release.resolve()
      },
    })
    const request = HttpClientRequest.post("https://unreachable.test/upload", {
      body: HttpBody.raw(stream, { contentType: "application/octet-stream" }),
    })
    const program = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return yield* http.execute(request)
    }).pipe(Effect.provide(HttpRecorderInternal.cassetteLayer("interrupted-request", { directory, mode: "record" })))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* program.pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(cancellations).toBe(1)
    expect(fs.existsSync(path.join(directory, "interrupted-request.json"))).toBe(false)
  })

  test("does not persist interrupted requests as synthetic transport failures", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-upstream-interrupt-"))
    const firstStarted = Promise.withResolvers<void>()
    const secondStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<Response>()
    using server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/first") {
          firstStarted.resolve()
          request.signal.addEventListener("abort", () => releaseFirst.resolve(new Response("aborted")), { once: true })
          return releaseFirst.promise
        }
        secondStarted.resolve()
        return new Response("second")
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const executeText = (path: string) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        return yield* (yield* http.execute(HttpClientRequest.get(`${origin}${path}`))).text
      })

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* executeText("/first").pipe(Effect.forkChild)
        yield* Effect.promise(() => firstStarted.promise)
        const second = yield* executeText("/second").pipe(Effect.forkChild)
        yield* Effect.promise(() => secondStarted.promise)
        yield* Fiber.interrupt(first)
        releaseFirst.resolve(new Response("released"))
        expect(yield* Fiber.join(second)).toBe("second")
      }).pipe(Effect.provide(HttpRecorderInternal.cassetteLayer("upstream-interrupt", { directory, mode: "record" }))),
    )

    const cassette = JSON.parse(fs.readFileSync(path.join(directory, "upstream-interrupt.json"), "utf8"))
    expect(cassette.interactions).toHaveLength(1)
    expect(cassette.interactions[0].request.url).toBe(`${origin}/second`)
    expect(cassette.interactions[0].response.body).toBe("second")
    expect(cassette.interactions[0].error).toBeUndefined()
  })

  test("records and deterministically replays upstream transport failures", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-transport-failure-"))
    const name = "transport-failure"
    using server = Bun.serve({ port: 0, fetch: () => new Response("must not be reached") })
    const url = `http://127.0.0.1:${server.port}/unreachable`
    await server.stop()
    const requestFailure = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return yield* Effect.exit(http.execute(HttpClientRequest.get(url)))
    })

    const recorded = await Effect.runPromise(
      requestFailure.pipe(Effect.provide(HttpRecorderInternal.cassetteLayer(name, { directory, mode: "record" }))),
    )
    expect(Exit.isFailure(recorded)).toBe(true)
    const cassette = JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), "utf8"))
    expect(cassette.interactions).toEqual([
      {
        transport: "http",
        request: { method: "GET", url, headers: {}, body: "" },
        error: { kind: "transport", description: "Recorded upstream transport failure" },
      },
    ])

    const replayed = await Effect.runPromise(
      requestFailure.pipe(Effect.provide(HttpRecorder.http(name, { directory }))),
    )
    expect(Exit.isFailure(replayed)).toBe(true)
    expect(failureText(replayed)).toContain("Recorded upstream transport failure")
    expect(failureText(replayed)).not.toContain("ECONNREFUSED")
  })

  test("rejects recognizable secrets hidden inside base64 request snapshots", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-binary-secret-"))
    const secret = "sk-123456789012345678901234"
    let hits = 0
    using server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        hits += 1
        expect(await request.text()).toBe(secret)
        return new Response("received")
      },
    })
    const program = Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const request = HttpClientRequest.post(`http://127.0.0.1:${server.port}/binary`, {
        body: HttpBody.uint8Array(new TextEncoder().encode(secret), "application/octet-stream"),
      })
      return yield* (yield* http.execute(request)).text
    })

    const exit = await Effect.runPromise(
      Effect.exit(
        program.pipe(
          Effect.provide(HttpRecorderInternal.cassetteLayer("binary-secret", { directory, mode: "record" })),
        ),
      ),
    )
    const message = failureText(exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(hits).toBe(1)
    expect(message).toContain("body(decoded) (API key)")
    expect(message).not.toContain(secret)
    expect(fs.existsSync(path.join(directory, "binary-secret.json"))).toBe(false)
  })

  test("UnsafeCassetteError fails the request when a recording would write a known secret", async () => {
    using server = Bun.serve({ port: 0, fetch: () => new Response("Bearer abcdefghijklmnopqrstuvwxyz1234") })
    const url = `http://127.0.0.1:${server.port}/leaky`
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-unsafe-"))

    const exit = await Effect.runPromise(
      Effect.exit(
        post(url, { ok: true }).pipe(
          Effect.provide(HttpRecorderInternal.cassetteLayer("unsafe-record", { directory, mode: "record" })),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failureText(exit)).toContain("contains possible secrets")
    expect(fs.existsSync(path.join(directory, "unsafe-record.json"))).toBe(false)
  })

  test("failed memory appends leave cassette state unchanged", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        const interaction: Interaction = {
          transport: "http",
          request: { method: "GET", url: "https://example.test", headers: {}, body: "" },
          response: { status: 200, headers: {}, body: "safe" },
        }
        yield* cassette.append("transactional", interaction)
        yield* cassette
          .append("transactional", {
            ...interaction,
            response: { ...interaction.response, body: "Bearer abcdefghijklmnopqrstuvwxyz1234" },
          })
          .pipe(Effect.flip)

        expect(yield* cassette.read("transactional")).toEqual([interaction])
      }).pipe(Effect.provide(HttpRecorderInternal.Cassette.memory())),
    )
  })

  test("concurrent file appends preserve every interaction", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-concurrent-"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        yield* Effect.forEach(
          Array.from({ length: 20 }, (_, index) => index),
          (index) =>
            cassette.append("concurrent", {
              transport: "http",
              request: { method: "GET", url: `https://example.test/${index}`, headers: {}, body: "" },
              response: { status: 200, headers: {}, body: String(index) },
            }),
          { concurrency: "unbounded" },
        )
      }).pipe(
        Effect.provide(HttpRecorderInternal.Cassette.fileSystem({ directory })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )

    const cassette = JSON.parse(fs.readFileSync(path.join(directory, "concurrent.json"), "utf8"))
    expect(cassette.interactions).toHaveLength(20)
    expect(fs.readdirSync(directory).filter((file) => file.endsWith(".tmp"))).toEqual([])
  })

  test("rejects cassette paths outside the recordings directory", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-path-"))
    expect(() => HttpRecorderInternal.hasCassetteSync("../outside", { directory })).toThrow("Invalid cassette name")
    expect(() => HttpRecorderInternal.hasCassetteSync("C:\\outside", { directory })).toThrow("Invalid cassette name")
  })

  test("Cassette.list enumerates recorded cassette names", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "http-recorder-list-"))
    await seedCassetteDirectory(directory, "alpha/one", [
      {
        transport: "http",
        request: { method: "GET", url: "https://x.test/a", headers: {}, body: "" },
        response: { status: 200, headers: {}, body: "a" },
      },
    ])
    await seedCassetteDirectory(directory, "beta", [
      {
        transport: "http",
        request: { method: "GET", url: "https://x.test/b", headers: {}, body: "" },
        response: { status: 200, headers: {}, body: "b" },
      },
    ])

    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const cassette = yield* HttpRecorderInternal.Cassette.Service
        return yield* cassette.list()
      }).pipe(
        Effect.provide(HttpRecorderInternal.Cassette.fileSystem({ directory })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(names).toEqual(["alpha/one", "beta"])
  })
})
