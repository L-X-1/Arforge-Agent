import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Memory } from "@arforge-ai/schema/memory"
import * as MemoryRevision from "@arforge-ai/schema/memory-revision"
import { casMatches, digest, nextVersion } from "@arforge-ai/core/memory-revision"

const actor = { kind: "user" as const, principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test") }
const revision = (version: number, priorDigest?: MemoryRevision.ContentDigest): MemoryRevision.Revision =>
  MemoryRevision.Revision.make({
    revisionID: MemoryRevision.RevisionID.make(`mrev_test_${version}`),
    memoryID: Memory.ID.make("mem_test"),
    version,
    operation: version === 1 ? "create" : "update",
    actor,
    reason: version === 1 ? "User supplied fact." : "User reviewed update.",
    policyVersion: "memory-write-policy-v1",
    evidenceIDs: [AgentRuntime.EvidenceID.make("evd_test")],
    priorDigest,
    contentDigest: digest({ memoryID: "mem_test", version }),
    time: DateTime.makeUnsafe(version),
  })

describe("Memory Step 5.5 provenance and revision", () => {
  test("creates a digest-linked immutable revision chain", () => {
    const first = revision(1)
    const second = revision(2, first.contentDigest)
    expect(MemoryRevision.isContiguous([second, first])).toBe(true)
    expect(MemoryRevision.isDigestLinked([second, first])).toBe(true)
    expect(second.priorDigest).toBe(first.contentDigest)
  })

  test("detects gaps and broken prior digests", () => {
    const first = revision(1)
    const third = revision(3, first.contentDigest)
    const broken = revision(2, digest({ different: true }))
    expect(MemoryRevision.isContiguous([first, third])).toBe(false)
    expect(MemoryRevision.isDigestLinked([first, broken])).toBe(false)
  })

  test("requires actor, reason, policy, evidence, and content digest", () => {
    const value = revision(1)
    expect(value.actor.kind).toBe("user")
    expect(String(value.actor.principalRef)).toBe("prn_test")
    expect(value.evidenceIDs.map(String)).toEqual(["evd_test"])
    expect(value.policyVersion).toBe("memory-write-policy-v1")
    expect(value.contentDigest).toHaveLength(64)
    expect(() =>
      Schema.decodeUnknownSync(MemoryRevision.Revision)({
        ...value,
        reason: "",
      }),
    ).toThrow()
  })

  test("provides explicit CAS and monotonic version helpers", () => {
    expect(casMatches(2, 2)).toBe(true)
    expect(casMatches(2, 1)).toBe(false)
    expect(nextVersion(2)).toBe(3)
    expect(digest({ a: 1 })).toBe(digest({ a: 1 }))
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }))
  })
})
