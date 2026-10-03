import { SessionShareOperationReceiptTable } from "@arforge-ai/core/share/sql"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionShareProvider } from "./provider"
import { SessionShareSnapshot } from "./session-snapshot"

const RawRecordInput = Schema.Struct({
  operationID: Schema.String,
  runID: Schema.String,
  actionID: Schema.String,
  requestID: Schema.String,
  snapshot: Schema.Unknown,
  result: Schema.Unknown,
})
export type RecordInput = typeof RawRecordInput.Type

export type Receipt = typeof SessionShareOperationReceiptTable.$inferSelect

export class Error extends Schema.TaggedErrorClass<Error>()("SessionShareReceiptStore.Error", {
  reason: Schema.Literals(["invalid_input", "provider_result_invalid", "receipt_conflict", "database_unavailable"]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.reason}: ${this.detail}`
  }
}

export interface Interface {
  /** Insert only a locally verified, settled provider receipt; never update or delete. */
  readonly record: (input: unknown) => Effect.Effect<Receipt, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionShareReceiptStore") {}

const strictInput = Schema.decodeUnknownSync(RawRecordInput, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const strictPublishResult = Schema.decodeUnknownSync(SessionShareProvider.PublishResult, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const strictRevokeResult = Schema.decodeUnknownSync(SessionShareProvider.RevokeResult, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

function fail(reason: Error["reason"], detail: string) {
  return new Error({ reason, detail })
}

function isReceiptError(value: unknown): value is Error {
  return value instanceof Error
}

function stableDigest(value: object) {
  const {
    tenant_id: _tenantID,
    owner_user_id: _ownerUserID,
    time_created: _timeCreated,
    ...stable
  } = value as { readonly tenant_id?: unknown; readonly owner_user_id?: unknown; readonly time_created?: unknown }
  return canonicalHash(stable)
}

function buildCandidate(
  input: RecordInput,
  snapshot: SessionShareSnapshot.Snapshot,
): typeof SessionShareOperationReceiptTable.$inferInsert {
  const base = {
    operation_id: input.operationID,
    run_id: input.runID,
    action_id: input.actionID,
    request_id: input.requestID,
    kind: snapshot.kind,
    session_id: snapshot.sessionID,
    project_id: snapshot.projectID,
    snapshot_digest: snapshot.digest,
    target_base_url: snapshot.target.baseURL,
    visibility: snapshot.target.visibility,
    organization_id: snapshot.target.organizationID,
    publication_url: snapshot.target.publication?.url ?? "",
    response_digest: "",
  }

  if (snapshot.kind === "share") {
    const result = strictPublishResult(input.result)
    const verified = SessionShareProvider.verifyPublishResult(
      {
        operationID: input.operationID,
        frozenExport: snapshot.export,
        exportDigest: snapshot.export.contentDigest,
        target: snapshot.target,
      },
      result,
    )
    const responseDigest = canonicalHash(verified)
    if (!responseDigest) throw fail("provider_result_invalid", "verified publish receipt is not canonical")
    return {
      ...base,
      export_digest: snapshot.export.contentDigest,
      provider_receipt_id: verified.publication.providerReceiptID,
      publication_id: verified.publication.publicationID,
      publication_url: verified.publication.publicationURL,
      stored_digest: verified.publication.storedDigest,
      removed_digest: null,
      response_digest: responseDigest,
    }
  }

  const publication = snapshot.target.publication
  if (!publication) throw fail("invalid_input", "unshare snapshot is missing its original publication identity")
  const result = strictRevokeResult(input.result)
  const verified = SessionShareProvider.verifyRevokeResult(
    {
      operationID: input.operationID,
      publicationID: publication.id,
      originalDigest: publication.exportDigest,
      target: snapshot.target,
    },
    result,
  )
  const responseDigest = canonicalHash(verified)
  if (!responseDigest) throw fail("provider_result_invalid", "verified revoke receipt is not canonical")
  return {
    ...base,
    export_digest: publication.exportDigest,
    provider_receipt_id: null,
    publication_id: verified.publicationID,
    publication_url: publication.url,
    stored_digest: null,
    removed_digest: verified.removedDigest,
    response_digest: responseDigest,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const record: Interface["record"] = (raw) =>
      Effect.gen(function* () {
        let input: RecordInput
        try {
          input = strictInput(raw)
        } catch (cause) {
          return yield* Effect.fail(fail("invalid_input", `receipt record request is invalid: ${String(cause)}`))
        }

        const snapshot = yield* Effect.try({
          try: () => SessionShareSnapshot.decodeSnapshot(input.snapshot),
          catch: (cause) => fail("invalid_input", `sealed share snapshot is invalid: ${String(cause)}`),
        })
        const candidate = yield* Effect.try({
          try: () => buildCandidate(input, snapshot),
          catch: (cause) =>
            isReceiptError(cause)
              ? cause
              : fail("provider_result_invalid", `provider receipt is invalid: ${String(cause)}`),
        })

        const existing = yield* db
          .select()
          .from(SessionShareOperationReceiptTable)
          .where(eq(SessionShareOperationReceiptTable.operation_id, input.operationID))
          .get()
          .pipe(Effect.mapError((cause) => fail("database_unavailable", String(cause))))
        if (existing) {
          if (stableDigest(existing) !== stableDigest(candidate))
            return yield* Effect.fail(fail("receipt_conflict", "operationID is already bound to a different receipt"))
          return existing
        }

        yield* db
          .insert(SessionShareOperationReceiptTable)
          .values(candidate)
          .onConflictDoNothing()
          .run()
          .pipe(Effect.mapError((cause) => fail("database_unavailable", String(cause))))

        const persisted = yield* db
          .select()
          .from(SessionShareOperationReceiptTable)
          .where(eq(SessionShareOperationReceiptTable.operation_id, input.operationID))
          .get()
          .pipe(Effect.mapError((cause) => fail("database_unavailable", String(cause))))
        if (!persisted)
          return yield* Effect.fail(fail("database_unavailable", "verified receipt was not durable after insert"))
        if (stableDigest(persisted) !== stableDigest(candidate))
          return yield* Effect.fail(fail("receipt_conflict", "operationID raced with a different receipt"))
        return persisted
      })

    return Service.of({ record })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as SessionShareReceiptStore from "./receipt-store"
