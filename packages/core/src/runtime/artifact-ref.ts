export * as OpaqueArtifact from "./artifact-ref"

import { Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { validateRollbackArtifactRef, type RollbackArtifactRef } from "./rollback-artifact"

const DIGEST = /^[a-f0-9]{64}$/

/** Errors raised when an opaque receipt cannot be trusted at a domain boundary. */
export class OpaqueArtifactError extends Error {
  readonly code: "invalid_reference" | "identity_mismatch" | "unsafe_handle"

  constructor(code: OpaqueArtifactError["code"], message: string) {
    super(message)
    this.name = "OpaqueArtifactError"
    this.code = code
  }
}

export type CreateInput = Omit<AgentRuntime.OpaqueArtifactRef, "artifactID">

/**
 * Artifact IDs are content-bound, while retrieval handles remain resolver
 * owned.  Neither value is a path; the storage owner maps the handle to a
 * path only after checking this receipt and its owner namespace.
 */
export const artifactIDForDigest = (digest: string): AgentRuntime.ArtifactID => {
  if (!DIGEST.test(digest)) throw new OpaqueArtifactError("invalid_reference", "Artifact digest is invalid.")
  return AgentRuntime.ArtifactID.make(`art_${digest}`)
}

export const make = (input: CreateInput): AgentRuntime.OpaqueArtifactRef => {
  const value = AgentRuntime.OpaqueArtifactRef.make({
    ...input,
    artifactID: artifactIDForDigest(input.digest),
  })
  validate(value)
  return value
}

/** Validate schema shape plus the deterministic digest/ID binding. */
export const validate = (value: unknown): AgentRuntime.OpaqueArtifactRef => {
  if (!Schema.is(AgentRuntime.OpaqueArtifactRef)(value))
    throw new OpaqueArtifactError("invalid_reference", "Opaque artifact reference is invalid.")
  const reference = value
  if (reference.artifactID !== artifactIDForDigest(reference.digest))
    throw new OpaqueArtifactError("identity_mismatch", "Opaque artifact ID does not match its content digest.")
  if (reference.retrievalHint.handle.includes("/") || reference.retrievalHint.handle.includes("\\"))
    throw new OpaqueArtifactError("unsafe_handle", "Opaque artifact retrieval handle must not contain a path.")
  return reference
}

/** Decode a persisted/wire representation and then apply the runtime checks. */
export const decode = (value: unknown): AgentRuntime.OpaqueArtifactRef => {
  let reference: AgentRuntime.OpaqueArtifactRef
  try {
    reference = Schema.decodeUnknownSync(AgentRuntime.OpaqueArtifactRef)(value)
  } catch (cause) {
    throw new OpaqueArtifactError("invalid_reference", `Opaque artifact reference is invalid: ${String(cause)}`)
  }
  return validate(reference)
}

/** Compare two decoded receipts across every metadata field, including dates. */
export const equivalent = (left: AgentRuntime.OpaqueArtifactRef, right: AgentRuntime.OpaqueArtifactRef): boolean => {
  try {
    return (
      JSON.stringify(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(left)) ===
      JSON.stringify(Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(right))
    )
  } catch {
    return false
  }
}

/**
 * Project an internal rollback reference into the same public receipt shape.
 * The rollback store remains the byte owner; this helper only creates the
 * common metadata contract and never exposes its filesystem path.
 */
export const fromRollback = (input: {
  readonly reference: RollbackArtifactRef
  readonly owner: AgentRuntime.ArtifactOwner
  readonly createdAt: AgentRuntime.OpaqueArtifactRef["createdAt"]
  readonly retention: AgentRuntime.ArtifactRetention
  readonly label?: string
}): AgentRuntime.OpaqueArtifactRef =>
  (() => {
    validateRollbackArtifactRef(input.reference)
    return make({
      version: 1,
      kind: "rollback",
      digest: input.reference.digest,
      mime: "application/octet-stream",
      sizeBytes: input.reference.byteLength,
      owner: input.owner,
      retention: input.retention,
      retrievalHint: { kind: "managed", handle: `rollback_${input.reference.digest}` },
      ...(input.label === undefined ? {} : { label: input.label }),
      createdAt: input.createdAt,
    })
  })()
