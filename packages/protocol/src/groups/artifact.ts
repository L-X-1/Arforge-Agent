import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Session } from "@arforge-ai/schema/session"
import { NonNegativeInt, PositiveInt } from "@arforge-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Context } from "effect"
import { ForbiddenError, InvalidRequestError, RateLimitedError, SessionNotFoundError } from "../errors"

const root = "/api/session/:sessionID/artifacts"
const scopedRoot = "/api/artifacts"
const params = { sessionID: Session.ID }

/**
 * The client sends the complete receipt so the server can perform an
 * identity/equivalence check against the durable sidecar before any bytes are
 * returned.  `maxBytes` is validated again by the server against its local
 * hard ceiling; the wire contract intentionally does not duplicate that
 * deployment constant.
 */
export const ReadRequest = Schema.Struct({
  reference: AgentRuntime.OpaqueArtifactRef,
  maxBytes: Schema.Number.pipe(Schema.optional),
}).annotate({ identifier: "Artifact.ReadRequest" })

/**
 * Resumable reads are explicit byte ranges. `ifMatch` is the opaque receipt
 * digest (optionally quoted like an HTTP ETag); the server rejects a stale
 * receipt before returning any slice.
 */
export const ReadRangeRequest = Schema.Struct({
  reference: AgentRuntime.OpaqueArtifactRef,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  length: Schema.Int.check(Schema.isGreaterThan(0)),
  ifMatch: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Artifact.ReadRangeRequest" })

/** Cursor-bounded, metadata-only read model for one authorized artifact owner. */
export const CatalogRequest = Schema.Struct({
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000)).pipe(Schema.optional),
  beforeSequence: PositiveInt.pipe(Schema.optional),
}).annotate({ identifier: "Artifact.CatalogRequest" })

export const CatalogEntry = Schema.Struct({
  reference: AgentRuntime.OpaqueArtifactRef,
  firstSeenAt: NonNegativeInt,
  lastSeenAt: NonNegativeInt,
  lastSequence: NonNegativeInt,
  readCount: NonNegativeInt,
}).annotate({ identifier: "Artifact.CatalogEntry" })

export const CatalogPage = Schema.Struct({
  entries: Schema.Array(CatalogEntry),
  nextSequence: PositiveInt.pipe(Schema.optional),
  headSequence: NonNegativeInt,
  headHash: Schema.String,
  droppedAuditEntries: NonNegativeInt,
}).annotate({ identifier: "Artifact.CatalogPage" })

export const AuditRequest = Schema.Struct({
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(1_000)).pipe(Schema.optional),
  beforeSequence: PositiveInt.pipe(Schema.optional),
}).annotate({ identifier: "Artifact.AuditRequest" })

/**
 * The authenticated owner context used by control surfaces to choose a
 * profile- or tenant-scoped receipt view.  The server returns only opaque
 * owner identifiers and the tenant-read capability; clients cannot use this
 * endpoint to enumerate arbitrary profiles, tenants, paths, or credentials.
 */
export const OwnerContext = Schema.Struct({
  profile: AgentRuntime.ArtifactOwner,
  tenant: AgentRuntime.ArtifactOwner,
  tenantReadable: Schema.Boolean,
}).annotate({ identifier: "Artifact.OwnerContext" })

/**
 * Read-only maintenance capability evidence for the authenticated owner.
 * Maintenance is intentionally profile-only: tenant receipt views never
 * imply that a tenant can run the profile-owned destructive sweep.
 */
export const MaintenanceContextQuery = Schema.Struct({
  scope: Schema.Literals(["profile", "tenant"]).pipe(Schema.optional),
}).annotate({ identifier: "Artifact.MaintenanceContextQuery" })

export const MaintenanceScanRecord = Schema.Struct({
  scanID: Schema.String,
  status: Schema.Literals(["active", "complete", "expired"]),
  pageNumber: NonNegativeInt,
  scannedActions: NonNegativeInt,
  scanLimit: PositiveInt,
  scanComplete: Schema.Boolean,
  scanExpiresAt: NonNegativeInt,
  sessionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "Artifact.MaintenanceScanRecord" })

export const MaintenanceContext = Schema.Struct({
  owner: AgentRuntime.ArtifactOwner,
  maintenanceScope: Schema.Literal("profile"),
  canMaintain: Schema.Boolean,
  scan: Schema.NullOr(MaintenanceScanRecord),
  reason: Schema.String,
}).annotate({ identifier: "Artifact.MaintenanceContext" })

export const AuditRecord = Schema.Struct({
  sequence: PositiveInt,
  recordedAt: NonNegativeInt,
  actor: Schema.String,
  action: Schema.Literals(["registered", "read", "range", "rejected", "rate_limited", "removed"]),
  artifactID: AgentRuntime.ArtifactID,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  owner: AgentRuntime.ArtifactOwner,
  reason: Schema.String.pipe(Schema.optional),
  offset: NonNegativeInt.pipe(Schema.optional),
  length: PositiveInt.pipe(Schema.optional),
  previousHash: Schema.String,
  recordHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({ identifier: "Artifact.AuditRecord" })

const readErrors = [ForbiddenError, InvalidRequestError, RateLimitedError, SessionNotFoundError]
const rangeSuccess = Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array(), HttpApiSchema.status(206))

export const makeArtifactGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.artifact")
    .add(
      HttpApiEndpoint.post("artifact.read", `${root}/read`, {
        params,
        payload: ReadRequest,
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        error: readErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.artifact.read",
            summary: "Read an authenticated opaque artifact",
            description:
              "Resolve one session-owned opaque artifact after owner, retention, index, size, and digest checks. The response never exposes a filesystem path.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("artifact.readRange", `${root}/read-range`, {
        params,
        payload: ReadRangeRequest,
        success: rangeSuccess,
        error: readErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.artifact.readRange",
            summary: "Read a bounded authenticated artifact range",
            description:
              "Resolve a session-owned receipt and return one bounded 206 byte range after owner, ETag, retention, index, size, and digest checks.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("artifact.readScoped", `${scopedRoot}/read`, {
        payload: ReadRequest,
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        error: readErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.readScoped",
          summary: "Read a profile- or tenant-owned opaque artifact",
          description:
            "Resolve a profile- or tenant-owned receipt after the authenticated owner scope is checked. Session-owned receipts must use the session route; the response never exposes a filesystem path.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("artifact.readScopedRange", `${scopedRoot}/read-range`, {
        payload: ReadRangeRequest,
        success: rangeSuccess,
        error: readErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.readScopedRange",
          summary: "Read a bounded profile- or tenant-owned artifact range",
          description:
            "Resolve a profile- or tenant-owned receipt and return one bounded 206 byte range after owner, ETag, retention, index, size, and digest checks.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("artifact.ownerContext", `${scopedRoot}/owner-context`, {
        success: OwnerContext,
        error: [ForbiddenError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.ownerContext",
          summary: "Get the authenticated artifact owner context",
          description:
            "Return only the current profile owner, tenant owner, and whether this principal may read tenant-scoped receipts; arbitrary owner IDs and credentials are never returned.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("artifact.maintenanceContext", `${scopedRoot}/maintenance-context`, {
        query: MaintenanceContextQuery,
        success: MaintenanceContext,
        error: [ForbiddenError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.maintenanceContext",
          summary: "Get authenticated artifact maintenance capability",
          description:
            "Return profile-only maintenance availability and the latest redacted scan state for the current owner; tenant metadata views never imply maintenance authority and no bytes, paths, or credentials are returned.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("artifact.catalog", `${root}/catalog`, {
        params,
        payload: CatalogRequest,
        success: CatalogPage,
        error: [ForbiddenError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.artifact.catalog",
            summary: "List a session-owned artifact catalog page",
            description:
              "Return metadata-only artifact receipts for the authorized session with a bounded sequence cursor; paths, bytes, and credentials are never included.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("artifact.catalogScoped", `${scopedRoot}/catalog`, {
        payload: Schema.Struct({ owner: AgentRuntime.ArtifactOwner, ...CatalogRequest.fields }),
        success: CatalogPage,
        error: [ForbiddenError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.catalogScoped",
          summary: "List a profile- or tenant-owned artifact catalog page",
          description:
            "Return metadata-only receipts for an authenticated profile or tenant owner with a bounded sequence cursor; session owners must use the session route.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("artifact.audit", `${root}/audit`, {
        params,
        payload: AuditRequest,
        success: Schema.Array(AuditRecord),
        error: [ForbiddenError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.artifact.audit",
            summary: "List a session-owned artifact audit page",
            description:
              "Return bounded, metadata-only hash-chain audit records for the authorized session; paths, bytes, and credentials are never included.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("artifact.auditScoped", `${scopedRoot}/audit`, {
        payload: Schema.Struct({ owner: AgentRuntime.ArtifactOwner, ...AuditRequest.fields }),
        success: Schema.Array(AuditRecord),
        error: [ForbiddenError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.artifact.auditScoped",
          summary: "List a profile- or tenant-owned artifact audit page",
          description:
            "Return bounded, metadata-only audit records for an authenticated profile or tenant owner; session owners must use the session route.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "artifacts",
        description: "Authenticated, session-scoped opaque artifact retrieval.",
      }),
    )
