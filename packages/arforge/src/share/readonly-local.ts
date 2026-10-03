import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import { MessageTable, PartTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionShareOperationReceiptTable } from "@arforge-ai/core/share/sql"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { and, asc, desc, eq } from "drizzle-orm"
import { Effect, Layer, Schema, Context } from "effect"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionShareSnapshot } from "./session-snapshot"

const MAX_DATABASE_ROWS = 250_000

const CaptureInput = Schema.Struct({
  requestID: Schema.String,
  kind: Schema.Literals(["share", "unshare"]),
  sessionID: SessionID,
  target: Schema.Struct({
    baseURL: Schema.String,
    organizationID: Schema.NullOr(Schema.String),
    visibility: Schema.Literals(["private", "organization", "public"]),
    publication: Schema.Null,
  }),
})
export type CaptureInput = typeof CaptureInput.Type

export class Error extends Schema.TaggedErrorClass<Error>()("SessionShareReadonlyLocal.Error", {
  reason: Schema.Literals([
    "invalid_request",
    "session_not_found",
    "session_scope_mismatch",
    "event_drift",
    "session_drift",
    "database_unavailable",
    "unsupported_operation",
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.reason}: ${this.detail}`
  }
}

export interface Interface {
  /** Read Session, messages, parts, and Event HWM twice; never writes or contacts a provider. */
  readonly capture: (input: unknown) => Effect.Effect<SessionShareSnapshot.Snapshot, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionShareReadonlyLocal") {}

type RawProjection = {
  readonly eventHighWaterMark: number
  readonly session: typeof SessionTable.$inferSelect
  readonly messages: ReadonlyArray<typeof MessageTable.$inferSelect>
  readonly parts: ReadonlyArray<typeof PartTable.$inferSelect>
  readonly publication: typeof SessionShareOperationReceiptTable.$inferSelect | undefined
}

function lexicalPath(value: string) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target)
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function fail(reason: Error["reason"], message: string) {
  return new Error({ reason, detail: message })
}

function isCaptureError(value: unknown): value is Error {
  return value instanceof Error
}

function jsonValue(value: unknown): Schema.Schema.Type<typeof Schema.Json> {
  return JSON.parse(JSON.stringify(value)) as Schema.Schema.Type<typeof Schema.Json>
}

function buildCapture(input: CaptureInput, projection: RawProjection, projectID: string, projectRoot: string) {
  const session = Session.fromRow(projection.session)
  if (session.projectID !== projectID)
    throw fail("session_scope_mismatch", "the Session project does not match the active project")
  const location = lexicalPath(session.directory)
  if (!isWithin(projectRoot, location))
    throw fail("session_scope_mismatch", "the Session directory is outside the project root")
  if (input.kind === "share" && session.share)
    throw fail("unsupported_operation", "a Session with an existing publication cannot be shared again")
  if (input.kind === "unshare") {
    if (!session.share) throw fail("unsupported_operation", "a Session without a publication cannot be unshared")
    const publication = projection.publication
    if (!publication) throw fail("unsupported_operation", "the original verified share receipt is unavailable")
    let targetOrigin: string
    let receiptOrigin: string
    try {
      targetOrigin = new URL(input.target.baseURL).origin
      receiptOrigin = new URL(publication.target_base_url).origin
    } catch {
      throw fail("invalid_request", "share endpoint is not a valid URL")
    }
    if (
      session.share.url !== publication.publication_url ||
      targetOrigin !== receiptOrigin ||
      input.target.visibility !== publication.visibility ||
      input.target.organizationID !== publication.organization_id
    )
      throw fail("session_scope_mismatch", "unshare target does not match the immutable publication receipt")
  }

  const parts = new Map<string, Array<typeof SessionV1.Part.Type>>()
  for (const row of projection.parts) {
    if (row.session_id !== input.sessionID || !projection.messages.some((message) => message.id === row.message_id))
      throw fail("session_drift", "a Session part is attached to a different or missing message")
    const value = Schema.decodeUnknownSync(SessionV1.Part)({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    })
    const list = parts.get(row.message_id)
    if (list) list.push(value)
    else parts.set(row.message_id, [value])
  }

  const items: SessionShareSnapshot.Capture["export"]["items"] = [
    { key: "session", type: "session", data: jsonValue(session) },
    ...projection.messages.map((row) => {
      const message = Schema.decodeUnknownSync(SessionV1.Info)({ ...row.data, id: row.id, sessionID: row.session_id })
      return { key: `message/${message.id}`, type: "message" as const, data: jsonValue(message) }
    }),
    ...projection.parts.map((row) => {
      const value = parts.get(row.message_id)?.find((part) => part.id === row.id)
      if (!value) throw fail("session_drift", `part ${row.id} could not be decoded`)
      return {
        key: `part/${row.message_id}/${row.id}`,
        type: "part" as const,
        data: jsonValue(value),
      }
    }),
    { key: "session_diff", type: "session_diff", data: [] },
    { key: "model", type: "model", data: session.model ? [jsonValue(session.model)] : [] },
  ]

  return {
    version: 1 as const,
    kind: input.kind,
    requestID: input.requestID,
    sessionID: input.sessionID,
    projectID,
    location,
    eventHighWaterMark: projection.eventHighWaterMark,
    export: { format: SessionShareSnapshot.FORMAT, items },
    target:
      input.kind === "unshare"
        ? {
            ...input.target,
            publication: {
              id: projection.publication!.publication_id,
              url: projection.publication!.publication_url,
              originalExportDigest: projection.publication!.export_digest,
            },
          }
        : input.target,
    heuristicScan: {
      scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
      excluded: [],
    },
  } satisfies SessionShareSnapshot.Capture
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const readProjection: (sessionID: SessionID) => Effect.Effect<RawProjection, unknown> = Effect.fnUntraced(
      function* (sessionID: SessionID) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const eventBefore =
              (yield* tx
                .select({ seq: EventSequenceTable.seq })
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, sessionID))
                .get())?.seq ?? -1
            const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
            if (!session) return yield* Effect.fail(fail("session_not_found", `Session ${sessionID} does not exist`))
            const messages = yield* tx
              .select()
              .from(MessageTable)
              .where(eq(MessageTable.session_id, sessionID))
              .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
              .limit(MAX_DATABASE_ROWS + 1)
              .all()
            const parts = yield* tx
              .select()
              .from(PartTable)
              .where(eq(PartTable.session_id, sessionID))
              .orderBy(asc(PartTable.message_id), asc(PartTable.id))
              .limit(MAX_DATABASE_ROWS + 1)
              .all()
            const eventAfter =
              (yield* tx
                .select({ seq: EventSequenceTable.seq })
                .from(EventSequenceTable)
                .where(eq(EventSequenceTable.aggregate_id, sessionID))
                .get())?.seq ?? -1
            if (messages.length + parts.length > MAX_DATABASE_ROWS)
              return yield* Effect.fail(
                fail("database_unavailable", `Session export exceeds ${MAX_DATABASE_ROWS} rows`),
              )
            if (eventBefore !== eventAfter)
              return yield* Effect.fail(fail("event_drift", "Session Event HWM changed inside the read transaction"))
            if (eventAfter < 0) return yield* Effect.fail(fail("session_not_found", "Session has no durable Event HWM"))
            const publication = session.share_url
              ? yield* tx
                  .select()
                  .from(SessionShareOperationReceiptTable)
                  .where(
                    and(
                      eq(SessionShareOperationReceiptTable.session_id, sessionID),
                      eq(SessionShareOperationReceiptTable.kind, "share"),
                      eq(SessionShareOperationReceiptTable.publication_url, session.share_url),
                    ),
                  )
                  .orderBy(desc(SessionShareOperationReceiptTable.time_created))
                  .limit(1)
                  .get()
              : undefined
            return { eventHighWaterMark: eventAfter, session, messages, parts, publication }
          }),
        )
      },
    )

    const capture: Interface["capture"] = (raw) =>
      Effect.gen(function* () {
        let input: CaptureInput
        try {
          input = Schema.decodeUnknownSync(CaptureInput, { errors: "all", onExcessProperty: "error" })(raw)
        } catch (cause) {
          return yield* Effect.fail(fail("invalid_request", `share capture request is invalid: ${String(cause)}`))
        }
        const context = yield* InstanceState.context.pipe(
          Effect.mapError((cause) =>
            fail("session_scope_mismatch", `active project context is unavailable: ${String(cause)}`),
          ),
        )
        const projectRoot = lexicalPath(context.worktree)
        const first = yield* readProjection(input.sessionID).pipe(
          Effect.mapError((error) => (isCaptureError(error) ? error : fail("database_unavailable", String(error)))),
        )
        const firstCapture = yield* Effect.try({
          try: () => buildCapture(input, first, context.project.id, projectRoot),
          catch: (cause) => (isCaptureError(cause) ? cause : fail("session_scope_mismatch", String(cause))),
        })
        const second = yield* readProjection(input.sessionID).pipe(
          Effect.mapError((error) => (isCaptureError(error) ? error : fail("database_unavailable", String(error)))),
        )
        const secondCapture = yield* Effect.try({
          try: () => buildCapture(input, second, context.project.id, projectRoot),
          catch: (cause) => (isCaptureError(cause) ? cause : fail("session_scope_mismatch", String(cause))),
        })
        const firstHash = canonicalHash(firstCapture)
        const secondHash = canonicalHash(secondCapture)
        if (
          !firstHash ||
          !secondHash ||
          first.eventHighWaterMark !== second.eventHighWaterMark ||
          firstHash !== secondHash
        )
          return yield* Effect.fail(fail("session_drift", "Session export or Event HWM changed during capture"))
        return yield* Effect.try({
          try: () => SessionShareSnapshot.encode(secondCapture),
          catch: (cause) => fail("session_drift", `static Session export could not be sealed: ${String(cause)}`),
        })
      })

    return Service.of({ capture })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as SessionShareReadonlyLocal from "./readonly-local"
