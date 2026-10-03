import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { Effect, Layer, Schema, Context } from "effect"
import { SessionShareSnapshot } from "./session-snapshot"
import { makeSelfHostedProvider } from "./self-hosted"

const Digest = Schema.String
const OperationID = Schema.String
const Visibility = Schema.Literals(["private", "organization", "public"])

export const PublicationReceipt = Schema.Struct({
  providerReceiptID: Schema.String,
  publicationID: Schema.String,
  publicationURL: Schema.String,
  storedDigest: Digest,
  visibility: Visibility,
  organizationID: Schema.NullOr(Schema.String),
})
export type PublicationReceipt = typeof PublicationReceipt.Type

export const PublishResult = Schema.Struct({
  operationID: OperationID,
  status: Schema.Literal("settled"),
  publication: PublicationReceipt,
})
export type PublishResult = typeof PublishResult.Type

export const PublishLookup = Schema.Struct({
  operationID: OperationID,
  status: Schema.Literals(["missing", "pending", "settled", "conflict"]),
  publication: Schema.optional(PublicationReceipt),
  conflictingDigest: Schema.optional(Digest),
})
export type PublishLookup = typeof PublishLookup.Type

export const RevokeResult = Schema.Struct({
  operationID: OperationID,
  status: Schema.Literal("settled"),
  publicationID: Schema.String,
  removedDigest: Digest,
  visibility: Visibility,
  organizationID: Schema.NullOr(Schema.String),
})
export type RevokeResult = typeof RevokeResult.Type

export const RevokeLookup = Schema.Struct({
  operationID: OperationID,
  status: Schema.Literals(["missing", "pending", "settled", "conflict"]),
  publicationID: Schema.optional(Schema.String),
  removedDigest: Schema.optional(Digest),
  conflictingDigest: Schema.optional(Digest),
})
export type RevokeLookup = typeof RevokeLookup.Type

export type PublishInput = {
  readonly operationID: string
  readonly frozenExport: SessionShareSnapshot.Snapshot["export"]
  readonly exportDigest: string
  readonly target: SessionShareSnapshot.Snapshot["target"]
}

export type RevokeInput = {
  readonly operationID: string
  readonly publicationID: string
  readonly originalDigest: string
  readonly target: SessionShareSnapshot.Snapshot["target"]
}

/** Wire schemas for the self-hosted provider API. The HTTP boundary is strict
 * even though the internal worker already carries typed values. */
export const PublishInputSchema = Schema.Struct({
  operationID: OperationID,
  frozenExport: Schema.Struct({
    format: Schema.Literal(SessionShareSnapshot.FORMAT),
    items: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        type: Schema.Literals(["session", "message", "part", "session_diff", "model"]),
        data: Schema.Json,
      }),
    ),
    contentDigest: Digest,
    canonicalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  exportDigest: Digest,
  target: Schema.Struct({
    baseURL: Schema.String,
    organizationID: Schema.NullOr(Schema.String),
    visibility: Visibility,
    publication: Schema.NullOr(
      Schema.Struct({ id: Schema.String, url: Schema.String, exportDigest: Digest }),
    ),
    transportPolicy: Schema.Literal("https-only"),
  }),
})
export type PublishInputPayload = typeof PublishInputSchema.Type

export const RevokeInputSchema = Schema.Struct({
  operationID: OperationID,
  publicationID: Schema.String,
  originalDigest: Digest,
  target: Schema.Struct({
    baseURL: Schema.String,
    organizationID: Schema.NullOr(Schema.String),
    visibility: Visibility,
    publication: Schema.NullOr(
      Schema.Struct({ id: Schema.String, url: Schema.String, exportDigest: Digest }),
    ),
    transportPolicy: Schema.Literal("https-only"),
  }),
})
export type RevokeInputPayload = typeof RevokeInputSchema.Type

export class ProviderUnavailableError extends Schema.TaggedErrorClass<ProviderUnavailableError>()(
  "SessionShareProvider.UnavailableError",
  { operation: Schema.Literals(["publish", "lookup", "revoke", "lookupRevoke"]), reason: Schema.String },
) {
  override get message() {
    return `Session share provider ${this.operation} is unavailable: ${this.reason}`
  }
}

export class ProviderConflictError extends Schema.TaggedErrorClass<ProviderConflictError>()(
  "SessionShareProvider.ConflictError",
  { operationID: OperationID, expectedDigest: Digest, conflictingDigest: Digest },
) {
  override get message() {
    return `Session share provider operation ${this.operationID} conflicts with a different export digest`
  }
}

export class ProviderVerificationError extends Schema.TaggedErrorClass<ProviderVerificationError>()(
  "SessionShareProvider.VerificationError",
  { message: Schema.String },
) {}

export class ProviderUnknownResultError extends Schema.TaggedErrorClass<ProviderUnknownResultError>()(
  "SessionShareProvider.UnknownResultError",
  { operation: Schema.Literals(["publish", "lookup", "revoke", "lookupRevoke"]), reason: Schema.String },
) {
  override get message() {
    return `Session share provider returned an unverifiable ${this.operation} result: ${this.reason}`
  }
}

export type Error =
  | ProviderUnavailableError
  | ProviderConflictError
  | ProviderVerificationError
  | ProviderUnknownResultError

export type Availability = "ready" | "unavailable"

export interface Interface {
  /** Readiness is local-only; it must not perform a remote mutation or infer a remote outcome. */
  readonly availability: () => Effect.Effect<Availability>
  /** Same operationID + same digest must be idempotent; same operationID + different digest must conflict. */
  readonly publish: (input: PublishInput) => Effect.Effect<PublishResult, Error>
  readonly lookup: (operationID: string) => Effect.Effect<PublishLookup, Error>
  /** Revoke is bound to the original publication ID and original export digest. */
  readonly revoke: (input: RevokeInput) => Effect.Effect<RevokeResult, Error>
  readonly lookupRevoke: (operationID: string) => Effect.Effect<RevokeLookup, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionShareProvider") {}

const strictReceipt = Schema.decodeUnknownSync(PublicationReceipt, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

function digest(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new ProviderVerificationError({ message: `${label} is not a sha256 digest` })
  return value
}

function httpsOrigin(value: string, label: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(`${label} must be an HTTPS URL without credentials or fragments`)
    return url.origin
  } catch (cause) {
    throw new ProviderVerificationError({
      message: `${label} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }
}

function verifyReceipt(input: PublishInput, result: PublishResult) {
  if (result.operationID !== input.operationID || result.status !== "settled")
    throw new ProviderUnknownResultError({
      operation: "publish",
      reason: "operation identity or status is not settled",
    })
  let receipt: PublicationReceipt
  try {
    receipt = strictReceipt(result.publication)
  } catch (cause) {
    throw new ProviderVerificationError({ message: `provider receipt schema is invalid: ${cause}` })
  }
  const endpointOrigin = httpsOrigin(input.target.baseURL, "target.baseURL")
  const publicationOrigin = httpsOrigin(receipt.publicationURL, "publicationURL")
  if (endpointOrigin !== publicationOrigin)
    throw new ProviderVerificationError({ message: "provider publication URL is outside the approved endpoint origin" })
  if (
    receipt.storedDigest !== digest(input.exportDigest, "exportDigest") ||
    receipt.visibility !== input.target.visibility ||
    receipt.organizationID !== input.target.organizationID ||
    !receipt.providerReceiptID ||
    !receipt.publicationID
  )
    throw new ProviderVerificationError({ message: "provider receipt does not match the frozen export or target" })
  return result
}

export function verifyPublishResult(input: PublishInput, result: PublishResult) {
  return verifyReceipt(input, result)
}

export function verifyPublishLookup(input: PublishInput, result: PublishLookup) {
  if (result.operationID !== input.operationID)
    throw new ProviderUnknownResultError({ operation: "lookup", reason: "lookup operation identity changed" })
  if (result.status === "conflict") {
    const conflictingDigest = digest(result.conflictingDigest ?? "", "conflictingDigest")
    if (conflictingDigest === input.exportDigest)
      throw new ProviderUnknownResultError({ operation: "lookup", reason: "provider reported a self-conflict" })
    throw new ProviderConflictError({
      operationID: input.operationID,
      expectedDigest: input.exportDigest,
      conflictingDigest,
    })
  }
  if (result.status === "settled") {
    if (!result.publication)
      throw new ProviderUnknownResultError({
        operation: "lookup",
        reason: "settled lookup omitted its publication receipt",
      })
    return verifyReceipt(input, { operationID: result.operationID, status: "settled", publication: result.publication })
  }
  if (result.publication)
    throw new ProviderUnknownResultError({
      operation: "lookup",
      reason: `${result.status} lookup included a settled receipt`,
    })
  return result
}

export function verifyRevokeResult(input: RevokeInput, result: RevokeResult) {
  const publication = input.target.publication
  if (!publication)
    throw new ProviderVerificationError({ message: "revoke target is missing the original publication identity" })
  if (httpsOrigin(publication.url, "target.publication.url") !== httpsOrigin(input.target.baseURL, "target.baseURL"))
    throw new ProviderVerificationError({ message: "original publication URL is outside the approved endpoint origin" })
  if (
    result.operationID !== input.operationID ||
    result.status !== "settled" ||
    result.publicationID !== input.publicationID ||
    result.removedDigest !== digest(input.originalDigest, "originalDigest") ||
    result.visibility !== input.target.visibility ||
    result.organizationID !== input.target.organizationID
  )
    throw new ProviderVerificationError({ message: "provider revoke receipt does not match the frozen publication" })
  return result
}

export function verifyRevokeLookup(input: RevokeInput, result: RevokeLookup): RevokeLookup | RevokeResult {
  const publication = input.target.publication
  if (!publication)
    throw new ProviderVerificationError({ message: "revoke target is missing the original publication identity" })
  if (httpsOrigin(publication.url, "target.publication.url") !== httpsOrigin(input.target.baseURL, "target.baseURL"))
    throw new ProviderVerificationError({ message: "original publication URL is outside the approved endpoint origin" })
  if (result.operationID !== input.operationID)
    throw new ProviderUnknownResultError({ operation: "lookupRevoke", reason: "lookup operation identity changed" })
  if (result.status === "conflict") {
    const conflictingDigest = digest(result.conflictingDigest ?? "", "conflictingDigest")
    throw new ProviderConflictError({
      operationID: input.operationID,
      expectedDigest: input.originalDigest,
      conflictingDigest,
    })
  }
  if (result.status === "settled") {
    if (
      result.publicationID !== input.publicationID ||
      result.removedDigest !== digest(input.originalDigest, "originalDigest")
    )
      throw new ProviderVerificationError({ message: "provider revoke lookup does not match the frozen publication" })
    return {
      operationID: result.operationID,
      status: "settled",
      publicationID: result.publicationID,
      removedDigest: result.removedDigest,
      visibility: input.target.visibility,
      organizationID: input.target.organizationID,
    }
  } else if (result.publicationID !== undefined || result.removedDigest !== undefined) {
    throw new ProviderUnknownResultError({
      operation: "lookupRevoke",
      reason: `${result.status} lookup included settled fields`,
    })
  }
  return result
}

/** Production remains fail-closed until a provider implements receipt lookup and digest proof. */
export const disabled: Interface = {
  availability: () => Effect.succeed("unavailable"),
  publish: (input) =>
    Effect.fail(
      new ProviderUnavailableError({ operation: "publish", reason: "no verified provider adapter is configured" }),
    ),
  lookup: (_operationID) =>
    Effect.fail(
      new ProviderUnavailableError({ operation: "lookup", reason: "no verified provider adapter is configured" }),
    ),
  revoke: (_input) =>
    Effect.fail(
      new ProviderUnavailableError({ operation: "revoke", reason: "no verified provider adapter is configured" }),
    ),
  lookupRevoke: (_operationID) =>
    Effect.fail(
      new ProviderUnavailableError({ operation: "lookupRevoke", reason: "no verified provider adapter is configured" }),
    ),
}

export const disabledLayer = Layer.succeed(Service, disabled)

/** The default production adapter is now the durable self-hosted provider. */
export const node = LayerNode.make({
  service: Service,
  // Keep the implementation import cycle lazy: self-hosted.ts uses the
  // contract error classes, while this node selects its implementation.
  layer: Layer.suspend(() => Layer.effect(Service, makeSelfHostedProvider)),
  deps: [Database.node],
})

export function operationDigest(input: PublishInput | RevokeInput) {
  const result = canonicalHash(input)
  if (!result) throw new ProviderVerificationError({ message: "provider operation is not canonical" })
  return result
}

export * as SessionShareProvider from "./provider"
