import { SelfHostedSharePublicationTable, SelfHostedShareRevocationTable } from "@arforge-ai/core/share/sql"
import { Database } from "@arforge-ai/core/database/database"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { SessionShareProvider } from "./provider"
import { SessionShareSnapshot } from "./session-snapshot"

const SHA256 = /^[0-9a-f]{64}$/

/** Process-local capability for the provider HTTP surface; never persisted. */
export const SELF_HOSTED_PROVIDER_INTERNAL_TOKEN = `arforge-self-hosted-${randomUUID()}`

function providerFailure(operation: "publish" | "lookup" | "revoke" | "lookupRevoke", cause: unknown) {
  return new SessionShareProvider.ProviderUnavailableError({
    operation,
    reason: `self-hosted provider database operation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  })
}

function verifyDigest(value: string, label: string) {
  if (!SHA256.test(value))
    throw new SessionShareProvider.ProviderVerificationError({ message: `${label} must be a sha256 digest` })
  return value
}

function sync<A>(thunk: () => A): Effect.Effect<A, SessionShareProvider.Error> {
  return Effect.try({
    try: thunk,
    catch: (cause) => {
      if (
        cause instanceof SessionShareProvider.ProviderVerificationError ||
        cause instanceof SessionShareProvider.ProviderConflictError ||
        cause instanceof SessionShareProvider.ProviderUnknownResultError
      )
        return cause
      return new SessionShareProvider.ProviderVerificationError({
        message: cause instanceof Error ? cause.message : String(cause),
      })
    },
  })
}

function canonicalBaseURL(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("baseURL must be an HTTPS URL without credentials, query, or fragment")
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`
  } catch (cause) {
    throw new SessionShareProvider.ProviderVerificationError({
      message: `target.baseURL is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }
}

function origin(value: string) {
  try {
    return new URL(value).origin
  } catch {
    throw new SessionShareProvider.ProviderVerificationError({ message: "provider URL is invalid" })
  }
}

function verifyPublishInput(input: SessionShareProvider.PublishInput) {
  const baseURL = canonicalBaseURL(input.target.baseURL)
  if (input.target.publication !== null)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "self-hosted publish cannot replace an existing publication",
    })
  const exportDigest = verifyDigest(input.exportDigest, "exportDigest")
  const content = { format: input.frozenExport.format, items: input.frozenExport.items }
  const calculated = canonicalHash(content)
  if (!calculated || calculated !== exportDigest || input.frozenExport.contentDigest !== exportDigest)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "frozen export contentDigest does not match the supplied export digest",
    })
  const canonical = canonicalJson(content)
  if (!canonical || Buffer.byteLength(canonical) !== input.frozenExport.canonicalBytes)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "frozen export canonicalBytes does not match its canonical content",
    })
  if (input.target.visibility === "organization" && input.target.organizationID === null)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "organization visibility requires an organizationID",
    })
  return { baseURL, exportDigest }
}

function verifyRevokeInput(input: SessionShareProvider.RevokeInput) {
  const baseURL = canonicalBaseURL(input.target.baseURL)
  const publication = input.target.publication
  if (!publication || publication.id !== input.publicationID)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "revoke must carry the exact original publication identity",
    })
  verifyDigest(input.originalDigest, "originalDigest")
  if (origin(publication.url) !== origin(baseURL))
    throw new SessionShareProvider.ProviderVerificationError({
      message: "original publication URL is outside the self-hosted provider origin",
    })
  if (publication.exportDigest !== input.originalDigest)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "original publication digest does not match the revoke digest",
    })
  if (input.target.visibility === "organization" && input.target.organizationID === null)
    throw new SessionShareProvider.ProviderVerificationError({
      message: "organization visibility requires an organizationID",
    })
  return { baseURL }
}

function publicationResult(row: typeof SelfHostedSharePublicationTable.$inferSelect): SessionShareProvider.PublishResult {
  return {
    operationID: row.operation_id,
    status: "settled",
    publication: {
      providerReceiptID: row.provider_receipt_id,
      publicationID: row.publication_id,
      publicationURL: row.publication_url,
      storedDigest: row.export_digest,
      visibility: row.visibility,
      organizationID: row.organization_id,
    },
  }
}

function revokeResult(row: typeof SelfHostedShareRevocationTable.$inferSelect): SessionShareProvider.RevokeResult {
  return {
    operationID: row.operation_id,
    status: "settled",
    publicationID: row.publication_id,
    removedDigest: row.original_digest,
    visibility: row.visibility,
    organizationID: row.organization_id,
  }
}

/**
 * The self-hosted implementation is deliberately boring: the database is the
 * provider, not an in-memory cache. Inserts use unique operation/publication
 * keys and are followed by a durable reread, so a retry after a crash returns
 * the same receipt while a different digest is a conflict.
 */
export const makeSelfHostedProvider: Effect.Effect<
  SessionShareProvider.Interface,
  never,
  Database.Service
> = Effect.gen(function* () {
  const { db } = yield* Database.Service

  const publish: SessionShareProvider.Interface["publish"] = (input) =>
    Effect.gen(function* () {
      const { baseURL, exportDigest } = yield* sync(() => verifyPublishInput(input))
      const operationDigest = yield* sync(() => SessionShareProvider.operationDigest(input))
      const existing = yield* db
        .select()
        .from(SelfHostedSharePublicationTable)
        .where(eq(SelfHostedSharePublicationTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("publish", cause)))
      if (existing) {
        if (existing.export_digest !== exportDigest)
          return yield* new SessionShareProvider.ProviderConflictError({
            operationID: input.operationID,
            expectedDigest: exportDigest,
            conflictingDigest: existing.export_digest,
          })
        if (existing.operation_digest !== operationDigest)
          return yield* new SessionShareProvider.ProviderVerificationError({
            message: "operationID is already bound to a different publish target",
          })
        return publicationResult(existing)
      }

      const publicationID = `shr_${randomUUID()}`
      const providerReceiptID = `rcpt_${randomUUID()}`
      const publicationURL = `${baseURL}/self-hosted-share/publications/${encodeURIComponent(publicationID)}`
      yield* db
        .insert(SelfHostedSharePublicationTable)
        .values({
          publication_id: publicationID,
          operation_id: input.operationID,
          operation_digest: operationDigest,
          provider_receipt_id: providerReceiptID,
          publication_url: publicationURL,
          export_digest: exportDigest,
          frozen_export: input.frozenExport,
          target_base_url: baseURL,
          visibility: input.target.visibility,
          organization_id: input.target.organizationID,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError((cause) => providerFailure("publish", cause)))

      const persisted = yield* db
        .select()
        .from(SelfHostedSharePublicationTable)
        .where(eq(SelfHostedSharePublicationTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("publish", cause)))
      if (!persisted)
        return yield* new SessionShareProvider.ProviderUnknownResultError({
          operation: "publish",
          reason: "publication was not durable after insert",
        })
      if (persisted.export_digest !== exportDigest)
        return yield* new SessionShareProvider.ProviderConflictError({
          operationID: input.operationID,
          expectedDigest: exportDigest,
          conflictingDigest: persisted.export_digest,
        })
      if (persisted.operation_digest !== operationDigest)
        return yield* new SessionShareProvider.ProviderVerificationError({
          message: "operationID is already bound to a different publish target",
        })
      return publicationResult(persisted)
    })

  const lookup: SessionShareProvider.Interface["lookup"] = (operationID) =>
    db
      .select()
      .from(SelfHostedSharePublicationTable)
      .where(eq(SelfHostedSharePublicationTable.operation_id, operationID))
      .get()
      .pipe(
        Effect.mapError((cause) => providerFailure("lookup", cause)),
        Effect.map((row) =>
          row
            ? publicationResult(row)
            : ({ operationID, status: "missing" as const } satisfies SessionShareProvider.PublishLookup),
        ),
      )

  const revoke: SessionShareProvider.Interface["revoke"] = (input) =>
    Effect.gen(function* () {
      const { baseURL } = yield* sync(() => verifyRevokeInput(input))
      const operationDigest = yield* sync(() => SessionShareProvider.operationDigest(input))
      const existingOperation = yield* db
        .select()
        .from(SelfHostedShareRevocationTable)
        .where(eq(SelfHostedShareRevocationTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("revoke", cause)))
      if (existingOperation) {
        if (existingOperation.original_digest !== input.originalDigest)
          return yield* new SessionShareProvider.ProviderConflictError({
            operationID: input.operationID,
            expectedDigest: input.originalDigest,
            conflictingDigest: existingOperation.original_digest,
          })
        if (existingOperation.operation_digest !== operationDigest)
          return yield* new SessionShareProvider.ProviderVerificationError({
            message: "operationID is already bound to a different revoke target",
          })
        return revokeResult(existingOperation)
      }

      const publication = yield* db
        .select()
        .from(SelfHostedSharePublicationTable)
        .where(eq(SelfHostedSharePublicationTable.publication_id, input.publicationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("revoke", cause)))
      if (!publication)
        return yield* new SessionShareProvider.ProviderVerificationError({
          message: "the original publication does not exist in the self-hosted provider",
        })
      if (
        publication.export_digest !== input.originalDigest ||
        publication.target_base_url !== baseURL ||
        publication.visibility !== input.target.visibility ||
        publication.organization_id !== input.target.organizationID
      )
        return yield* new SessionShareProvider.ProviderVerificationError({
          message: "the original publication does not match the frozen revoke target",
        })

      const alreadyRevoked = yield* db
        .select()
        .from(SelfHostedShareRevocationTable)
        .where(eq(SelfHostedShareRevocationTable.publication_id, input.publicationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("revoke", cause)))
      if (alreadyRevoked)
        return yield* new SessionShareProvider.ProviderVerificationError({
          message: "the original publication was already revoked by another operation",
        })

      yield* db
        .insert(SelfHostedShareRevocationTable)
        .values({
          operation_id: input.operationID,
          operation_digest: operationDigest,
          publication_id: input.publicationID,
          original_digest: input.originalDigest,
          target_base_url: baseURL,
          visibility: input.target.visibility,
          organization_id: input.target.organizationID,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.mapError((cause) => providerFailure("revoke", cause)))

      const persisted = yield* db
        .select()
        .from(SelfHostedShareRevocationTable)
        .where(eq(SelfHostedShareRevocationTable.operation_id, input.operationID))
        .get()
        .pipe(Effect.mapError((cause) => providerFailure("revoke", cause)))
      if (!persisted)
        return yield* new SessionShareProvider.ProviderUnknownResultError({
          operation: "revoke",
          reason: "revocation was not durable after insert",
        })
      if (persisted.original_digest !== input.originalDigest)
        return yield* new SessionShareProvider.ProviderConflictError({
          operationID: input.operationID,
          expectedDigest: input.originalDigest,
          conflictingDigest: persisted.original_digest,
        })
      if (persisted.operation_digest !== operationDigest)
        return yield* new SessionShareProvider.ProviderVerificationError({
          message: "operationID is already bound to a different revoke target",
        })
      return revokeResult(persisted)
    })

  const lookupRevoke: SessionShareProvider.Interface["lookupRevoke"] = (operationID) =>
    db
      .select()
      .from(SelfHostedShareRevocationTable)
      .where(eq(SelfHostedShareRevocationTable.operation_id, operationID))
      .get()
      .pipe(
        Effect.mapError((cause) => providerFailure("lookupRevoke", cause)),
        Effect.map((row) =>
          row
            ? ({
                operationID,
                status: "settled" as const,
                publicationID: row.publication_id,
                removedDigest: row.original_digest,
              } satisfies SessionShareProvider.RevokeLookup)
            : ({ operationID, status: "missing" as const } satisfies SessionShareProvider.RevokeLookup),
        ),
      )

  return SessionShareProvider.Service.of({
    availability: () => Effect.succeed("ready" as const),
    publish,
    lookup,
    revoke,
    lookupRevoke,
  })
})

export * as SelfHostedShareProvider from "./self-hosted"
