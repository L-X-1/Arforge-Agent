import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { Effect, Schema } from "effect"
import { MessageID, PartID, SessionID } from "./schema"
import { SessionRevertSnapshot } from "./revert-snapshot"

export const CaptureInput = Schema.Struct({
  requestID: Schema.String,
  kind: Schema.Literals(["revert", "unrevert"]),
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  partID: Schema.optional(PartID),
})
export type CaptureInput = typeof CaptureInput.Type

export const FailureReason = Schema.Literals([
  "invalid_request",
  "unsupported_operation",
  "database_unavailable",
  "session_not_found",
  "session_scope_mismatch",
  "session_projection_invalid",
  "target_not_found",
  "no_restore_files",
  "source_revision_unavailable",
  "snapshot_store_unavailable",
  "git_unavailable",
  "filesystem_unavailable",
  "unsupported_object",
  "resource_limit",
  "event_drift",
  "session_drift",
  "git_drift",
  "path_drift",
  "evidence_invalid",
])
export type FailureReason = typeof FailureReason.Type

export class CaptureError extends Schema.TaggedErrorClass<CaptureError>()("SessionRevertReadonlyInspector.Error", {
  reason: FailureReason,
  message: Schema.String,
}) {}

export type PlannedFile = {
  /** Case-preserving Git tree path. Never copied into the sealed payload. */
  readonly gitPath: string
  readonly relativePath: string
  readonly path: string
  readonly targetRevision: SessionRevertSnapshot.Preflight["sourceRevision"]
}

/**
 * One transactionally captured Session/Event projection. This is deliberately
 * not constructible from a sealed revert payload: the local Reader must derive
 * it from the durable Session projection and its Event aggregate.
 */
export type SessionObservation = {
  readonly kind?: CaptureInput["kind"]
  readonly sessionID: SessionID
  readonly projectID: string
  readonly projectRoot: string
  readonly location: string
  /** Trusted local legacy snapshot object database, derived from the raw Instance context rather than payload data. */
  readonly snapshotGitDir: string
  /** Only present for unrevert; loaded from the first revert's immutable receipt. */
  readonly preimageReceipt?: SessionRevertSnapshot.PreimageReceipt
  readonly target: SessionRevertSnapshot.Preflight["target"]
  readonly sessionRevision: string
  readonly eventHighWaterMark: number
  readonly targetRevisions: ReadonlyArray<SessionRevertSnapshot.Preflight["sourceRevision"]>
  readonly files: ReadonlyArray<PlannedFile>
}

export type RepositoryObservation = {
  readonly projectRootAnchor: SessionRevertSnapshot.Preflight["projectRootAnchor"]
  readonly locationAnchor: SessionRevertSnapshot.Preflight["locationAnchor"]
  readonly sourceRevision: SessionRevertSnapshot.Preflight["sourceRevision"]
  readonly headCommit: string
  readonly indexFingerprint: string
  readonly dirtyFingerprint: string
  readonly files: ReadonlyArray<SessionRevertSnapshot.Preflight["files"][number]>
}

export interface Reader {
  /** Must use one read-only DB transaction and bracket the projection with Event HWM reads. */
  readonly readSession: (input: CaptureInput) => Effect.Effect<SessionObservation, CaptureError>
  /** Must use only read-only Git and filesystem operations. */
  readonly readRepository: (session: SessionObservation) => Effect.Effect<RepositoryObservation, CaptureError>
}

export interface Interface {
  /** Independently capture live evidence twice and seal it. Payload-derived evidence is never accepted. */
  readonly capture: (input: unknown) => Effect.Effect<SessionRevertSnapshot.Snapshot, CaptureError>
}

const strictInput = Schema.decodeUnknownSync(CaptureInput, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const fail = (reason: FailureReason, message: string) => new CaptureError({ reason, message })

function checked<A>(body: () => A): Effect.Effect<A, CaptureError> {
  return Effect.try({
    try: body,
    catch: (cause) =>
      cause instanceof CaptureError
        ? cause
        : fail(
            "evidence_invalid",
            `capture failed closed: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
          ),
  })
}

function digest(value: unknown, label: string) {
  const result = canonicalHash(value)
  if (!result) throw fail("evidence_invalid", `${label} is not canonically serializable`)
  return result
}

function same(left: unknown, right: unknown, label: string) {
  return digest(left, label) === digest(right, label)
}

function gitEvidence(input: RepositoryObservation) {
  return {
    sourceRevision: input.sourceRevision,
    headCommit: input.headCommit,
    indexFingerprint: input.indexFingerprint,
    dirtyFingerprint: input.dirtyFingerprint,
    files: input.files.map((file) => ({
      relativePath: file.relativePath,
      path: file.path,
      preimage: file.preimage,
      target: file.target,
      targetRevision: file.targetRevision,
    })),
  }
}

function pathEvidence(input: RepositoryObservation) {
  return {
    projectRootAnchor: input.projectRootAnchor,
    locationAnchor: input.locationAnchor,
    files: input.files.map((file) => ({
      relativePath: file.relativePath,
      path: file.path,
      parentChain: file.parentChain,
      leaf: file.leaf,
      current: file.current,
    })),
  }
}

function assertPlan(session: SessionObservation, repository: RepositoryObservation) {
  const planned = session.files.map((file) => ({
    gitPath: file.gitPath,
    relativePath: file.relativePath,
    path: file.path,
    targetRevision: file.targetRevision,
  }))
  const captured = repository.files.map((file) => ({
    gitPath: session.files.find((plannedFile) => plannedFile.path === file.path)?.gitPath,
    relativePath: file.relativePath,
    path: file.path,
    targetRevision: file.targetRevision,
  }))
  if (!same(planned, captured, "restore plan"))
    throw fail("evidence_invalid", "repository evidence does not cover the exact Session-derived restore plan")
}

function assertRequestBinding(input: CaptureInput, session: SessionObservation) {
  if (session.sessionID !== input.sessionID)
    throw fail("evidence_invalid", "the live Session observation does not match the requested sessionID")
  if (input.kind === "revert") {
    if (session.target.messageID !== input.messageID)
      throw fail("evidence_invalid", "the live revert target does not match the requested messageID")
    if (session.target.partID !== input.partID)
      throw fail("evidence_invalid", "the live revert target does not match the requested partID")
    if ((session.target.partID === undefined) !== (session.target.partIndex === undefined))
      throw fail("evidence_invalid", "the live revert target has an incomplete part boundary")
  }
}

function seal(
  input: CaptureInput,
  session: SessionObservation,
  repository: RepositoryObservation,
): SessionRevertSnapshot.Snapshot {
  assertPlan(session, repository)
  try {
    return SessionRevertSnapshot.encode({
      version: 1,
      kind: input.kind,
      requestID: input.requestID,
      sessionID: session.sessionID,
      projectID: session.projectID,
      projectRoot: session.projectRoot,
      location: session.location,
      projectRootAnchor: repository.projectRootAnchor,
      locationAnchor: repository.locationAnchor,
      target: { ...session.target },
      sessionRevision: session.sessionRevision,
      eventHighWaterMark: session.eventHighWaterMark,
      sourceRevision: repository.sourceRevision,
      targetRevisions: [...session.targetRevisions],
      headCommit: repository.headCommit,
      indexFingerprint: repository.indexFingerprint,
      dirtyFingerprint: repository.dirtyFingerprint,
      files: repository.files.map((file) => ({
        ...file,
        parentChain: [...file.parentChain],
      })),
    })
  } catch (cause) {
    throw fail(
      "evidence_invalid",
      `captured evidence cannot be sealed: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
    )
  }
}

export function make(reader: Reader): Interface {
  const capture: Interface["capture"] = (raw) =>
    Effect.gen(function* () {
      let input: CaptureInput
      try {
        input = strictInput(raw)
      } catch (cause) {
        return yield* fail(
          "invalid_request",
          `capture request is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
        )
      }
      if (input.kind === "revert" && !input.messageID)
        return yield* fail("invalid_request", "revert capture requires a messageID")
      if (input.kind === "unrevert" && (input.messageID !== undefined || input.partID !== undefined))
        return yield* fail("invalid_request", "unrevert capture cannot carry a messageID or partID")

      const firstSession = yield* reader.readSession(input)
      yield* checked(() => assertRequestBinding(input, firstSession))
      const firstRepository = yield* reader.readRepository(firstSession)
      const secondSession = yield* reader.readSession(input)
      yield* checked(() => assertRequestBinding(input, secondSession))

      if (firstSession.eventHighWaterMark !== secondSession.eventHighWaterMark)
        return yield* fail("event_drift", "the durable Session Event high-water mark changed during capture")
      if (!(yield* checked(() => same(firstSession, secondSession, "Session observation"))))
        return yield* fail("session_drift", "the Session projection or exact restore plan changed during capture")

      const secondRepository = yield* reader.readRepository(secondSession)
      const finalSession = yield* reader.readSession(input)
      yield* checked(() => assertRequestBinding(input, finalSession))
      if (secondSession.eventHighWaterMark !== finalSession.eventHighWaterMark)
        return yield* fail(
          "event_drift",
          "the durable Session Event high-water mark changed during the final repository read",
        )
      if (!(yield* checked(() => same(secondSession, finalSession, "final Session observation"))))
        return yield* fail(
          "session_drift",
          "the Session projection or exact restore plan changed during the final repository read",
        )
      yield* checked(() => assertPlan(firstSession, firstRepository))
      yield* checked(() => assertPlan(finalSession, secondRepository))

      if (!(yield* checked(() => same(gitEvidence(firstRepository), gitEvidence(secondRepository), "Git evidence"))))
        return yield* fail(
          "git_drift",
          "HEAD, index, dirty state, or immutable Git object evidence changed during capture",
        )
      if (!(yield* checked(() => same(pathEvidence(firstRepository), pathEvidence(secondRepository), "path evidence"))))
        return yield* fail("path_drift", "a filesystem path, identity, or ordinary-file hash changed during capture")

      return yield* checked(() => seal(input, finalSession, secondRepository))
    })

  return { capture }
}

export * as SessionRevertReadonlyInspector from "./revert-readonly-inspector"
