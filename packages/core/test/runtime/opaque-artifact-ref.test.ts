import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { OpaqueArtifact } from "@arforge-ai/core/runtime/artifact-ref"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

const digest = "a".repeat(64)
const createdAt = DateTime.makeUnsafe(1_000)

const makeRef = () =>
  OpaqueArtifact.make({
    version: 1,
    kind: "tool_output",
    digest,
    mime: "text/plain",
    sizeBytes: 12,
    owner: { scope: "session", id: "ses_opaque_test" },
    retention: { mode: "session", expiresAt: DateTime.makeUnsafe(86_401_000) },
    retrievalHint: { kind: "managed", handle: "tool_opaque_handle" },
    createdAt,
  })

test("opaque artifact receipts bind identity and never carry a path", () => {
  const reference = makeRef()
  expect(String(reference.artifactID)).toBe(`art_${digest}`)
  expect(reference.retrievalHint.handle).toBe("tool_opaque_handle")
  expect(JSON.stringify(reference)).not.toContain("path")
  expect(JSON.stringify(reference)).not.toContain("\\")
  expect(OpaqueArtifact.validate(reference)).toEqual(reference)
})

test("opaque artifact receipts round-trip through the wire codec", () => {
  const reference = makeRef()
  const encoded = Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference)
  expect(encoded.createdAt).toBe(1_000)
  expect(encoded.retention.expiresAt).toBe(86_401_000)
  expect(Schema.decodeUnknownSync(AgentRuntime.OpaqueArtifactRef)(encoded)).toEqual(reference)
  expect(OpaqueArtifact.decode(encoded)).toEqual(reference)
})

test("opaque artifact validation rejects identity drift and path-like handles", () => {
  const reference = makeRef()
  expect(() =>
    OpaqueArtifact.validate({
      ...reference,
      artifactID: `art_${"b".repeat(64)}`,
    }),
  ).toThrow("does not match")
  expect(() =>
    OpaqueArtifact.validate({
      ...reference,
      retrievalHint: { kind: "managed", handle: "../secret" },
    }),
  ).toThrow("invalid")
})

test("opaque artifact equivalence covers every encoded metadata field", () => {
  const reference = makeRef()
  expect(OpaqueArtifact.equivalent(reference, { ...reference, label: "same bytes, different label" })).toBe(false)
  expect(
    OpaqueArtifact.equivalent(
      reference,
      OpaqueArtifact.decode(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference)),
    ),
  ).toBe(true)
})

test("rollback references project into the same opaque contract", () => {
  const reference = OpaqueArtifact.fromRollback({
    reference: {
      version: 1,
      artifactID: `rollback-${digest}`,
      digest,
      byteLength: 42,
    },
    owner: { scope: "profile", id: "profile_opaque_test" },
    createdAt,
    retention: { mode: "durable" },
  })
  expect(reference.kind).toBe("rollback")
  expect(reference.mime).toBe("application/octet-stream")
  expect(reference.sizeBytes).toBe(42)
  expect(reference.retrievalHint.handle).toBe(`rollback_${digest}`)
  expect(OpaqueArtifact.validate(reference)).toEqual(reference)
})
