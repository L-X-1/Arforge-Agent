export * as SessionRevertControlExecutor from "./session-revert-executor"

import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { Database } from "@arforge-ai/core/database/database"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import { Global } from "@arforge-ai/core/global"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Snapshot } from "@/snapshot"
import { Session } from "@/session/session"
import { SessionRevertReadonlyInspector } from "@/session/revert-readonly-inspector"
import { SessionRevertReadonlyLocal } from "@/session/revert-readonly-local"
import { SessionRevertSnapshot } from "@/session/revert-snapshot"
import { SessionRevertControlWorker } from "./session-revert-worker"
import path from "node:path"
import * as fsp from "node:fs/promises"
import { createHash } from "node:crypto"

const ReceiptFile = Schema.Struct({
  path: Schema.String,
  relativePath: Schema.String,
  expected: Schema.Unknown,
  actual: Schema.Unknown,
})

export const ExecutionResult = Schema.Struct({
  operation: Schema.Literals(["revert", "unrevert"]),
  receiptDigest: Schema.String,
  files: Schema.Array(ReceiptFile),
  sessionEventHighWaterMark: Schema.Int,
})
export type ExecutionResult = typeof ExecutionResult.Type

const same = (left: unknown, right: unknown) => {
  const a = canonicalHash(left)
  return a !== undefined && a === canonicalHash(right)
}

const canonicalPath = (value: string) => {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

const receiptPath = (projectID: string, sessionID: string, digest: string) =>
  path.join(Global.Path.data, "revert-receipts", projectID, sessionID, `${digest}.json`)

const actionError = (actionID: AgentRuntime.ActionID, reason: string) =>
  new ActionGateway.BlockedError({ actionID, reason })

const recoveryError = (actionID: AgentRuntime.ActionID, reason: string) =>
  new ActionGateway.RecoveryRequiredError({ actionID, reason })

async function inspectFile(file: SessionRevertSnapshot.Snapshot["files"][number]) {
  const expected = file.target
  try {
    const stat = await fsp.lstat(file.path)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("target path is not an ordinary file")
    const realPath = canonicalPath(await fsp.realpath(file.path))
    if (realPath !== canonicalPath(file.path)) throw new Error("target path crosses a symlink or junction")
    const bytes = await fsp.readFile(file.path)
    const actual = {
      kind: "file" as const,
      object: "blob" as const,
      mode: (stat.mode & 0o111) === 0o111 ? ("100755" as const) : ("100644" as const),
      hash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    }
    return { expected, actual }
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return { expected, actual: { kind: "absent" as const, hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH } }
    throw cause
  }
}

export type Error = ActionGateway.BlockedError | ActionGateway.RecoveryRequiredError

export const make = (input: {
  readonly durable: DurableRun.Interface
  readonly snapshot: Snapshot.Interface
  readonly sessions: Session.Interface
  readonly inspector: SessionRevertReadonlyInspector.Interface
  readonly fs: FSUtil.Interface
  readonly database: Database.Interface
}): SessionRevertControlWorker.SealedExecutor<SessionRevertSnapshot.Snapshot, Error> => ({
  execute: Effect.fn("SessionRevertControlExecutor.execute")(function* (command) {
    const { snapshot, runID, actionID, controlLease, authorization } = command

    const owned = yield* input.durable
      .validateControlLease(controlLease)
      .pipe(Effect.mapError(() => actionError(actionID, "The control run lease is no longer valid.")))
    if (owned.run.id !== runID || owned.run.status !== "running")
      return yield* actionError(actionID, "The durable control run is not in an owned running state.")

    let grant: AgentRuntime.AuthorizationGrant | undefined
    try {
      grant = ActionGateway.capabilityGrant(authorization)
      const material = SessionRevertSnapshot.actionMaterial(snapshot)
      const plan = SessionRevertSnapshot.authorizationPlan(snapshot)
      if (
        !grant ||
        grant.subject?.type !== "control-plane" ||
        ActionGateway.capabilityAuthority(authorization) !== "human" ||
        grant.actionID !== actionID ||
        grant.runID !== runID ||
        grant.subject.id !== owned.run.subject.id ||
        canonicalHash(ActionGateway.capabilityRequests(authorization)) !== canonicalHash(plan.requests) ||
        owned.run.operation.actionID !== actionID ||
        owned.run.operation.inputDigest !== material.inputDigest
      )
        return yield* actionError(actionID, "The authorization grant does not match the sealed session revert.")
    } catch {
      return yield* actionError(actionID, "The authorization grant capability is invalid.")
    }

    const fenceInput = {
      requestID: snapshot.requestID,
      kind: snapshot.kind,
      sessionID: snapshot.sessionID,
      ...(snapshot.kind === "revert"
        ? {
            messageID: snapshot.target.messageID,
            ...(snapshot.target.partID !== undefined ? { partID: snapshot.target.partID } : {}),
          }
        : {}),
    }
    const fenced = yield* input.inspector
      .capture(fenceInput)
      .pipe(Effect.mapError((error) => actionError(actionID, `The approval fence changed: ${error.message}`)))
    if (!same(SessionRevertSnapshot.claimMaterial(fenced).input, SessionRevertSnapshot.claimMaterial(snapshot).input))
      return yield* actionError(actionID, "The Session, Event, Git, or filesystem fence changed after approval.")

    const receipt =
      snapshot.kind === "revert"
        ? SessionRevertSnapshot.preimageReceipt(snapshot)
        : yield* Effect.gen(function* () {
            const session = yield* input.sessions
              .get(snapshot.sessionID)
              .pipe(
                Effect.mapError(() =>
                  actionError(actionID, "The Session projection could not be reread for unrevert."),
                ),
              )
            const digest = session.revert?.snapshot
            if (!digest || !/^[0-9a-f]{64}$/.test(digest))
              return yield* recoveryError(
                actionID,
                "The first revert's immutable receipt reference is absent or invalid.",
              )
            const receiptFile = receiptPath(snapshot.projectID, String(snapshot.sessionID), digest)
            const existing = yield* input.fs.readFileStringSafe(receiptFile).pipe(Effect.orDie)
            if (existing === undefined)
              return yield* recoveryError(actionID, "The first revert's immutable preimage receipt is unavailable.")
            let decoded: SessionRevertSnapshot.PreimageReceipt
            try {
              decoded = SessionRevertSnapshot.decodePreimageReceipt(JSON.parse(existing))
            } catch {
              return yield* recoveryError(actionID, "The first revert's immutable preimage receipt is invalid.")
            }
            const expectedFiles = decoded.files.map((file) => ({
              path: file.path,
              relativePath: file.relativePath,
              current: file.target,
              target: file.preimage,
              targetRevision: { kind: "commit" as const, id: decoded.headCommit },
            }))
            const actualFiles = snapshot.files.map((file) => ({
              path: file.path,
              relativePath: file.relativePath,
              current: file.current,
              target: file.target,
              targetRevision: file.targetRevision,
            }))
            if (
              decoded.digest !== digest ||
              decoded.sessionID !== snapshot.sessionID ||
              decoded.projectID !== snapshot.projectID ||
              !same(decoded.target, snapshot.target) ||
              !same(expectedFiles, actualFiles)
            )
              return yield* recoveryError(
                actionID,
                "The sealed unrevert does not match the first immutable preimage receipt.",
              )
            return decoded
          })
    const receiptFile = receiptPath(snapshot.projectID, String(snapshot.sessionID), receipt.digest)
    if (snapshot.kind === "revert") {
      const serialized = JSON.stringify(receipt)
      const existing = yield* input.fs.readFileStringSafe(receiptFile).pipe(Effect.orDie)
      if (existing !== undefined) {
        try {
          if (!same(SessionRevertSnapshot.decodePreimageReceipt(JSON.parse(existing)), receipt))
            return yield* recoveryError(actionID, "The preimage receipt path contains a different immutable receipt.")
        } catch {
          return yield* recoveryError(actionID, "The preimage receipt path contains invalid immutable data.")
        }
      } else {
        yield* input.fs
          .writeWithDirs(receiptFile, serialized, 0o600)
          .pipe(Effect.mapError(() => recoveryError(actionID, "The immutable preimage receipt could not be written.")))
      }
    }

    yield* input.durable
      .checkpointControl(controlLease, {
        runID,
        state: {
          kind: "preimage-receipt",
          receiptDigest: receipt.digest,
          receiptPath: receiptFile,
          files: receipt.files,
        },
        lastActionID: actionID,
      })
      .pipe(Effect.mapError(() => recoveryError(actionID, "The preimage receipt checkpoint could not be persisted.")))

    // The worker has completed all capability checks and the live fence. No
    // code below this signal re-derives the request or accepts caller data.
    yield* command.controlLeaseValidated()

    const grouped = new Map<string, string[]>()
    for (const file of snapshot.files) {
      const list = grouped.get(file.targetRevision.id) ?? []
      list.push(file.path)
      grouped.set(file.targetRevision.id, list)
    }
    yield* input.snapshot
      .revert([...grouped].map(([hash, files]) => ({ hash, files })))
      .pipe(Effect.mapError(() => recoveryError(actionID, "The approved restore did not complete cleanly.")))

    const outcomes: Array<Schema.Schema.Type<typeof ReceiptFile>> = []
    for (const file of snapshot.files) {
      const result = yield* Effect.tryPromise({
        try: () => inspectFile(file),
        catch: () => recoveryError(actionID, `Verifier could not read ${file.path}.`),
      })
      if (!result || !same(result.actual, file.target))
        return yield* recoveryError(actionID, `Verifier found mixed or unknown filesystem state at ${file.path}.`)
      outcomes.push({ path: file.path, relativePath: file.relativePath, expected: file.target, actual: result.actual })
    }

    if (snapshot.kind === "revert") {
      const revertState = {
        messageID: snapshot.target.messageID,
        ...(snapshot.target.partID !== undefined ? { partID: snapshot.target.partID } : {}),
        snapshot: receipt.digest,
        files: [],
      }
      yield* input.sessions
        .setRevert({
          sessionID: snapshot.sessionID,
          revert: revertState,
          summary: { additions: 0, deletions: 0, files: outcomes.length },
        })
        .pipe(Effect.mapError(() => recoveryError(actionID, "The Session revert state could not be committed.")))
    } else {
      yield* input.sessions
        .clearRevert(snapshot.sessionID)
        .pipe(Effect.mapError(() => recoveryError(actionID, "The Session unrevert state could not be committed.")))
    }

    const session = yield* input.sessions
      .get(snapshot.sessionID)
      .pipe(Effect.mapError(() => recoveryError(actionID, "The Session projection could not be reread after restore.")))
    const sequence =
      (yield* input.database.db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, snapshot.sessionID))
        .get()
        .pipe(Effect.orDie))?.seq ?? -1
    if (
      (snapshot.kind === "revert" ? session.revert?.snapshot !== receipt.digest : session.revert !== undefined) ||
      sequence <= snapshot.eventHighWaterMark
    )
      return yield* recoveryError(actionID, "The independent Session/Event verifier found an incomplete restore.")

    const result = {
      operation: snapshot.kind,
      receiptDigest: receipt.digest,
      files: outcomes,
      sessionEventHighWaterMark: sequence,
    }
    yield* input.durable
      .checkpointControl(controlLease, {
        runID,
        state: { kind: "verified", observation: result },
        lastActionID: actionID,
      })
      .pipe(Effect.mapError(() => recoveryError(actionID, "The verified restore observation could not be persisted.")))
  }),
})

export const fromServices: Effect.Effect<
  SessionRevertControlWorker.SealedExecutor<SessionRevertSnapshot.Snapshot, Error>,
  never,
  | DurableRun.Service
  | Snapshot.Service
  | Session.Service
  | SessionRevertReadonlyLocal.Service
  | FSUtil.Service
  | Database.Service
> = Effect.gen(function* () {
  return make({
    durable: yield* DurableRun.Service,
    snapshot: yield* Snapshot.Service,
    sessions: yield* Session.Service,
    inspector: yield* SessionRevertReadonlyLocal.Service,
    fs: yield* FSUtil.Service,
    database: yield* Database.Service,
  })
})
