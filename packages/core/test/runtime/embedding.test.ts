import { describe, expect, it } from "bun:test"
import {
  embedBatch,
  makeRequestBinding,
  makeSecretBackedRemoteRequest,
  similarity,
  vectorForTerms,
  vectorForText,
} from "@arforge-ai/core/runtime/embedding"
import { Egress } from "@arforge-ai/core/egress"
import { EmbeddingError } from "@arforge-ai/core/runtime/embedding"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { Effect } from "effect"

const requestBinding = (
  origin: string,
  options: { readonly credentialIdentity?: string; readonly model?: string; readonly consent?: boolean } = {},
) =>
  makeRequestBinding({
    principal: { tenantID: "ten_test", userID: "usr_test" },
    workspaceID: "workspace:test",
    dataScope: "embedding:test",
    origin,
    method: "POST",
    model: options.model ?? "fixture",
    credentialIdentity: options.credentialIdentity,
    consent: options.consent ?? true,
  })

describe("RuntimeEmbedding", () => {
  it("freezes the request binding and its principal", () => {
    const binding = requestBinding("https://embedding.example")
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.principal)).toBe(true)
  })

  it("produces deterministic feature vectors for terms", () => {
    const left = vectorForTerms(["cache", "resolver"])
    const right = vectorForTerms(["cache", "resolver"])
    expect(left).toEqual(right)
    expect(left.length).toBe(256)
  })

  it("ranks related text above unrelated text with hashing", async () => {
    const query = "修复缓存失效问题"
    const related = "cache invalidation bug fix"
    const unrelated = "pizza delivery scheduling"
    const batch = await embedBatch(query, [related, unrelated])
    expect(batch.backend).toBe("hashing")
    expect(similarity(batch.query, batch.documents[0])).toBeGreaterThan(similarity(batch.query, batch.documents[1]))
  })

  it("derives term vectors via char n-gram feature hashing", () => {
    const vector = vectorForText("hello world")
    expect(vector.length).toBe(256)
    const same = vectorForText("hello world")
    expect(vector).toEqual(same)
  })

  it("defaults to hashing when the API backend is not configured", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    delete process.env.EMBED_API_KEY
    const batch = await embedBatch("q", ["d"])
    expect(batch.backend).toBe("hashing")
    if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
    else process.env.ARFORGE_EMBED_BACKEND = previous
  })

  it("does not send configured content without explicit consent and Egress", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return Response.json({ data: [] })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const result = await embedBatch("secret query", ["secret document"], {
        remote: {
          baseUrl: `${origin}?api_key=api-key-secret`,
          model: "fixture",
          credentialScope: ["embedding:test"],
          consent: true,
          binding: requestBinding(origin),
          egress: Egress.deny("embedding consent is required"),
        },
      })
      expect(result).toMatchObject({
        backend: "hashing",
        localOnly: true,
        egress: "denied",
        fallbackReason: "remote-not-authorized",
      })
      expect(calls).toBe(0)
      const audit = RuntimeInsight.auditList(1000).entries.find(
        (entry) => entry.action === "embedding.egress" && entry.resource === origin,
      )
      expect(audit?.metadata).toMatchObject({ egress: "denied", localOnly: true, transportStarted: false })
      expect(JSON.stringify(audit)).not.toContain("api-key-secret")
      expect(JSON.stringify(audit)).not.toContain("secret query")
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("uses an authorized remote model with bounded JSON and reports external fact", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let calls = 0
    let authorization = ""
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        calls++
        authorization = request.headers.get("authorization") ?? ""
        return Response.json({
          data: [{ embedding: [1, 0, 0] }, { embedding: [1, 0, 0] }],
        })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const result = await embedBatch("query", ["document"], {
        remote: {
          baseUrl: origin,
          model: "fixture",
          credential: { name: "fixture-key", resolve: async () => "fixture-secret" },
          credentialScope: ["embedding:test"],
          consent: true,
          binding: requestBinding(origin, { credentialIdentity: "fixture-key" }),
          egress: Egress.make({
            action: "embedding-test",
            networkScope: [origin],
            secretScope: ["embedding:test"],
            allowedMethods: ["POST"],
            grantedResources: ["*"],
          }),
        },
      })
      expect(result).toMatchObject({ backend: "api", localOnly: false, egress: "sent" })
      expect(result.query).toEqual(new Float64Array([1, 0, 0]))
      expect(result.documents).toHaveLength(1)
      expect(calls).toBe(1)
      expect(authorization).toBe("Bearer fixture-secret")
      const audit = RuntimeInsight.auditList(1000).entries.find(
        (entry) => entry.action === "embedding.egress" && entry.resource === origin,
      )
      expect(audit?.metadata).toMatchObject({
        configuredBackend: "api",
        resultBackend: "api",
        egress: "sent",
        localOnly: false,
        transportStarted: true,
        textCount: 2,
      })
      expect(audit?.metadata.bindingDigest).toEqual(expect.any(String))
      expect(JSON.stringify(audit)).not.toContain("fixture-secret")
      expect(JSON.stringify(audit)).not.toContain("query")
      expect(RuntimeInsight.auditVerify().valid).toBe(true)
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("fails closed when the immutable request binding drifts from the target", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const result = await embedBatch("query", ["document"], {
        remote: {
          baseUrl: origin,
          model: "fixture",
          credential: { name: "fixture-key", resolve: async () => "fixture-secret" },
          credentialScope: ["embedding:test"],
          consent: true,
          binding: requestBinding("http://127.0.0.1:1", { credentialIdentity: "fixture-key" }),
          egress: Egress.make({
            action: "embedding-binding-test",
            networkScope: [origin],
            secretScope: ["embedding:test"],
            allowedMethods: ["POST"],
            grantedResources: ["*"],
          }),
        },
      })
      expect(result).toMatchObject({
        backend: "hashing",
        localOnly: true,
        egress: "denied",
        fallbackReason: "remote-not-authorized",
      })
      expect(calls).toBe(0)
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("fails closed when model, credential identity, or consent drifts", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const base = {
        baseUrl: origin,
        model: "fixture",
        credential: { name: "fixture-key", resolve: async () => "fixture-secret" },
        credentialScope: ["embedding:test"],
        consent: true,
        egress: Egress.make({
          action: "embedding-binding-test",
          networkScope: [origin],
          secretScope: ["embedding:test"],
          allowedMethods: ["POST"],
          grantedResources: ["*"],
        }),
      }
      const bindings = [
        requestBinding(origin, { model: "another-model", credentialIdentity: "fixture-key" }),
        requestBinding(origin, { credentialIdentity: "another-key" }),
        requestBinding(origin, { credentialIdentity: "fixture-key", consent: false }),
      ]
      for (const binding of bindings) {
        const result = await embedBatch("query", ["document"], { remote: { ...base, binding } })
        expect(result).toMatchObject({ backend: "hashing", localOnly: true, egress: "denied" })
      }
      expect(calls).toBe(0)
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("keeps external risk after a remote failure and never labels fallback local-only", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++
        return new Response("upstream unavailable", { status: 503 })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const result = await embedBatch("query", ["document"], {
        remote: {
          baseUrl: origin,
          model: "fixture",
          credential: { name: "fixture-key", resolve: async () => "fixture-secret" },
          credentialScope: [],
          consent: true,
          binding: requestBinding(origin, { credentialIdentity: "fixture-key" }),
          egress: Egress.make({
            action: "embedding-test",
            networkScope: [origin],
            secretScope: [],
            allowedMethods: ["POST"],
            grantedResources: ["*"],
          }),
        },
      })
      expect(result).toMatchObject({
        backend: "hashing",
        localOnly: false,
        egress: "sent",
        fallbackReason: "remote-failed",
      })
      expect(calls).toBe(1)
      const audit = RuntimeInsight.auditList(1000).entries.find(
        (entry) => entry.action === "embedding.egress" && entry.resource === origin,
      )
      expect(audit?.metadata).toMatchObject({ egress: "sent", localOnly: false, transportStarted: true })
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("reports unknown external state when an in-flight transport is cancelled", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    const controller = new AbortController()
    let calls = 0
    let resolveStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls++
        resolveStarted?.()
        await new Promise((resolve) => setTimeout(resolve, 250))
        return Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const pending = embedBatch("query", ["document"], {
        signal: controller.signal,
        remote: {
          baseUrl: origin,
          model: "fixture",
          credentialScope: [],
          consent: true,
          binding: requestBinding(origin),
          egress: Egress.make({
            action: "embedding-test",
            networkScope: [origin],
            secretScope: [],
            allowedMethods: ["POST"],
            grantedResources: ["*"],
          }),
        },
      })
      await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 500))])
      controller.abort()
      const result = await pending
      expect(result).toMatchObject({
        backend: "hashing",
        localOnly: false,
        egress: "unknown",
        fallbackReason: "remote-failed",
      })
      expect(calls).toBe(1)
      const audit = RuntimeInsight.auditList(1000).entries.find(
        (entry) => entry.action === "embedding.egress" && entry.resource === origin,
      )
      expect(audit?.metadata).toMatchObject({ egress: "unknown", localOnly: false, transportStarted: true })
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("rejects pre-cancelled remote work before transport", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    const controller = new AbortController()
    controller.abort()
    const exit = await embedBatch("query", ["document"], { signal: controller.signal }).catch((error) => error)
    expect(exit).toBeInstanceOf(EmbeddingError)
    if (exit instanceof EmbeddingError) expect(exit.category).toBe("cancelled")
    if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
    else process.env.ARFORGE_EMBED_BACKEND = previous
  })

  it("resolves a SecretProvider credential only after Egress authorization", async () => {
    const previousBackend = process.env.ARFORGE_EMBED_BACKEND
    const previousSecret = process.env.RUNTIME_EMBEDDING_TEST_KEY
    process.env.ARFORGE_EMBED_BACKEND = "api"
    process.env.RUNTIME_EMBEDDING_TEST_KEY = "provider-secret"
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        calls++
        expect(request.headers.get("authorization")).toBe("Bearer provider-secret")
        return Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1, 0] }] })
      },
    })
    try {
      const origin = `http://127.0.0.1:${server.port}`
      const request = await Effect.runPromise(
        makeSecretBackedRemoteRequest({
          baseUrl: origin,
          model: "fixture",
          secretName: "RUNTIME_EMBEDDING_TEST_KEY",
          credentialScope: ["embedding:test"],
          consent: true,
          binding: requestBinding(origin, { credentialIdentity: "RUNTIME_EMBEDDING_TEST_KEY" }),
          egress: Egress.make({
            action: "embedding-test",
            networkScope: [origin],
            secretScope: ["embedding:test"],
            allowedMethods: ["POST"],
            grantedResources: ["*"],
          }),
        }).pipe(
          Effect.provideService(SecretProvider.Service, SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(41))),
        ),
      )
      expect(JSON.stringify(request)).not.toContain("provider-secret")
      const result = await embedBatch("query", ["document"], { remote: request })
      expect(result).toMatchObject({ backend: "api", localOnly: false, egress: "sent" })
      expect(calls).toBe(1)
    } finally {
      await server.stop(true)
      if (previousBackend === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previousBackend
      if (previousSecret === undefined) delete process.env.RUNTIME_EMBEDDING_TEST_KEY
      else process.env.RUNTIME_EMBEDDING_TEST_KEY = previousSecret
    }
  })

  it("does not resolve a remote credential when Egress rejects the request", async () => {
    const previous = process.env.ARFORGE_EMBED_BACKEND
    process.env.ARFORGE_EMBED_BACKEND = "api"
    let resolved = 0
    try {
      const result = await embedBatch("query", ["document"], {
        remote: {
          baseUrl: "http://127.0.0.1:1",
          model: "fixture",
          credential: {
            name: "fixture-key",
            resolve: async () => {
              resolved++
              return "should-not-be-read"
            },
          },
          credentialScope: ["embedding:test"],
          consent: true,
          binding: requestBinding("http://127.0.0.1:1", { credentialIdentity: "fixture-key" }),
          egress: Egress.deny("test denial"),
        },
      })
      expect(result).toMatchObject({ backend: "hashing", localOnly: true, egress: "denied" })
      expect(resolved).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })
})
