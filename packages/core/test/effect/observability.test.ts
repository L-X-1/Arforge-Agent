import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Logger } from "effect"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import { resource, tracingLayer } from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const arforgeClient = process.env.ARFORGE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (arforgeClient === undefined) delete process.env.ARFORGE_CLIENT
  else process.env.ARFORGE_CLIENT = arforgeClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=arforge-labs,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "arforge-labs",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=arforge-labs,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["arforge.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.ARFORGE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "arforge.client=web,service.instance.id=override,service.namespace=arforge-labs"

    expect(resource().attributes).toMatchObject({
      "arforge.client": "cli",
      "service.namespace": "arforge-labs",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["arforge.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "arforge.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("exports a trace span through the configured OTLP endpoint", async () => {
  const requests: Array<{ readonly url: string | undefined; readonly body: string }> = []
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.on("end", () => {
      requests.push({ url: request.url, body: Buffer.concat(chunks).toString("utf8") })
      response.statusCode = 200
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("OTLP smoke server did not expose a port")
    const layer = await tracingLayer({ endpoint: `http://127.0.0.1:${address.port}` })
    await Effect.void.pipe(
      Effect.withSpan("Arforge.OtlpSmoke", {
        attributes: {
          "arforge.run_id": "smoke-run",
          "arforge.request_digest": "smoke-digest",
          "arforge.prompt_text": "do-not-export-prompt",
          apiKey: "do-not-export-key",
        },
      }),
      Effect.provide(layer),
      Effect.scoped,
      Effect.runPromise,
    )
    const traceBodies = requests.filter((request) => request.url === "/v1/traces").map((request) => request.body)
    expect(traceBodies.some((body) => body.length > 0)).toBe(true)
    expect(traceBodies.join("\n")).not.toContain("do-not-export-prompt")
    expect(traceBodies.join("\n")).not.toContain("do-not-export-key")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "arforge.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})
