import { describe, expect, test } from "bun:test"
import { createMemoryCandidateReviewApi, serializedTimeMillis } from "./memory-candidate-api"

const reviewResponse = {
  candidateID: "mcan_test",
  proposedClass: "semantic",
  content: "Reviewed fact",
  contentRedacted: false,
  sourceEvidenceIDs: [],
  scope: "workspace",
  sensitivity: "internal",
  confidence: 0.8,
  dedup: { status: "novel", comparedMemoryIDs: [] },
  retention: { mode: "indefinite", reason: "Durable preference" },
  proposer: { kind: "agent" },
  policy: { status: "review", policyVersion: "memory-v1", reason: "Needs review" },
  status: "proposed",
  reason: "Model proposal",
  time: { created: 100, updated: 123 },
  approvalAllowed: true,
  activationAllowed: false,
  blockedReasons: [],
  audit: [],
}

describe("Memory Candidate API adapter", () => {
  test("preserves scoped deep-object location and decision CAS payload", async () => {
    let request: Request | undefined
    const api = createMemoryCandidateReviewApi({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          request = new Request(input, init)
          return Response.json({ data: reviewResponse })
        },
        { preconnect: () => undefined },
      ),
    })
    await api.approve({
      candidateID: "mcan_test",
      directory: "C:/workspace",
      workspace: "feature",
      expectedUpdatedAt: 123,
      reason: "Verified evidence.",
    })
    expect(request?.method).toBe("POST")
    expect(new URL(request!.url).pathname).toBe("/api/memory/candidates/mcan_test/approve")
    expect(new URL(request!.url).searchParams.get("location[directory]")).toBe("C:/workspace")
    expect(await request?.json()).toEqual({ expectedUpdatedAt: 123, reason: "Verified evidence." })
  })

  test("surfaces backend recovery guidance and validates serialized time", async () => {
    const api = createMemoryCandidateReviewApi({
      baseUrl: "http://127.0.0.1:4096",
      fetch: Object.assign(
        async () => Response.json({ data: { message: "Refresh before approving." } }, { status: 409 }),
        { preconnect: () => undefined },
      ),
    })
    expect(
      api.approve({ candidateID: "mcan_test", directory: "C:/workspace", expectedUpdatedAt: 1, reason: "Review" }),
    ).rejects.toThrow("Refresh before approving.")
    expect(serializedTimeMillis("2026-08-15T10:00:00.000Z")).toBe(1_786_788_000_000)
    expect(() => serializedTimeMillis("invalid")).toThrow("invalid update time")
  })
})
