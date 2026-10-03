import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, expect, it } from "bun:test"
import {
  createExternalApiActionClient,
  createMemoryExternalApiActionJournal,
  ExternalApiAlreadySettledError,
  ExternalApiRecoveryRequiredError,
  ExternalApiValidationError,
  redactExternalText,
  type ExternalApiActionReceipt,
} from "@arforge-ai/core/runtime/external-api-action"

type RequestRecord = Readonly<{
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage["headers"]
  readonly body: string
}>

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

const createLocalServer = async (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) => {
  const requests: RequestRecord[] = []
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request)
    requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body })
    await handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("local test server did not expose a port")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

const captureError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

const policy = (origin: string) => ({
  allowedSchemes: ["http"] as const,
  allowedHosts: [new URL(origin).hostname],
  allowedMethods: ["GET", "POST"],
  maxRedirects: 2,
})

describe("External API Action", () => {
  it("enforces allowlists, injects scoped secrets, sends idempotency, and settles with canonical digests", async () => {
    const server = await createLocalServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ settled: true, owner: "alice@example.com" }))
    })
    try {
      const journal = createMemoryExternalApiActionJournal()
      const client = createExternalApiActionClient({
        policy: policy(server.origin),
        journal,
        resolveSecret: (ref) => (ref.name === "provider-token" ? "super-secret-token" : undefined),
      })
      const result = await client.execute({
        operationID: "op_publish_1",
        method: "POST",
        url: `${server.origin}/publish?z=last&a=first`,
        headers: { "content-type": "application/json" },
        body: '{"value":"frozen"}',
        secretHeaders: [{ header: "Authorization", name: "provider-token", scope: "share-provider" }],
        idempotencyKey: "idem_publish_1",
        operationClass: "non-idempotent-write",
        allowedResponseContentTypes: ["application/json"],
        verify: (response) => JSON.parse(new TextDecoder().decode(response.body)).settled === true,
      })

      expect(result.response.status).toBe(200)
      expect(result.receipt.state).toBe("settled")
      expect(result.receipt.requestDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(result.receipt).not.toHaveProperty("url")
      expect(server.requests[0]?.headers.authorization).toBe("super-secret-token")
      expect(server.requests[0]?.headers["idempotency-key"]).toBe("idem_publish_1")
      expect(server.requests[0]?.body).toBe('{"value":"frozen"}')
      const serialised = JSON.stringify(await journal.load())
      expect(serialised).not.toContain("super-secret-token")
      expect(serialised).not.toContain("alice@example.com")
    } finally {
      await server.close()
    }
  })

  it("revalidates redirects and never forwards a scoped secret to another origin", async () => {
    const server = await createLocalServer(async (request, response) => {
      response.writeHead(302, {
        location: request.url?.includes("scope") ? "http://localhost:1/blocked" : "http://evil.invalid/blocked",
      })
      response.end()
    })
    try {
      const client = createExternalApiActionClient({
        policy: { ...policy(server.origin), allowedHosts: ["127.0.0.1", "localhost"] },
        resolveSecret: () => "redirect-secret",
      })
      const policyError = await captureError(
        client.execute({
          operationID: "op_redirect_1",
          method: "GET",
          url: `${server.origin}/redirect`,
          idempotencyKey: "idem_redirect_1",
        }),
      )
      expect(policyError).toMatchObject({ code: "EXTERNAL_API_POLICY_BLOCKED" })

      const secretScopeError = await captureError(
        client.execute({
          operationID: "op_redirect_2",
          method: "GET",
          url: `${server.origin}/scope`,
          secretHeaders: [{ header: "Authorization", name: "token", scope: "test" }],
          idempotencyKey: "idem_redirect_2",
        }),
      )
      expect(secretScopeError).toMatchObject({ code: "EXTERNAL_API_SECRET_SCOPE" })
      expect(server.requests).toHaveLength(2)
    } finally {
      await server.close()
    }
  })

  it("bounds response bytes and content types without exposing response data", async () => {
    const server = await createLocalServer(async (request, response) => {
      response.writeHead(200, { "content-type": request.url?.includes("type") ? "text/plain" : "application/json" })
      response.end(request.url?.includes("type") ? "plain" : "0123456789")
    })
    try {
      const client = createExternalApiActionClient({ policy: policy(server.origin) })
      const tooLarge = await captureError(
        client.execute({
          operationID: "op_limit_1",
          method: "GET",
          url: `${server.origin}/large`,
          idempotencyKey: "idem_limit_1",
          maxResponseBytes: 4,
          allowedResponseContentTypes: ["application/json"],
        }),
      )
      expect(tooLarge).toMatchObject({ code: "EXTERNAL_API_RESPONSE_LIMIT", receipt: { state: "blocked" } })

      const wrongType = await captureError(
        client.execute({
          operationID: "op_type_1",
          method: "GET",
          url: `${server.origin}/type`,
          idempotencyKey: "idem_type_1",
          maxResponseBytes: 128,
          allowedResponseContentTypes: ["application/json"],
        }),
      )
      expect(wrongType).toMatchObject({ code: "EXTERNAL_API_CONTENT_TYPE_BLOCKED", receipt: { state: "blocked" } })
    } finally {
      await server.close()
    }
  })

  it("requires a read-after-write verifier and refuses hidden non-idempotent retries", async () => {
    let calls = 0
    const server = await createLocalServer(async (_request, response) => {
      calls += 1
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"accepted":true}')
    })
    try {
      const client = createExternalApiActionClient({ policy: policy(server.origin) })
      const recovery = await captureError(
        client.execute({
          operationID: "op_write_1",
          method: "POST",
          url: `${server.origin}/write`,
          idempotencyKey: "idem_write_1",
          operationClass: "non-idempotent-write",
          allowedResponseContentTypes: ["application/json"],
        }),
      )
      expect(recovery).toBeInstanceOf(ExternalApiRecoveryRequiredError)
      expect(recovery).toMatchObject({
        receipt: { state: "recovery_required", errorCode: "EXTERNAL_API_VERIFIER_REQUIRED" },
      })
      expect(calls).toBe(1)

      const noRetry = await captureError(
        client.execute({
          operationID: "op_write_2",
          method: "POST",
          url: `${server.origin}/write`,
          idempotencyKey: "idem_write_2",
          operationClass: "non-idempotent-write",
          retry: { maxAttempts: 3 },
        }),
      )
      expect(noRetry).toBeInstanceOf(ExternalApiValidationError)
      expect(calls).toBe(1)
    } finally {
      await server.close()
    }
  })

  it("only retries a non-idempotent transport failure after lookup reports missing", async () => {
    let attempts = 0
    let lookups = 0
    const client = createExternalApiActionClient({
      policy: { allowedSchemes: ["http"], allowedHosts: ["api.test"], allowedMethods: ["POST"] },
      fetch: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("network request failed")
        return new Response('{"settled":true}', { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    const result = await client.execute({
      operationID: "op_lookup_1",
      method: "POST",
      url: "http://api.test/write",
      idempotencyKey: "idem_lookup_1",
      operationClass: "non-idempotent-write",
      retry: {
        maxAttempts: 2,
        lookup: () => {
          lookups += 1
          return "missing"
        },
      },
      verify: (response) => response.status === 200,
    })
    expect(result.receipt.attemptCount).toBe(2)
    expect(attempts).toBe(2)
    expect(lookups).toBe(1)
  })

  it("fails closed across a cold client when the same operation already settled", async () => {
    let calls = 0
    const journal = createMemoryExternalApiActionJournal()
    const request = {
      operationID: "op_cold_settled_1",
      method: "POST",
      url: "http://api.test/publish",
      idempotencyKey: "idem_cold_settled_1",
      operationClass: "non-idempotent-write" as const,
      verify: (response: { readonly status: number }) => response.status === 200,
    }
    const first = createExternalApiActionClient({
      policy: { allowedSchemes: ["http"], allowedHosts: ["api.test"], allowedMethods: ["POST"] },
      journal,
      fetch: async () => {
        calls += 1
        return new Response('{"settled":true}', { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    const completed = await first.execute(request)

    const cold = createExternalApiActionClient({
      policy: { allowedSchemes: ["http"], allowedHosts: ["api.test"], allowedMethods: ["POST"] },
      journal,
      fetch: async () => {
        calls += 1
        throw new Error("must not repeat a settled side effect")
      },
    })
    const replay = await captureError(cold.execute(request))
    expect(replay).toBeInstanceOf(ExternalApiAlreadySettledError)
    expect(replay).toMatchObject({
      code: "EXTERNAL_API_ALREADY_SETTLED",
      receipt: { actionID: completed.receipt.actionID, operationID: request.operationID, state: "settled" },
    })
    expect(calls).toBe(1)
  })

  it("fails closed across a cold client when the prior external outcome is unknown", async () => {
    const records: ExternalApiActionReceipt[] = []
    const journal = {
      append: async (receipt: (typeof records)[number]) => {
        // Simulate a process crash after the side-effect attempt: proposed and
        // executing are durable, but the recovery_required receipt is lost.
        if (records.length < 2) records.push(receipt)
      },
      load: async () => [...records],
    }
    let calls = 0
    const request = {
      operationID: "op_cold_unknown_1",
      method: "POST",
      url: "http://api.test/publish",
      idempotencyKey: "idem_cold_unknown_1",
      operationClass: "non-idempotent-write" as const,
      body: "unknown",
    }
    const crashed = createExternalApiActionClient({
      policy: { allowedSchemes: ["http"], allowedHosts: ["api.test"], allowedMethods: ["POST"] },
      journal,
      fetch: async () => {
        calls += 1
        throw new Error("simulated process loss after request dispatch")
      },
    })
    await captureError(crashed.execute(request))

    const cold = createExternalApiActionClient({
      policy: { allowedSchemes: ["http"], allowedHosts: ["api.test"], allowedMethods: ["POST"] },
      journal,
      fetch: async () => {
        calls += 1
        throw new Error("must not execute while outcome is unknown")
      },
    })
    const result = await captureError(cold.execute(request))
    expect(result).toBeInstanceOf(ExternalApiRecoveryRequiredError)
    expect(result).toMatchObject({
      code: "EXTERNAL_API_RECOVERY_REQUIRED",
      receipt: { operationID: request.operationID, idempotencyKey: request.idempotencyKey, state: "executing" },
    })
    expect(calls).toBe(1)
  })

  it("redacts secret, bearer, query-token, and email material in diagnostics", () => {
    const redacted = redactExternalText(
      "Bearer bearer-secret email alice@example.com https://example.test/?token=query-secret",
      ["bearer-secret", "query-secret"],
    )
    expect(redacted).not.toContain("bearer-secret")
    expect(redacted).not.toContain("alice@example.com")
    expect(redacted).not.toContain("query-secret")
    expect(redacted).toContain("[REDACTED]")
  })
})
