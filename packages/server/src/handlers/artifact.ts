import { Database } from "@arforge-ai/core/database/database"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionV2 } from "@arforge-ai/core/session"
import * as TenantPlatform from "@arforge-ai/core/tenant-platform"
import { MAX_READ_BYTES, ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import * as ArtifactMaintenanceScan from "@arforge-ai/core/runtime/artifact-maintenance-scan"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { ReadRangeRequest, ReadRequest } from "@arforge-ai/protocol/groups/artifact"
import { Api } from "../api"
import { IdentityContext } from "../identity-context"
import { ForbiddenError, InvalidRequestError, RateLimitedError } from "@arforge-ai/protocol/errors"
import { admitArtifactRead } from "../artifact-read-guard"

const invalidRead = (message: string, field?: string) =>
  new InvalidRequestError({ kind: "artifact-read-failed", message, ...(field === undefined ? {} : { field }) })

const storageFailure = () =>
  invalidRead("The artifact could not be verified or read; it may be expired, unavailable, or altered.")

const catalogFailure = () =>
  new InvalidRequestError({
    kind: "artifact-catalog-failed",
    message: "The artifact catalog could not be verified or read; retry the request.",
  })

const auditWire = (record: ToolOutputStore.ArtifactAuditRecord) => ({
  ...record,
  artifactID: AgentRuntime.ArtifactID.make(record.artifactID),
})

const rateLimited = (retryAfterSeconds: number) =>
  new RateLimitedError({
    message: "Artifact read rate limit exceeded; retry after the current window.",
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  })

const safeMime = (mime: string) =>
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : "application/octet-stream"

type ReadScope = "session" | "profile" | "tenant"

type ArtifactRange = {
  readonly offset: number
  readonly length: number
}

const auditArtifact = (input: {
  readonly principal: IdentityContext.Principal
  readonly scope: ReadScope
  readonly scopeID: string
  readonly sessionID?: string
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly range?: ArtifactRange
  readonly outcome: "success" | "rejected" | "rate_limited"
  readonly reason?: string
}) =>
  Effect.sync(() => {
    // Audit is deliberately best effort at this boundary. It must never turn
    // a successful read or a safe rejection into a different HTTP outcome.
    try {
      RuntimeInsight.auditRecord({
        actor: input.principal.userID,
        tenantID: input.principal.tenantID,
        ownerUserID: input.principal.userID,
        action: `artifact.read.${input.outcome}`,
        resource: input.reference.artifactID,
        reason: input.reason,
        metadata: {
          artifactID: input.reference.artifactID,
          digest: input.reference.digest,
          scope: input.scope,
          scopeID: input.scopeID,
          ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
          sizeBytes: input.reference.sizeBytes,
          ...(input.range === undefined ? {} : input.range),
          role: input.principal.role,
        },
      })
    } catch {
      // RuntimeInsight is an observability sink; the request contract remains
      // authoritative if a process-local audit append cannot be recorded.
    }
  })

/**
 * The only byte-read pipeline. Session and profile/tenant routes differ only
 * in how they establish the already-authorized owner; rate accounting,
 * storage verification, audit, headers, and error projection stay identical.
 */
const readArtifact = (input: {
  readonly principal: IdentityContext.Principal
  readonly tenantPlatform: TenantPlatform.Interface
  readonly store: ToolOutputStore.Interface
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly owner: AgentRuntime.ArtifactOwner
  readonly scope: ReadScope
  readonly scopeID: string
  readonly sessionID?: string
  readonly maxBytes: number
  readonly range?: ArtifactRange
}) =>
  Effect.gen(function* () {
    const audit = (outcome: "success" | "rejected" | "rate_limited", reason?: string) =>
      auditArtifact({ ...input, outcome, ...(reason === undefined ? {} : { reason }) })

    const catalogAudit = (
      action: ToolOutputStore.ArtifactAuditRecord["action"],
      reason?: string,
    ) =>
      input.store
        .recordAudit({
          actor: input.principal.userID,
          action,
          reference: input.reference,
          ...(reason === undefined ? {} : { reason }),
          ...(input.range === undefined ? {} : input.range),
        })
        .pipe(Effect.catch(() => Effect.void))

    const durableSuccessAudit = input.store
      .recordAudit({
        actor: input.principal.userID,
        action: input.range === undefined ? "read" : "range",
        reference: input.reference,
        ...(input.range === undefined ? {} : input.range),
      })
      .pipe(Effect.mapError(() => storageFailure()))

    const accountedBytes =
      input.range === undefined
        ? input.reference.sizeBytes
        : Math.max(0, Math.min(input.range.length, input.reference.sizeBytes - input.range.offset))

    const durableAdmission = yield* input.tenantPlatform
      .consumeRate(
        { tenantID: input.principal.tenantID, userID: input.principal.userID, role: input.principal.role },
        { bucket: TenantPlatform.ARTIFACT_READ_BUCKET, bytes: accountedBytes },
      )
      .pipe(
        Effect.tapError((error) =>
          audit(
            error instanceof TenantPlatform.RateLimitedError ? "rate_limited" : "rejected",
            error instanceof TenantPlatform.RateLimitedError ? "durable_rate_limit" : "rate_limiter_error",
          ),
        ),
        Effect.mapError((error) => {
          if (error instanceof TenantPlatform.RateLimitedError) return rateLimited(error.retryAfterSeconds)
          return invalidRead("Artifact read rate limiter is unavailable; retry later.")
        }),
      )
    if (!durableAdmission.allowed) {
      yield* audit("rate_limited", "durable_rate_limit")
      yield* catalogAudit("rate_limited", "durable_rate_limit")
      return yield* rateLimited(durableAdmission.retryAfterSeconds)
    }

    const admission = admitArtifactRead({
      tenantID: input.principal.tenantID,
      userID: input.principal.userID,
      scopeID: input.scopeID,
      bytes: accountedBytes,
    })
    if (!admission.allowed) {
      yield* audit("rate_limited", "process_rate_limit")
      yield* catalogAudit("rate_limited", "process_rate_limit")
      yield* Effect.logWarning("artifact read rate limited").pipe(
        Effect.annotateLogs({
          operation: "artifact.read",
          artifactID: input.reference.artifactID,
          scope: input.scope,
          scopeID: input.scopeID,
          ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
          tenantID: input.principal.tenantID,
          userID: input.principal.userID,
          retryAfterSeconds: admission.retryAfterSeconds,
        }),
      )
      return yield* rateLimited(admission.retryAfterSeconds)
    }

    const readEffect =
      input.range === undefined
        ? input.store.read({ reference: input.reference, owner: input.owner, maxBytes: input.maxBytes })
        : input.store.readRange({
            reference: input.reference,
            owner: input.owner,
            offset: input.range.offset,
            length: input.range.length,
            maxBytes: input.maxBytes,
          })

    const result = yield* readEffect
      .pipe(
        // A response is not released until the cross-process audit sequence
        // has durably recorded the verified receipt read.
        Effect.tap(() => durableSuccessAudit),
        Effect.tap(() => audit("success")),
        Effect.mapError(() => storageFailure()),
        Effect.tapError(() => {
          const catalogRejected = catalogAudit("rejected", "storage_failure")
          return audit("rejected", "storage_failure").pipe(Effect.flatMap(() => catalogRejected))
        }),
        Effect.tap(() =>
          Effect.logInfo("artifact read").pipe(
            Effect.annotateLogs({
              operation: "artifact.read",
              outcome: "success",
              artifactID: input.reference.artifactID,
              digest: input.reference.digest,
              scope: input.scope,
              scopeID: input.scopeID,
              ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
              tenantID: input.principal.tenantID,
              userID: input.principal.userID,
              bytes: accountedBytes,
              ...(input.range === undefined ? {} : input.range),
            }),
          ),
        ),
        Effect.tapError(() =>
          Effect.logWarning("artifact read rejected").pipe(
            Effect.annotateLogs({
              operation: "artifact.read",
              outcome: "rejected",
              artifactID: input.reference.artifactID,
              scope: input.scope,
              scopeID: input.scopeID,
              ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
              tenantID: input.principal.tenantID,
              userID: input.principal.userID,
            }),
          ),
        ),
      )

    const range = input.range
    return HttpServerResponse.uint8Array(result.bytes, {
      status: range === undefined ? 200 : 206,
      contentType: safeMime(result.reference.mime),
      headers: {
        "cache-control": "private, no-store",
        etag: `"${result.reference.digest}"`,
        "x-arforge-artifact-id": result.reference.artifactID,
        "accept-ranges": "bytes",
        "x-arforge-artifact-size": String(result.reference.sizeBytes),
        ...(range === undefined
          ? {}
          : {
              "content-range": `bytes ${range.offset}-${range.offset + result.bytes.byteLength - 1}/${result.reference.sizeBytes}`,
            }),
      },
    })
  })

const decodeReadPayload = (request: { readonly json: Effect.Effect<unknown, unknown, never> }) =>
  request.json.pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ReadRequest)(value)),
    Effect.mapError(() =>
      invalidRead("Artifact read payload is invalid JSON or does not match the receipt contract.", "body"),
    ),
  )

const decodeRangePayload = (request: { readonly json: Effect.Effect<unknown, unknown, never> }) =>
  request.json.pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ReadRangeRequest)(value)),
    Effect.mapError(() =>
      invalidRead("Artifact range payload is invalid JSON or does not match the range contract.", "body"),
    ),
  )

const validateRange = (
  reference: AgentRuntime.OpaqueArtifactRef,
  payload: { readonly offset: number; readonly length: number; readonly ifMatch?: string },
) => {
  if (!Number.isSafeInteger(payload.offset) || payload.offset < 0)
    return invalidRead("offset must be a non-negative safe integer.", "offset")
  if (!Number.isSafeInteger(payload.length) || payload.length <= 0 || payload.length > ToolOutputStore.MAX_RANGE_BYTES)
    return invalidRead(`length must be an integer between 1 and ${ToolOutputStore.MAX_RANGE_BYTES}.`, "length")
  if (payload.offset > Number.MAX_SAFE_INTEGER - payload.length)
    return invalidRead("offset plus length exceeds the safe integer range.", "offset")
  if (payload.offset >= reference.sizeBytes)
    return invalidRead("offset must be inside the artifact.", "offset")

  if (payload.ifMatch !== undefined) {
    const candidate = payload.ifMatch.trim().replace(/^W\//i, "")
    const digest = candidate.startsWith('"') && candidate.endsWith('"') ? candidate.slice(1, -1) : candidate
    if (digest !== reference.digest)
      return invalidRead("ifMatch does not match the artifact receipt digest.", "ifMatch")
  }
  return { offset: payload.offset, length: payload.length } satisfies ArtifactRange
}

const validateMaxBytes = (reference: AgentRuntime.OpaqueArtifactRef, maxBytes: number) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_READ_BYTES)
    return invalidRead(`maxBytes must be an integer between 0 and ${MAX_READ_BYTES}.`, "maxBytes")
  if (reference.sizeBytes > maxBytes)
    return invalidRead("The artifact is larger than the requested read limit.", "maxBytes")
  return undefined
}

/**
 * Keep the control-surface owner selector derived from the authenticated
 * principal.  This deliberately never accepts a caller-supplied owner ID and
 * exposes only the minimum capability bit needed to render the tenant view.
 */
export const artifactOwnerContext = (principal: IdentityContext.Principal) => ({
  profile: { scope: "profile" as const, id: principal.userID },
  tenant: { scope: "tenant" as const, id: principal.tenantID },
  tenantReadable: principal.role !== "member",
})

const maintenanceScanRecord = (scan: ArtifactMaintenanceScan.Scan | undefined) =>
  scan === undefined
    ? null
    : {
        scanID: scan.scanID,
        status: scan.status,
        pageNumber: scan.pageCount,
        scannedActions: scan.scannedActions,
        scanLimit: scan.scanLimit,
        scanComplete: scan.status === "complete",
        scanExpiresAt: scan.expiresAt,
        sessionDigest: scan.sessionDigest,
      }

const maintenanceContextFailure = (error: unknown) =>
  new InvalidRequestError({
    kind: "artifact-maintenance-context-failed",
    message:
      error instanceof ArtifactMaintenanceScan.InvalidInputError
        ? error.reason
        : "The profile maintenance state could not be verified; retry the request.",
  })

export const ArtifactHandler = HttpApiBuilder.group(Api, "server.artifact", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const tenantPlatform = yield* TenantPlatform.Service
    const store = yield* ToolOutputStore.Service
    const scans = yield* ArtifactMaintenanceScan.Service

    return handlers
      .handle("artifact.ownerContext", () =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          return artifactOwnerContext(principal)
        }),
      )
      .handle("artifact.maintenanceContext", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const context = artifactOwnerContext(principal)
          const requestedScope = ctx.query.scope ?? "profile"

          if (requestedScope === "tenant")
            return {
              owner: context.tenant,
              maintenanceScope: "profile" as const,
              canMaintain: false,
              scan: null,
              reason: "Tenant-scoped artifact maintenance is not available; select the current profile.",
            }

          if (principal.role === "member")
            return {
              owner: context.profile,
              maintenanceScope: "profile" as const,
              canMaintain: false,
              scan: null,
              reason: "Only a profile Owner or Admin can run artifact maintenance.",
            }

          const latest = yield* scans.latest().pipe(Effect.mapError(maintenanceContextFailure))
          return {
            owner: context.profile,
            maintenanceScope: "profile" as const,
            canMaintain: true,
            scan: maintenanceScanRecord(latest),
            reason:
              latest === undefined
                ? "No profile maintenance scan has started."
                : latest.status === "complete"
                  ? "The latest profile reference scan is complete; cleanup still requires explicit confirmation."
                  : latest.status === "active"
                    ? "A profile reference scan is in progress; cleanup stays disabled."
                    : "The latest profile reference scan expired; start a new audit before cleanup.",
          }
        }),
      )
      .handleRaw("artifact.read", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const payload = yield* decodeReadPayload(ctx.request)
          const reference = payload.reference
          const sessionID = ctx.params.sessionID
          const scope = "session" as const

          if (reference.owner.scope !== scope || reference.owner.id !== sessionID) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              outcome: "rejected",
              reason: "scope_mismatch",
            })
            return yield* new ForbiddenError({ message: "The artifact is outside the requested session scope." })
          }

          const sessionKey = SessionV2.ID.make(sessionID)
          const ownership = yield* database.db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionKey),
                eq(SessionTable.tenant_id, principal.tenantID),
                ...(principal.role === "member" ? [eq(SessionTable.owner_user_id, principal.userID)] : []),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!ownership) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              outcome: "rejected",
              reason: "session_forbidden",
            })
            return yield* new ForbiddenError({ message: "The requested session is outside your authorized scope." })
          }

          const maxBytes = payload.maxBytes ?? MAX_READ_BYTES
          const invalid = validateMaxBytes(reference, maxBytes)
          if (invalid !== undefined) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              outcome: "rejected",
              reason:
                invalid.field === "maxBytes" && reference.sizeBytes > maxBytes
                  ? "max_bytes_exceeded"
                  : "max_bytes_invalid",
            })
            return yield* invalid
          }

          return yield* readArtifact({
            principal,
            tenantPlatform,
            store,
            reference,
            owner: { scope, id: sessionID },
            scope,
            scopeID: sessionID,
            sessionID,
            maxBytes,
          })
        }),
      )
      .handleRaw("artifact.readRange", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const payload = yield* decodeRangePayload(ctx.request)
          const reference = payload.reference
          const sessionID = ctx.params.sessionID
          const scope = "session" as const
          const requestedRange = { offset: payload.offset, length: payload.length }

          if (reference.owner.scope !== scope || reference.owner.id !== sessionID) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              range: requestedRange,
              outcome: "rejected",
              reason: "scope_mismatch",
            })
            return yield* new ForbiddenError({ message: "The artifact is outside the requested session scope." })
          }

          const sessionKey = SessionV2.ID.make(sessionID)
          const ownership = yield* database.db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionKey),
                eq(SessionTable.tenant_id, principal.tenantID),
                ...(principal.role === "member" ? [eq(SessionTable.owner_user_id, principal.userID)] : []),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!ownership) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              range: requestedRange,
              outcome: "rejected",
              reason: "session_forbidden",
            })
            return yield* new ForbiddenError({ message: "The requested session is outside your authorized scope." })
          }

          const rangeOrError = validateRange(reference, payload)
          if (rangeOrError instanceof InvalidRequestError) {
            yield* auditArtifact({
              principal,
              scope,
              scopeID: sessionID,
              sessionID,
              reference,
              range: requestedRange,
              outcome: "rejected",
              reason: rangeOrError.field === "ifMatch" ? "etag_mismatch" : "range_invalid",
            })
            return yield* rangeOrError
          }

          return yield* readArtifact({
            principal,
            tenantPlatform,
            store,
            reference,
            owner: { scope, id: sessionID },
            scope,
            scopeID: sessionID,
            sessionID,
            maxBytes: ToolOutputStore.MAX_RANGE_BYTES,
            range: rangeOrError,
          })
        }),
      )
      .handleRaw("artifact.readScoped", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const payload = yield* decodeReadPayload(ctx.request)
          const reference = payload.reference
          const owner = reference.owner

          // Session receipts must use the session route, so there is no
          // ambiguous path-free route that can widen a session's authority.
          const authorized =
            owner.scope === "profile"
              ? owner.id === principal.userID
              : owner.scope === "tenant" && owner.id === principal.tenantID && principal.role !== "member"
          if (!authorized) {
            yield* auditArtifact({
              principal,
              scope: owner.scope,
              scopeID: owner.id,
              reference,
              outcome: "rejected",
              reason:
                owner.scope === "session"
                  ? "session_requires_session_route"
                  : owner.scope === "profile"
                    ? "profile_forbidden"
                    : "tenant_forbidden",
            })
            return yield* new ForbiddenError({ message: "The artifact is outside your authorized owner scope." })
          }

          const maxBytes = payload.maxBytes ?? MAX_READ_BYTES
          const invalid = validateMaxBytes(reference, maxBytes)
          if (invalid !== undefined) {
            yield* auditArtifact({
              principal,
              scope: owner.scope,
              scopeID: owner.id,
              reference,
              outcome: "rejected",
              reason:
                invalid.field === "maxBytes" && reference.sizeBytes > maxBytes
                  ? "max_bytes_exceeded"
                  : "max_bytes_invalid",
            })
            return yield* invalid
          }

          return yield* readArtifact({
            principal,
            tenantPlatform,
            store,
            reference,
            owner,
            scope: owner.scope,
            scopeID: owner.id,
            maxBytes,
          })
        }),
      )
      .handleRaw("artifact.readScopedRange", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const payload = yield* decodeRangePayload(ctx.request)
          const reference = payload.reference
          const owner = reference.owner
          const requestedRange = { offset: payload.offset, length: payload.length }

          // Session receipts must use the session route, so there is no
          // ambiguous path-free route that can widen a session's authority.
          const authorized =
            owner.scope === "profile"
              ? owner.id === principal.userID
              : owner.scope === "tenant" && owner.id === principal.tenantID && principal.role !== "member"
          if (!authorized) {
            yield* auditArtifact({
              principal,
              scope: owner.scope,
              scopeID: owner.id,
              reference,
              range: requestedRange,
              outcome: "rejected",
              reason:
                owner.scope === "session"
                  ? "session_requires_session_route"
                  : owner.scope === "profile"
                    ? "profile_forbidden"
                    : "tenant_forbidden",
            })
            return yield* new ForbiddenError({ message: "The artifact is outside your authorized owner scope." })
          }

          const rangeOrError = validateRange(reference, payload)
          if (rangeOrError instanceof InvalidRequestError) {
            yield* auditArtifact({
              principal,
              scope: owner.scope,
              scopeID: owner.id,
              reference,
              range: requestedRange,
              outcome: "rejected",
              reason: rangeOrError.field === "ifMatch" ? "etag_mismatch" : "range_invalid",
            })
            return yield* rangeOrError
          }

          return yield* readArtifact({
            principal,
            tenantPlatform,
            store,
            reference,
            owner,
            scope: owner.scope,
            scopeID: owner.id,
            maxBytes: ToolOutputStore.MAX_RANGE_BYTES,
            range: rangeOrError,
          })
        }),
      )
      .handle("artifact.catalog", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const sessionID = ctx.params.sessionID
          const sessionKey = SessionV2.ID.make(sessionID)
          const ownership = yield* database.db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionKey),
                eq(SessionTable.tenant_id, principal.tenantID),
                ...(principal.role === "member" ? [eq(SessionTable.owner_user_id, principal.userID)] : []),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!ownership)
            return yield* new ForbiddenError({ message: "The requested session is outside your authorized scope." })
          return yield* store
            .listCatalog({
              owner: { scope: "session", id: sessionID },
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
              ...(ctx.payload.beforeSequence === undefined ? {} : { beforeSequence: ctx.payload.beforeSequence }),
            })
            .pipe(Effect.mapError(() => catalogFailure()))
        }),
      )
      .handle("artifact.catalogScoped", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const owner = ctx.payload.owner
          const authorized =
            (owner.scope === "profile" && owner.id === principal.userID) ||
            (owner.scope === "tenant" && owner.id === principal.tenantID && principal.role !== "member")
          if (!authorized)
            return yield* new ForbiddenError({ message: "The requested artifact owner is outside your authorized scope." })
          return yield* store
            .listCatalog({
              owner,
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
              ...(ctx.payload.beforeSequence === undefined ? {} : { beforeSequence: ctx.payload.beforeSequence }),
            })
            .pipe(Effect.mapError(() => catalogFailure()))
        }),
      )
      .handle("artifact.audit", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const sessionID = ctx.params.sessionID
          const sessionKey = SessionV2.ID.make(sessionID)
          const ownership = yield* database.db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionKey),
                eq(SessionTable.tenant_id, principal.tenantID),
                ...(principal.role === "member" ? [eq(SessionTable.owner_user_id, principal.userID)] : []),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!ownership)
            return yield* new ForbiddenError({ message: "The requested session is outside your authorized scope." })
          return yield* store
            .listAudit({
              owner: { scope: "session", id: sessionID },
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
              ...(ctx.payload.beforeSequence === undefined ? {} : { beforeSequence: ctx.payload.beforeSequence }),
            })
            .pipe(Effect.map((records) => records.map(auditWire)))
            .pipe(Effect.mapError(() => catalogFailure()))
        }),
      )
      .handle("artifact.auditScoped", (ctx) =>
        Effect.gen(function* () {
          const principal = yield* IdentityContext.Current
          const owner = ctx.payload.owner
          const authorized =
            (owner.scope === "profile" && owner.id === principal.userID) ||
            (owner.scope === "tenant" && owner.id === principal.tenantID && principal.role !== "member")
          if (!authorized)
            return yield* new ForbiddenError({ message: "The requested artifact owner is outside your authorized scope." })
          return yield* store
            .listAudit({
              owner,
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
              ...(ctx.payload.beforeSequence === undefined ? {} : { beforeSequence: ctx.payload.beforeSequence }),
            })
            .pipe(Effect.map((records) => records.map(auditWire)))
            .pipe(Effect.mapError(() => catalogFailure()))
        }),
      )
  }),
)
