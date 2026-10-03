import { describe, expect, it } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as CodeRetrieval from "@arforge-ai/core/code-retrieval"
import * as Evidence from "@arforge-ai/core/evidence"
import * as SourceRegistry from "@arforge-ai/core/source-registry"
import { Egress } from "@arforge-ai/core/egress"
import { RuntimeEmbedding } from "@arforge-ai/core/runtime"

const digest = "sha256:" + "f".repeat(64)

const source = (id: string, path: string) =>
  SourceRegistry.make({
    sourceID: id,
    type: "file",
    owner: "project",
    projectID: "project-1",
    location: path,
    trust: "verified",
    instructionAllowed: false,
    sensitivity: "internal",
    freshness: { observedAt: 1_725_000_000_000, expiresAt: 1_725_086_400_000 },
    limits: { maxBytes: 100_000, maxTokens: 10_000 },
    provenance: { locator: path, digest },
    redactionPolicy: { mode: "secrets", fields: ["token"] },
    retrievalAdapter: "filesystem",
  })

describe("CodeRetrieval", () => {
  it("returns explainable lexical, semantic, structure, freshness, and fingerprint signals", async () => {
    const documents = [
      {
        source: source("file:retrieval/compiler", "src/compiler.ts"),
        path: "src/compiler.ts",
        text: "export function compileContext(input: string) { return input }",
        updatedAt: Date.now(),
        structure: [{ kind: "definition", name: "compileContext", line: 1 } as const],
        evidenceID: AgentRuntime.EvidenceID.make("evd_compiler"),
      },
      {
        source: source("file:retrieval/router", "src/router.ts"),
        path: "src/router.ts",
        text: "export function routeModel() { return 'router' }",
        updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 90,
      },
    ]
    const hits = await CodeRetrieval.retrieve({ text: "compileContext", limit: 5, embedding: "hashing" }, documents)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe("src/compiler.ts")
    expect(hits[0]?.lexicalScore).toBe(1)
    expect(hits[0]?.semanticBackend).toBe("hashing")
    expect(hits[0]?.structureScore).toBe(1)
    expect(hits[0]?.freshnessScore).toBeGreaterThan(0)
    expect(hits[0]?.fingerprint).toHaveLength(64)
    expect(String(hits[0]?.evidenceID)).toBe("evd_compiler")
  })

  it("uses Source Adapter output as the bounded retrieval document", async () => {
    const document = CodeRetrieval.fromAdapter(
      {
        sourceID: "file:retrieval/readme",
        adapter: "filesystem",
        text: "Context Package evidence",
        contentDigest: "a".repeat(64),
        sourceDigest: digest,
        byteLength: 25,
        tokenEstimate: 6,
        truncated: false,
        evidence: Evidence.create({
          evidenceID: AgentRuntime.EvidenceID.make("evd_readme"),
          sourceID: "file:retrieval/readme",
          contentDigest: "a".repeat(64),
          extractionMethod: "test",
          extractionVersion: "v1",
          trust: "verified",
          instructionAllowed: false,
          sensitivity: "internal",
          summary: "README",
        }),
      },
      source("file:retrieval/readme", "README.md"),
      Date.now(),
    )
    const hits = await CodeRetrieval.retrieve({ text: "Context Package" }, [document])
    expect(hits[0]?.path).toBe("README.md")
    expect(String(hits[0]?.evidenceID)).toBe("evd_readme")
  })

  it("uses the bound embedding transport when explicitly allowed and falls back without network when rejected", async () => {
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
      const binding = RuntimeEmbedding.makeRequestBinding({
        principal: { tenantID: "ten_test", userID: "usr_test" },
        workspaceID: "workspace:test",
        dataScope: "code:test",
        origin,
        method: "POST",
        model: "fixture",
        credentialIdentity: "fixture-key",
        consent: true,
      })
      const remote = {
        baseUrl: origin,
        model: "fixture",
        credential: { name: "fixture-key", resolve: async () => "fixture-secret" },
        credentialScope: ["embedding:test"],
        consent: true,
        binding,
        egress: Egress.make({
          action: "code-retrieval-embedding-test",
          networkScope: [origin],
          secretScope: ["embedding:test"],
          allowedMethods: ["POST"],
          grantedResources: ["*"],
        }),
      } satisfies RuntimeEmbedding.RemoteRequest
      const documents = [
        {
          source: source("file:retrieval/allowed", "src/allowed.ts"),
          path: "src/allowed.ts",
          text: "export function compileContext(input: string) { return input }",
          updatedAt: Date.now(),
        },
      ]
      const allowed = await CodeRetrieval.retrieve(
        { text: "compileContext", limit: 5, embedding: "configured", embeddingRequest: remote },
        documents,
      )
      expect(allowed[0]?.semanticBackend).toBe("api")
      expect(calls).toBe(1)

      const wrongOwner = await CodeRetrieval.retrieve(
        {
          text: "compileContext",
          limit: 5,
          embedding: "configured",
          embeddingRequest: remote,
          embeddingExpectedBinding: {
            principal: { tenantID: "ten_other", userID: "usr_other" },
            workspaceID: binding.workspaceID,
            dataScope: binding.dataScope,
          },
        },
        documents,
      )
      expect(wrongOwner[0]?.semanticBackend).toBe("hashing")
      expect(calls).toBe(1)

      const rejected = await CodeRetrieval.retrieve(
        {
          text: "compileContext",
          limit: 5,
          embedding: "configured",
          embeddingRequest: {
            ...remote,
            binding: RuntimeEmbedding.makeRequestBinding({ ...binding, origin: "http://127.0.0.1:1" }),
          },
        },
        documents,
      )
      expect(rejected[0]?.semanticBackend).toBe("hashing")
      expect(calls).toBe(1)
    } finally {
      await server.stop(true)
      if (previous === undefined) delete process.env.ARFORGE_EMBED_BACKEND
      else process.env.ARFORGE_EMBED_BACKEND = previous
    }
  })

  it("fails closed on empty, cancelled, and expired queries", async () => {
    const reject = async (promise: Promise<unknown>) => {
      try {
        await promise
        return new Error("expected rejection")
      } catch (error) {
        return error
      }
    }
    expect(await reject(CodeRetrieval.retrieve({ text: " " }, []))).toMatchObject({ category: "invalid" })
    const controller = new AbortController()
    controller.abort()
    expect(await reject(CodeRetrieval.retrieve({ text: "context", signal: controller.signal }, []))).toMatchObject({
      category: "cancelled",
    })
    expect(await reject(CodeRetrieval.retrieve({ text: "context", deadlineAt: Date.now() - 1 }, []))).toMatchObject({
      category: "deadline",
    })
  })
})
