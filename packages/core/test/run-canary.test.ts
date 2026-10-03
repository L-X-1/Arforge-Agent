import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { runCanary } from "../../../script/run-canary"

const root = resolve(import.meta.dir, "../../..")

async function expectRejected(action: () => Promise<unknown>, message: string) {
  try {
    await action()
  } catch (error) {
    expect(error instanceof Error).toBe(true)
    if (error instanceof Error) expect(error.message).toContain(message)
    return
  }
  throw new Error("expected canary action to reject: " + message)
}

async function withArtifact(callback: (artifactPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(root, "artifacts", "canary-test-"))
  const artifactPath = join(directory, "candidate.exe")
  try {
    await writeFile(artifactPath, "canary-artifact-fixture", "utf8")
    await callback(artifactPath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("canary records a passing receipt only for healthy JSON responses", async () => {
  await withArtifact(async (artifactPath) => {
    const requests: string[] = []
    const receipt = await runCanary({
      root,
      baseUrl: "https://staging.example.test",
      artifactPath,
      rollbackArtifactDigest: "b".repeat(64),
      cohortID: "staging-cohort-a",
      trafficPercent: 5,
      requests: 4,
      timeoutMs: 250,
      observationDelayMs: 0,
      fetchImpl: async (input, init) => {
        requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
        expect(init?.method).toBe("GET")
        expect(init?.headers).toEqual({ accept: "application/json" })
        expect(init?.body).toBeUndefined()
        return new Response(JSON.stringify({ healthy: true, version: "test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    expect(receipt).toMatchObject({
      schema_version: 1,
      status: "passed",
      artifact_path: expect.stringContaining("artifact/"),
      rollback_artifact_digest: "b".repeat(64),
      endpoint: "/global/health",
      observed_requests: 4,
      successful_requests: 4,
      critical_alerts: 0,
      failure_reasons: [],
    })
    expect(receipt.target_origin).toBe("https://staging.example.test")
    expect(new Set(requests)).toEqual(new Set(["https://staging.example.test/global/health"]))
  })
})

test("canary fails closed for HTTP errors, malformed health, and fetch failures", async () => {
  await withArtifact(async (artifactPath) => {
    let call = 0
    const receipt = await runCanary({
      root,
      baseUrl: "http://127.0.0.1:43123",
      artifactPath,
      rollbackArtifactDigest: "c".repeat(64),
      cohortID: "failure-cohort",
      trafficPercent: 1,
      requests: 3,
      timeoutMs: 250,
      observationDelayMs: 0,
      fetchImpl: async () => {
        call += 1
        if (call === 1) return new Response(JSON.stringify({ healthy: false }), { status: 200 })
        if (call === 2) return new Response("unavailable", { status: 503 })
        throw new Error("network failure")
      },
    })

    expect(receipt.status).toBe("failed")
    expect(receipt.observed_requests).toBe(3)
    expect(receipt.successful_requests).toBe(0)
    expect(receipt.critical_alerts).toBe(1)
    expect(receipt.failure_reasons).toEqual(["invalid_health_response", "http_503", "request_failed_or_timed_out"])
  })
})

test("canary rejects credentials, arbitrary paths, unsafe counts, and duplicate rollback digest", async () => {
  await withArtifact(async (artifactPath) => {
    await expectRejected(
      () =>
        runCanary({
          root,
          baseUrl: "https://user:password@staging.example.test",
          artifactPath,
          rollbackArtifactDigest: "b".repeat(64),
          cohortID: "invalid",
          trafficPercent: 5,
          requests: 1,
          observationDelayMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({ healthy: true })),
        }),
      "must not contain credentials",
    )

    await expectRejected(
      () =>
        runCanary({
          root,
          baseUrl: "https://staging.example.test/api",
          artifactPath,
          rollbackArtifactDigest: "b".repeat(64),
          cohortID: "invalid",
          trafficPercent: 5,
          requests: 1,
          observationDelayMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({ healthy: true })),
        }),
      "must be an origin",
    )

    await expectRejected(
      () =>
        runCanary({
          root,
          baseUrl: "https://staging.example.test?token=should-not-be-used",
          artifactPath,
          rollbackArtifactDigest: "b".repeat(64),
          cohortID: "invalid",
          trafficPercent: 5,
          requests: 1,
          observationDelayMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({ healthy: true })),
        }),
      "must not contain credentials, query, or fragment",
    )

    await expectRejected(
      () =>
        runCanary({
          root,
          baseUrl: "https://staging.example.test",
          artifactPath,
          rollbackArtifactDigest: "b".repeat(64),
          cohortID: "invalid",
          trafficPercent: 5,
          requests: 101,
          observationDelayMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({ healthy: true })),
        }),
      "between 1 and 100",
    )
  })
})
