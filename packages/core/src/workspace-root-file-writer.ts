import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import {
  readWorkspaceRootMutationStateAt,
  workspaceRootMutationStateDigest,
  type WorkspaceRootMutationPlan,
  type WorkspaceRootMutationRequest,
} from "./workspace-roots"
import {
  type WorkspaceRootMutationState,
  type WorkspaceRootRecoveryOutboxRecord,
  type WorkspaceRootRollbackArtifact,
  type WorkspaceRootWriterSeams,
  type WorkspaceRootWriterReason,
  WorkspaceRootWriterError,
} from "./workspace-root-writer"

export type WorkspaceRootFileWriterOptions = Readonly<{
  /** Explicit absolute profile directory; no default is inferred for writers. */
  readonly profileDirectory: string
  readonly primary: string
  readonly enabled?: boolean
  /** Test-only abrupt-stop hook; production callers must leave it unset. */
  readonly testFaultInjection?: (stage: WorkspaceRootFileWriterFaultStage) => void
}>

export type WorkspaceRootFileWriterFaultStage =
  | "after-journal-prepared"
  | "after-trusted-file"
  | "after-configured-file"
  | "after-journal-committed"

export type WorkspaceRootFileWriterPaths = Readonly<{
  readonly profileDirectory: string
  readonly trustedFile: string
  readonly configuredFile: string
  readonly writerDirectory: string
  readonly lockFile: string
  readonly journalFile: string
  readonly outboxFile: string
  readonly auditFile: string
  readonly rollbackDirectory: string
}>

/**
 * Read-only evidence returned before a production writer could ever be
 * enabled.  This is deliberately separate from the five-gate enablement
 * decision: a clean profile proves that the persisted boundary is inspectable,
 * not that production mutations are safe to expose.
 */
export type WorkspaceRootFileWriterPreflightCheck = Readonly<{
  readonly id: "profile" | "primary" | "state" | "journal" | "outbox" | "audit" | "rollback" | "lock"
  readonly status: "satisfied" | "pending" | "blocked"
  readonly observation: string
  readonly reason?: WorkspaceRootWriterReason
}>

export type WorkspaceRootFileWriterPreflight = Readonly<{
  readonly schema_version: 1
  readonly execution_mode: "read-only-workspace-root-writer-preflight"
  readonly side_effects: "none"
  readonly profile_directory: string
  readonly primary: string
  readonly status: "clear" | "blocked"
  readonly ready: boolean
  readonly checks: ReadonlyArray<WorkspaceRootFileWriterPreflightCheck>
  readonly blocking_reasons: ReadonlyArray<WorkspaceRootWriterReason>
}>

type FileJournal = Readonly<{
  readonly schemaVersion: 1
  readonly action: WorkspaceRootMutationRequest["action"]
  readonly intentDigest: string
  readonly phase: "prepared" | "committed"
  readonly before: WorkspaceRootMutationState
  readonly after: WorkspaceRootMutationState
  readonly rollbackArtifactID: string
}>

type FileLockOwner = Readonly<{
  readonly schemaVersion: 1
  readonly pid: number
  readonly createdAt: number
  readonly token: string
}>

const FILE_LOCK_OWNER_SCHEMA_VERSION = 1 as const

const digest = (value: string): string => createHash("sha256").update(value).digest("hex")

const profilePath = (value: string): string => {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0"))
    throw new WorkspaceRootWriterError("state_malformed")
  // Writers must be given an explicit absolute profile; unlike read-only
  // reporting, silently resolving a relative path could target the wrong user.
  if (!/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value)) throw new WorkspaceRootWriterError("state_malformed")
  return resolve(value)
}

export const workspaceRootFileWriterPaths = (profileDirectory: string): WorkspaceRootFileWriterPaths => {
  const profile = profilePath(profileDirectory)
  const writerDirectory = join(profile, ".workspace-root-writer")
  return {
    profileDirectory: profile,
    trustedFile: join(profile, "trusted_workspaces.json"),
    configuredFile: join(profile, "workspace_roots.json"),
    writerDirectory,
    lockFile: join(writerDirectory, "writer.lock"),
    journalFile: join(writerDirectory, "state-journal.json"),
    outboxFile: join(writerDirectory, "recovery-outbox.json"),
    auditFile: join(writerDirectory, "audit.json"),
    rollbackDirectory: join(writerDirectory, "rollback"),
  }
}

const sortedPaths = (paths: ReadonlyArray<string>): string[] =>
  [...paths].sort((left, right) => left.localeCompare(right))

const stateValue = (state: WorkspaceRootMutationState): Record<string, unknown> => ({
  trustedWorkspaces: sortedPaths(state.trustedWorkspaces),
  configuredRoots: sortedPaths(state.configuredRoots),
  digest: state.digest,
})

const sameDigest = (left: WorkspaceRootMutationState["digest"], right: WorkspaceRootMutationState["digest"]): boolean =>
  left.trusted === right.trusted && left.configured === right.configured

const sameState = (left: WorkspaceRootMutationState, right: WorkspaceRootMutationState): boolean =>
  sameDigest(left.digest, right.digest) &&
  JSON.stringify(sortedPaths(left.trustedWorkspaces)) === JSON.stringify(sortedPaths(right.trustedWorkspaces)) &&
  JSON.stringify(sortedPaths(left.configuredRoots)) === JSON.stringify(sortedPaths(right.configuredRoots))

const readJson = (file: string, reason: WorkspaceRootWriterReason = "state_malformed"): unknown | undefined => {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown
  } catch {
    throw new WorkspaceRootWriterError(reason)
  }
}

const isMutationAction = (value: unknown): value is WorkspaceRootMutationRequest["action"] =>
  value === "trust" || value === "add" || value === "remove"

const isMutationPhase = (value: unknown): value is WorkspaceRootRecoveryOutboxRecord["phase"] =>
  value === "prepared" || value === "committed" || value === "recovery_required"

const isSha256Digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

const isRollbackArtifactID = (value: unknown): value is string =>
  typeof value === "string" && /^workspace-rollback-[a-f0-9]{64}$/.test(value)

const hasExactObjectKeys = (
  record: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): boolean => {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(record)
  return (
    keys.every((key) => allowed.has(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  )
}

const digestFromValue = (
  value: unknown,
  reason: Extract<WorkspaceRootWriterReason, "outbox_unavailable" | "audit_unavailable">,
): WorkspaceRootMutationState["digest"] => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkspaceRootWriterError(reason)
  const record = value as Record<string, unknown>
  if (!isSha256Digest(record.trusted) || !isSha256Digest(record.configured)) throw new WorkspaceRootWriterError(reason)
  return Object.freeze({ trusted: record.trusted, configured: record.configured })
}

const samePersistedDigest = (
  left: WorkspaceRootMutationState["digest"],
  right: WorkspaceRootMutationState["digest"],
): boolean => left.trusted === right.trusted && left.configured === right.configured

/**
 * Decode the complete durable outbox shape before it can influence recovery.
 * The file is an integrity boundary, so accepting a phase-only object would
 * allow a corrupt marker to be treated as a safe, already-replayed record.
 */
const recoveryOutboxRecordFromValue = (value: unknown): WorkspaceRootRecoveryOutboxRecord => {
  const reason = "outbox_unavailable" as const
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkspaceRootWriterError(reason)
  const record = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(record, [
      "schemaVersion",
      "action",
      "intentDigest",
      "phase",
      "before",
      "after",
      "rollbackArtifactID",
    ]) ||
    record.schemaVersion !== 1 ||
    !isMutationAction(record.action) ||
    !isSha256Digest(record.intentDigest) ||
    !isMutationPhase(record.phase) ||
    !isRollbackArtifactID(record.rollbackArtifactID)
  )
    throw new WorkspaceRootWriterError(reason)
  const before = digestFromValue(record.before, reason)
  const after = digestFromValue(record.after, reason)
  // Every persisted record represents a changed mutation.  A same-image
  // marker cannot describe a valid CAS and is therefore corruption, not a
  // harmless duplicate.
  if (samePersistedDigest(before, after)) throw new WorkspaceRootWriterError(reason)
  return Object.freeze({
    schemaVersion: 1,
    action: record.action,
    intentDigest: record.intentDigest,
    phase: record.phase,
    before,
    after,
    rollbackArtifactID: record.rollbackArtifactID,
  })
}

/** Decode the append-only audit shape, tolerating the historical optional version field. */
const auditRecordFromValue = (value: unknown) => {
  const reason = "audit_unavailable" as const
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkspaceRootWriterError(reason)
  const record = value as Record<string, unknown>
  if (
    !hasExactObjectKeys(
      record,
      ["action", "intentDigest", "phase", "before", "after", "rollbackArtifactID"],
      ["schemaVersion"],
    ) ||
    (record.schemaVersion !== undefined && record.schemaVersion !== 1) ||
    !isMutationAction(record.action) ||
    !isSha256Digest(record.intentDigest) ||
    !isMutationPhase(record.phase) ||
    !isRollbackArtifactID(record.rollbackArtifactID)
  )
    throw new WorkspaceRootWriterError(reason)
  const before = digestFromValue(record.before, reason)
  const after = digestFromValue(record.after, reason)
  if (samePersistedDigest(before, after)) throw new WorkspaceRootWriterError(reason)
  return Object.freeze({
    action: record.action,
    intentDigest: record.intentDigest,
    phase: record.phase,
    before,
    after,
    rollbackArtifactID: record.rollbackArtifactID,
  })
}

const samePersistedRecord = (
  left: Pick<
    WorkspaceRootRecoveryOutboxRecord,
    "action" | "intentDigest" | "phase" | "before" | "after" | "rollbackArtifactID"
  >,
  right: Pick<
    WorkspaceRootRecoveryOutboxRecord,
    "action" | "intentDigest" | "phase" | "before" | "after" | "rollbackArtifactID"
  >,
): boolean =>
  left.action === right.action &&
  left.intentDigest === right.intentDigest &&
  left.phase === right.phase &&
  samePersistedDigest(left.before, right.before) &&
  samePersistedDigest(left.after, right.after) &&
  left.rollbackArtifactID === right.rollbackArtifactID

const assertCommittedAuditCoverage = (
  auditFile: string,
  outbox: ReadonlyArray<WorkspaceRootRecoveryOutboxRecord>,
): void => {
  const committed = outbox.filter((record) => record.phase === "committed")
  const value = readJson(auditFile, "audit_unavailable")
  if (value === undefined) {
    if (committed.length > 0) throw new WorkspaceRootWriterError("audit_unavailable")
    return
  }
  if (!Array.isArray(value)) throw new WorkspaceRootWriterError("audit_unavailable")
  const audit = value.map(auditRecordFromValue)
  for (const record of committed) {
    if (!audit.some((candidate) => samePersistedRecord(candidate, record)))
      throw new WorkspaceRootWriterError("audit_unavailable")
  }
  // An audit record without a matching durable outbox receipt cannot be
  // attributed to a committed mutation.  Keep the state owner fail-closed
  // instead of accepting an orphaned or manually copied audit line.
  for (const record of audit) {
    if (!outbox.some((candidate) => samePersistedRecord(candidate, record)))
      throw new WorkspaceRootWriterError("audit_unavailable")
  }
}

const assertRecoveryOutboxClear = (file: string): WorkspaceRootRecoveryOutboxRecord[] => {
  const value = readJson(file, "outbox_unavailable")
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new WorkspaceRootWriterError("outbox_unavailable")
  if (value.length > 1_024) throw new WorkspaceRootWriterError("outbox_unavailable")
  const records = value.map(recoveryOutboxRecordFromValue)
  for (const record of records) {
    if (record.phase === "recovery_required") throw new WorkspaceRootWriterError("recovery_required")
  }
  return records
}

const syncFile = (file: string): void => {
  let handle: number | undefined
  try {
    // Windows rejects fsync on a read-only descriptor (EPERM), while r+
    // remains compatible with the POSIX test owner and the atomic temp file.
    handle = openSync(file, "r+")
    fsyncSync(handle)
  } catch {
    throw new WorkspaceRootWriterError("state_malformed")
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // Preserve the fsync/open failure as the typed writer result.
      }
    }
  }
}

const syncDirectoryBestEffort = (directory: string): void => {
  let handle: number | undefined
  try {
    // Directory fsync is supported by the POSIX implementations used by the
    // test owner.  Windows may reject opening a directory; the file fsync and
    // journal still provide the recovery boundary in that environment.
    handle = openSync(directory, "r")
    fsyncSync(handle)
  } catch {
    // Directory metadata durability is best effort; never turn a committed
    // file replacement into an ambiguous mutation solely on Windows.
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // Best effort only.
      }
    }
  }
}

const writeJsonAtomically = (file: string, value: unknown): void => {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(value), "utf8")
    syncFile(temporary)
    renameSync(temporary, file)
    syncDirectoryBestEffort(dirname(file))
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // The original failure is intentionally the only user-visible result.
    }
    throw new WorkspaceRootWriterError("state_malformed")
  }
}

const stateFromValue = (value: unknown): WorkspaceRootMutationState => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new WorkspaceRootWriterError("state_malformed")
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.trustedWorkspaces) || !Array.isArray(record.configuredRoots))
    throw new WorkspaceRootWriterError("state_malformed")
  const trustedWorkspaces = record.trustedWorkspaces.map((item) => {
    if (typeof item !== "string") throw new WorkspaceRootWriterError("state_malformed")
    return item
  })
  const configuredRoots = record.configuredRoots.map((item) => {
    if (typeof item !== "string") throw new WorkspaceRootWriterError("state_malformed")
    return item
  })
  const stateDigest = workspaceRootMutationStateDigest({ trustedWorkspaces, configuredRoots })
  const presented = record.digest
  if (
    typeof presented !== "object" ||
    presented === null ||
    Array.isArray(presented) ||
    (presented as Record<string, unknown>).trusted !== stateDigest.trusted ||
    (presented as Record<string, unknown>).configured !== stateDigest.configured
  )
    throw new WorkspaceRootWriterError("state_malformed")
  return {
    trustedWorkspaces: Object.freeze(sortedPaths(trustedWorkspaces)),
    configuredRoots: Object.freeze(sortedPaths(configuredRoots)),
    digest: stateDigest,
  }
}

const journalFromValue = (value: unknown): FileJournal => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new WorkspaceRootWriterError("state_malformed")
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    (record.action !== "trust" && record.action !== "add" && record.action !== "remove") ||
    typeof record.intentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.intentDigest) ||
    (record.phase !== "prepared" && record.phase !== "committed") ||
    typeof record.rollbackArtifactID !== "string" ||
    !/^workspace-rollback-[a-f0-9]{64}$/.test(record.rollbackArtifactID)
  )
    throw new WorkspaceRootWriterError("state_malformed")
  const before = stateFromValue(record.before)
  const after = stateFromValue(record.after)
  if (sameState(before, after)) throw new WorkspaceRootWriterError("state_malformed")
  return {
    schemaVersion: 1,
    action: record.action,
    intentDigest: record.intentDigest,
    phase: record.phase,
    before,
    after,
    rollbackArtifactID: record.rollbackArtifactID,
  }
}

const artifactPath = (paths: WorkspaceRootFileWriterPaths, artifactID: string): string => {
  if (!/^workspace-rollback-[a-f0-9]{64}$/.test(artifactID)) throw new WorkspaceRootWriterError("state_malformed")
  return join(paths.rollbackDirectory, `${artifactID}.json`)
}

const writeStateFiles = (
  paths: WorkspaceRootFileWriterPaths,
  state: Pick<WorkspaceRootMutationState, "trustedWorkspaces" | "configuredRoots">,
  afterTrustedFile?: () => void,
): void => {
  const trustedWorkspaces = sortedPaths(state.trustedWorkspaces)
  const configuredRoots = sortedPaths(state.configuredRoots)
  // Each file is replaced atomically.  The journal below makes the pair
  // recoverable if the process stops between the two replacements.
  writeJsonAtomically(paths.trustedFile, { workspaces: trustedWorkspaces })
  afterTrustedFile?.()
  writeJsonAtomically(paths.configuredFile, { schema_version: 1, roots: configuredRoots })
}

const readOwnerState = (paths: WorkspaceRootFileWriterPaths, primary: string): WorkspaceRootMutationState => {
  try {
    // A post-CAS outbox/audit failure is an explicit manual-recovery boundary.
    // Never clear or overwrite that marker while trying to service a later
    // mutation; doing so would erase the only durable evidence of ambiguity.
    const outbox = assertRecoveryOutboxClear(paths.outboxFile)
    assertCommittedAuditCoverage(paths.auditFile, outbox)
    return readWorkspaceRootMutationStateAt(paths.profileDirectory, primary)
  } catch (error) {
    if (error instanceof WorkspaceRootWriterError) throw error
    throw new WorkspaceRootWriterError("state_malformed")
  }
}

const appendRecoveryRequiredOutbox = (
  paths: WorkspaceRootFileWriterPaths,
  records: ReadonlyArray<WorkspaceRootRecoveryOutboxRecord>,
  prepared: WorkspaceRootRecoveryOutboxRecord,
): void => {
  if (records.length >= 1_024) throw new WorkspaceRootWriterError("outbox_unavailable")
  try {
    writeJsonAtomically(paths.outboxFile, [...records, { ...prepared, phase: "recovery_required" as const }])
  } catch {
    // A recovery marker is the only safe result once the state files already
    // contain the post-image. If it cannot be made durable, retain the
    // journal and surface an unavailable outbox rather than guessing.
    throw new WorkspaceRootWriterError("outbox_unavailable")
  }
}

const recoverJournal = (paths: WorkspaceRootFileWriterPaths, primary: string): void => {
  const value = readJson(paths.journalFile)
  if (value === undefined) return
  const journal = journalFromValue(value)
  let current: WorkspaceRootMutationState | undefined
  try {
    current = readOwnerState(paths, primary)
  } catch (error) {
    // A malformed or unresolved recovery outbox is itself the durable
    // recovery boundary.  Do not let journal replay roll back state or delete
    // the journal while an operator still needs to inspect that evidence.
    if (
      error instanceof WorkspaceRootWriterError &&
      (error.reason === "recovery_required" || error.reason === "outbox_unavailable")
    )
      throw error
    current = undefined
  }
  // The read-only snapshot treats an absent state file as an empty list.  A
  // crash between the two replacements would therefore look identical to a
  // legitimate empty post-state unless both files are present.  Only a
  // complete pair may prove that a prepared/committed journal reached either
  // endpoint; a partial pair must take the rollback-artifact path below.
  const completeStatePair = existsSync(paths.trustedFile) && existsSync(paths.configuredFile)
  if (current && completeStatePair && sameState(current, journal.after)) {
    // The state files reached the post-image, but the process may have died
    // before appending the outbox `committed` receipt and audit record. A
    // matching prepared receipt makes this an ambiguous external side effect;
    // retain the journal and append a durable recovery-required marker instead
    // of exposing the state as an ordinary restart or silently replaying it.
    const outboxValue = readJson(paths.outboxFile, "outbox_unavailable")
    const outbox: WorkspaceRootRecoveryOutboxRecord[] =
      outboxValue === undefined
        ? []
        : Array.isArray(outboxValue)
          ? outboxValue.map(recoveryOutboxRecordFromValue)
          : (() => {
              throw new WorkspaceRootWriterError("outbox_unavailable")
            })()
    const matchesJournal = (record: WorkspaceRootRecoveryOutboxRecord): boolean =>
      record.action === journal.action &&
      record.intentDigest === journal.intentDigest &&
      record.rollbackArtifactID === journal.rollbackArtifactID &&
      samePersistedDigest(record.before, journal.before.digest) &&
      samePersistedDigest(record.after, journal.after.digest)
    const prepared = outbox.find((record) => record.phase === "prepared" && matchesJournal(record))
    const committed = outbox.some((record) => record.phase === "committed" && matchesJournal(record))
    if (prepared !== undefined && !committed) {
      appendRecoveryRequiredOutbox(paths, outbox, prepared)
      throw new WorkspaceRootWriterError("recovery_required")
    }
    if (!committed) throw new WorkspaceRootWriterError("outbox_unavailable")
    unlinkSync(paths.journalFile)
    return
  }
  if (journal.phase === "prepared" && current && completeStatePair && sameState(current, journal.before)) {
    unlinkSync(paths.journalFile)
    return
  }
  // A prepared journal with mixed/partial state is rolled back from the
  // immutable artifact.  A committed journal that is neither before nor after
  // is ambiguous and remains fail-closed for manual recovery.
  if (journal.phase !== "prepared") throw new WorkspaceRootWriterError("state_malformed")
  const artifact = readJson(artifactPath(paths, journal.rollbackArtifactID))
  if (artifact === undefined) throw new WorkspaceRootWriterError("state_malformed")
  const before = stateFromValue(artifact)
  if (!sameState(before, journal.before)) throw new WorkspaceRootWriterError("state_malformed")
  writeStateFiles(paths, before)
  unlinkSync(paths.journalFile)
}

const acquireLock = (paths: WorkspaceRootFileWriterPaths): number | undefined => {
  mkdirSync(paths.writerDirectory, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = openSync(paths.lockFile, "wx+")
      try {
        const owner: FileLockOwner = {
          schemaVersion: FILE_LOCK_OWNER_SCHEMA_VERSION,
          pid: process.pid,
          createdAt: Date.now(),
          token: randomUUID(),
        }
        writeFileSync(handle, JSON.stringify(owner), "utf8")
        fsyncSync(handle)
        syncDirectoryBestEffort(paths.writerDirectory)
        return handle
      } catch {
        try {
          closeSync(handle)
        } catch {
          // Preserve the typed acquisition failure.
        }
        try {
          if (existsSync(paths.lockFile)) unlinkSync(paths.lockFile)
        } catch {
          // Preserve the typed acquisition failure.
        }
        return undefined
      }
    } catch {
      if (attempt === 0 && recoverStaleLock(paths)) continue
      return undefined
    }
  }
  return undefined
}

const recoverStaleLock = (paths: WorkspaceRootFileWriterPaths): boolean => {
  let owner: FileLockOwner | undefined
  try {
    const parsed = JSON.parse(readFileSync(paths.lockFile, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    if (
      record.schemaVersion !== FILE_LOCK_OWNER_SCHEMA_VERSION ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.createdAt !== "number" ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt <= 0 ||
      typeof record.token !== "string" ||
      record.token.length < 8 ||
      record.token.length > 128
    )
      return false
    owner = {
      schemaVersion: FILE_LOCK_OWNER_SCHEMA_VERSION,
      pid: record.pid,
      createdAt: record.createdAt,
      token: record.token,
    }
  } catch {
    // Unknown or partially-written lock metadata is deliberately not guessed.
    return false
  }

  if (owner.pid === process.pid) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    // ESRCH proves the recorded owner is gone.  EPERM/EINVAL and all other
    // conditions remain fail-closed because the process may still be alive.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false
  }
  try {
    unlinkSync(paths.lockFile)
    syncDirectoryBestEffort(paths.writerDirectory)
    return true
  } catch {
    return false
  }
}

const releaseLock = (paths: WorkspaceRootFileWriterPaths, handle: number): void => {
  try {
    closeSync(handle)
  } finally {
    try {
      if (existsSync(paths.lockFile)) unlinkSync(paths.lockFile)
      syncDirectoryBestEffort(paths.writerDirectory)
    } catch {
      // A stale lock is fail-closed on the next operation.
    }
  }
}

type ExclusiveLockState = { handle?: number }

const withLock = <A>(paths: WorkspaceRootFileWriterPaths, operation: () => A, exclusive?: ExclusiveLockState): A => {
  // A concrete owner may hold the same OS lock across the complete commit
  // protocol.  Its seam callbacks re-enter this helper while that boundary
  // is active; avoid trying to create a second lock file in the same process.
  if (exclusive?.handle !== undefined) return operation()
  const handle = acquireLock(paths)
  if (handle === undefined) throw new WorkspaceRootWriterError("state_conflict")
  try {
    return operation()
  } finally {
    releaseLock(paths, handle)
  }
}

const preflightCheck = (
  id: WorkspaceRootFileWriterPreflightCheck["id"],
  status: WorkspaceRootFileWriterPreflightCheck["status"],
  observation: string,
  reason?: WorkspaceRootWriterReason,
): WorkspaceRootFileWriterPreflightCheck =>
  Object.freeze(reason === undefined ? { id, status, observation } : { id, status, observation, reason })

const preflightReason = (error: unknown, fallback: WorkspaceRootWriterReason): WorkspaceRootWriterReason =>
  error instanceof WorkspaceRootWriterError ? error.reason : fallback

/**
 * Inspect the production profile without acquiring a lock, repairing a
 * journal, creating directories, or changing any file.  The result is an
 * auditable, payload-free contract for the CLI/UI; it never turns a clean
 * profile into writer enablement (the aggregate five-gate decision remains
 * authoritative and fail-closed).
 */
export const inspectWorkspaceRootFileWriter = (input: {
  readonly profileDirectory: string
  readonly primary: string
}): WorkspaceRootFileWriterPreflight => {
  const requestedProfile = typeof input?.profileDirectory === "string" ? input.profileDirectory : ""
  const requestedPrimary = typeof input?.primary === "string" ? input.primary : ""
  let profile: string
  let primary: string
  try {
    profile = profilePath(requestedProfile)
    primary = profilePath(requestedPrimary)
  } catch {
    return Object.freeze({
      schema_version: 1,
      execution_mode: "read-only-workspace-root-writer-preflight" as const,
      side_effects: "none" as const,
      profile_directory: requestedProfile,
      primary: requestedPrimary,
      status: "blocked" as const,
      ready: false as const,
      checks: Object.freeze([
        preflightCheck("profile", "blocked", "profile/primary must be absolute paths", "state_malformed"),
        preflightCheck("primary", "blocked", "profile/primary must be absolute paths", "state_malformed"),
      ]),
      blocking_reasons: Object.freeze(["state_malformed"] as WorkspaceRootWriterReason[]),
    })
  }

  const paths = workspaceRootFileWriterPaths(profile)
  const checks: WorkspaceRootFileWriterPreflightCheck[] = []
  const stateReasons: WorkspaceRootWriterReason[] = []
  let state: WorkspaceRootMutationState | undefined

  let profileExists = false
  try {
    profileExists = existsSync(profile)
    if (profileExists && !statSync(profile).isDirectory()) {
      checks.push(preflightCheck("profile", "blocked", "present but not a directory", "state_malformed"))
      stateReasons.push("state_malformed")
    } else {
      checks.push(preflightCheck("profile", "satisfied", profileExists ? "directory" : "absent (empty baseline)"))
    }
  } catch {
    checks.push(preflightCheck("profile", "blocked", "not stat-able", "state_malformed"))
    stateReasons.push("state_malformed")
  }

  try {
    const primaryIsDirectory = statSync(primary).isDirectory()
    checks.push(
      preflightCheck(
        "primary",
        primaryIsDirectory ? "satisfied" : "blocked",
        primaryIsDirectory ? "directory" : "not a directory",
        primaryIsDirectory ? undefined : "state_malformed",
      ),
    )
    if (checks.at(-1)?.status === "blocked") stateReasons.push("state_malformed")
  } catch {
    checks.push(preflightCheck("primary", "blocked", "not a directory", "state_malformed"))
    stateReasons.push("state_malformed")
  }

  const trustedPresent = existsSync(paths.trustedFile)
  const configuredPresent = existsSync(paths.configuredFile)
  if (trustedPresent !== configuredPresent) {
    checks.push(
      preflightCheck(
        "state",
        "blocked",
        `trusted_workspaces.json=${trustedPresent ? "present" : "missing"}; workspace_roots.json=${
          configuredPresent ? "present" : "missing"
        }`,
        "state_malformed",
      ),
    )
    stateReasons.push("state_malformed")
  } else {
    try {
      state = readWorkspaceRootMutationStateAt(profile, primary)
      checks.push(preflightCheck("state", "satisfied", trustedPresent ? "valid" : "empty"))
    } catch (error) {
      const reason = preflightReason(error, "state_malformed")
      checks.push(preflightCheck("state", "blocked", "state files are malformed or inconsistent", reason))
      stateReasons.push(reason)
    }
  }

  let journal: FileJournal | undefined
  if (!existsSync(paths.journalFile)) {
    checks.push(preflightCheck("journal", "satisfied", "absent"))
  } else {
    try {
      const value = readJson(paths.journalFile, "state_malformed")
      journal = value === undefined ? undefined : journalFromValue(value)
      if (journal === undefined) throw new WorkspaceRootWriterError("state_malformed")
      checks.push(
        preflightCheck("journal", "pending", `${journal.phase} journal requires recovery`, "recovery_required"),
      )
      stateReasons.push("recovery_required")
    } catch (error) {
      const reason = preflightReason(error, "state_malformed")
      checks.push(preflightCheck("journal", "blocked", "journal is malformed", reason))
      stateReasons.push(reason)
    }
  }

  let outbox: WorkspaceRootRecoveryOutboxRecord[] = []
  try {
    outbox = assertRecoveryOutboxClear(paths.outboxFile)
    const prepared = new Set(
      outbox.filter((record) => record.phase === "prepared").map((record) => record.intentDigest),
    )
    const committed = new Set(
      outbox.filter((record) => record.phase === "committed").map((record) => record.intentDigest),
    )
    const unresolvedPrepared = [...prepared].some((intentDigest) => !committed.has(intentDigest))
    if (unresolvedPrepared) {
      checks.push(
        preflightCheck("outbox", "pending", "prepared receipt has no committed counterpart", "recovery_required"),
      )
      stateReasons.push("recovery_required")
    } else {
      checks.push(
        preflightCheck("outbox", "satisfied", outbox.length === 0 ? "absent or empty" : `covered (${outbox.length})`),
      )
    }
  } catch (error) {
    const reason = preflightReason(error, "outbox_unavailable")
    checks.push(preflightCheck("outbox", "blocked", "outbox cannot be decoded safely", reason))
    stateReasons.push(reason)
  }

  let audit: ReturnType<typeof auditRecordFromValue>[] = []
  try {
    const value = readJson(paths.auditFile, "audit_unavailable")
    if (value !== undefined && !Array.isArray(value)) throw new WorkspaceRootWriterError("audit_unavailable")
    audit = value === undefined ? [] : value.map(auditRecordFromValue)
    const committed = outbox.filter((record) => record.phase === "committed")
    const coverageMissing = committed.some(
      (record) => !audit.some((candidate) => samePersistedRecord(candidate, record)),
    )
    const orphanAudit = audit.some((record) => !outbox.some((candidate) => samePersistedRecord(candidate, record)))
    const recoveryMarked = audit.some((record) => record.phase === "recovery_required")
    if (coverageMissing) {
      checks.push(preflightCheck("audit", "blocked", "committed receipt is not covered by audit", "audit_unavailable"))
      stateReasons.push("audit_unavailable")
    } else if (orphanAudit) {
      checks.push(
        preflightCheck("audit", "blocked", "audit evidence has no matching outbox receipt", "audit_unavailable"),
      )
      stateReasons.push("audit_unavailable")
    } else if (recoveryMarked) {
      checks.push(preflightCheck("audit", "pending", "audit contains recovery-required evidence", "recovery_required"))
      stateReasons.push("recovery_required")
    } else {
      checks.push(
        preflightCheck("audit", "satisfied", audit.length === 0 ? "absent or empty" : `valid (${audit.length})`),
      )
    }
  } catch (error) {
    const reason = preflightReason(error, "audit_unavailable")
    checks.push(preflightCheck("audit", "blocked", "audit cannot be decoded safely", reason))
    stateReasons.push(reason)
  }

  const referencedArtifactIDs = [
    ...outbox.map((record) => record.rollbackArtifactID),
    ...audit.map((record) => record.rollbackArtifactID),
    ...(journal === undefined ? [] : [journal.rollbackArtifactID]),
  ]
  try {
    const rollbackDirectoryPresent = existsSync(paths.rollbackDirectory)
    if (rollbackDirectoryPresent && !statSync(paths.rollbackDirectory).isDirectory())
      throw new WorkspaceRootWriterError("rollback_unavailable")
    for (const artifactID of new Set(referencedArtifactIDs)) {
      const artifact = readJson(artifactPath(paths, artifactID), "rollback_unavailable")
      if (artifact === undefined) throw new WorkspaceRootWriterError("rollback_unavailable")
      stateFromValue(artifact)
    }
    checks.push(
      preflightCheck(
        "rollback",
        "satisfied",
        referencedArtifactIDs.length === 0
          ? rollbackDirectoryPresent
            ? "directory present"
            : "absent"
          : `valid (${new Set(referencedArtifactIDs).size})`,
      ),
    )
  } catch (error) {
    const reason = preflightReason(error, "rollback_unavailable")
    checks.push(preflightCheck("rollback", "blocked", "rollback evidence is missing or malformed", reason))
    stateReasons.push(reason)
  }

  let writerDirectoryIsDirectory = false
  try {
    writerDirectoryIsDirectory = existsSync(paths.writerDirectory) && statSync(paths.writerDirectory).isDirectory()
    if (existsSync(paths.writerDirectory) && !writerDirectoryIsDirectory) {
      checks.push(
        preflightCheck("lock", "blocked", "writer path is not a directory; no mutation attempted", "state_malformed"),
      )
      stateReasons.push("state_malformed")
    } else if (existsSync(paths.lockFile)) {
      checks.push(
        preflightCheck("lock", "blocked", "writer lock is present; no stale-lock deletion attempted", "state_conflict"),
      )
      stateReasons.push("state_conflict")
    } else {
      checks.push(preflightCheck("lock", "satisfied", "absent"))
    }
  } catch {
    checks.push(
      preflightCheck("lock", "blocked", "writer path is not stat-able; no mutation attempted", "state_malformed"),
    )
    stateReasons.push("state_malformed")
  }

  const committed = outbox.filter((record) => record.phase === "committed")
  if (state !== undefined && committed.length > 0 && !samePersistedDigest(state.digest, committed.at(-1)!.after)) {
    const index = checks.findIndex((check) => check.id === "state")
    if (index >= 0)
      checks[index] = preflightCheck(
        "state",
        "blocked",
        "state digest differs from latest committed receipt",
        "state_malformed",
      )
    stateReasons.push("state_malformed")
  }

  const blockingReasons = [...new Set(stateReasons)]
  return Object.freeze({
    schema_version: 1,
    execution_mode: "read-only-workspace-root-writer-preflight" as const,
    side_effects: "none" as const,
    profile_directory: profile,
    primary,
    status: blockingReasons.length === 0 ? ("clear" as const) : ("blocked" as const),
    ready: blockingReasons.length === 0,
    checks: Object.freeze(checks),
    blocking_reasons: Object.freeze(blockingReasons),
  })
}

/**
 * Build the concrete local state owner used only by isolated TS/Core tests or
 * an explicitly enabled migration.  The CLI never calls this factory yet.
 */
export const makeWorkspaceRootFileWriter = (options: WorkspaceRootFileWriterOptions): WorkspaceRootWriterSeams => {
  const paths = workspaceRootFileWriterPaths(options.profileDirectory)
  const primary = options.primary
  const enabled = options.enabled === true
  const testFaultInjection = options.testFaultInjection
  const exclusive: ExclusiveLockState = {}
  return {
    enabled,
    readState: () => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              recoverJournal(paths, primary)
              return readOwnerState(paths, primary)
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    targetIsDirectory: (target) =>
      Effect.sync(() => {
        try {
          return statSync(target).isDirectory()
        } catch {
          return false
        }
      }),
    createRollbackArtifact: ({ before, plan }) => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              const artifactID = `workspace-rollback-${digest(JSON.stringify({ before: stateValue(before), intentDigest: plan.intentDigest }))}`
              const file = artifactPath(paths, artifactID)
              const existing = readJson(file, "rollback_unavailable")
              if (existing !== undefined && !sameState(stateFromValue(existing), before))
                throw new WorkspaceRootWriterError("rollback_unavailable")
              if (existing === undefined) writeJsonAtomically(file, stateValue(before))
              return { artifactID, stateDigest: before.digest } satisfies WorkspaceRootRollbackArtifact
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    appendRecoveryOutbox: (record: WorkspaceRootRecoveryOutboxRecord) => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              const normalized = recoveryOutboxRecordFromValue(record)
              const existing = readJson(paths.outboxFile, "outbox_unavailable")
              if (existing !== undefined && !Array.isArray(existing))
                throw new WorkspaceRootWriterError("outbox_unavailable")
              const records = existing === undefined ? [] : existing.map(recoveryOutboxRecordFromValue)
              const key = `${normalized.intentDigest}:${normalized.phase}`
              if (records.some((item) => `${item.intentDigest}:${item.phase}` === key)) return
              if (records.length >= 1_024) throw new WorkspaceRootWriterError("outbox_unavailable")
              writeJsonAtomically(paths.outboxFile, [...records, normalized])
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    compareAndSwap: ({
      action,
      intentDigest,
      expected,
      nextTrustedWorkspaces,
      nextConfiguredRoots,
      rollbackArtifactID,
    }) => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              recoverJournal(paths, primary)
              const current = readOwnerState(paths, primary)
              if (!sameDigest(current.digest, expected)) return false
              const nextDigest = workspaceRootMutationStateDigest({
                trustedWorkspaces: nextTrustedWorkspaces,
                configuredRoots: nextConfiguredRoots,
              })
              const next: WorkspaceRootMutationState = {
                trustedWorkspaces: Object.freeze(sortedPaths(nextTrustedWorkspaces)),
                configuredRoots: Object.freeze(sortedPaths(nextConfiguredRoots)),
                digest: nextDigest,
              }
              const journal: FileJournal = {
                schemaVersion: 1,
                action,
                intentDigest,
                phase: "prepared",
                before: current,
                after: next,
                rollbackArtifactID,
              }
              writeJsonAtomically(paths.journalFile, journal)
              testFaultInjection?.("after-journal-prepared")
              writeStateFiles(paths, next, () => testFaultInjection?.("after-trusted-file"))
              testFaultInjection?.("after-configured-file")
              writeJsonAtomically(paths.journalFile, { ...journal, phase: "committed" })
              testFaultInjection?.("after-journal-committed")
              unlinkSync(paths.journalFile)
              return true
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    audit: (record) => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              const normalized = auditRecordFromValue(record)
              const existing = readJson(paths.auditFile, "audit_unavailable")
              if (existing !== undefined && !Array.isArray(existing))
                throw new WorkspaceRootWriterError("audit_unavailable")
              const records = existing === undefined ? [] : existing.map(auditRecordFromValue)
              const key = `${normalized.intentDigest}:${normalized.phase}`
              if (records.some((item) => `${item.intentDigest}:${item.phase}` === key)) return
              if (records.length >= 4_096) throw new WorkspaceRootWriterError("audit_unavailable")
              writeJsonAtomically(paths.auditFile, [...records, normalized])
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    findExactCommittedMutation: ({ action, intentDigest, before, after }) => {
      if (!enabled) return Effect.fail(new WorkspaceRootWriterError("writer_disabled"))
      return Effect.try({
        try: () =>
          withLock(
            paths,
            () => {
              recoverJournal(paths, primary)
              const value = readJson(paths.outboxFile, "outbox_unavailable")
              if (value === undefined) return undefined
              if (!Array.isArray(value)) throw new WorkspaceRootWriterError("outbox_unavailable")
              const records = value.map(recoveryOutboxRecordFromValue)
              // Any unresolved recovery marker keeps the owner fail-closed,
              // even when a matching committed line is also present.
              if (records.some((record) => record.phase === "recovery_required")) return undefined
              const committed = records.find(
                (record) =>
                  record.phase === "committed" &&
                  record.action === action &&
                  record.intentDigest === intentDigest &&
                  samePersistedDigest(record.before, before) &&
                  samePersistedDigest(record.after, after),
              )
              if (committed === undefined) return undefined
              assertCommittedAuditCoverage(paths.auditFile, records)
              const artifact = readJson(artifactPath(paths, committed.rollbackArtifactID), "rollback_unavailable")
              if (artifact === undefined || !samePersistedDigest(stateFromValue(artifact).digest, before))
                throw new WorkspaceRootWriterError("rollback_unavailable")
              return {
                artifactID: committed.rollbackArtifactID,
                stateDigest: before,
              } satisfies WorkspaceRootRollbackArtifact
            },
            exclusive,
          ),
        catch: (error) => error,
      })
    },
    withExclusive: <A>(operation: () => Effect.Effect<A, unknown, never>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          if (exclusive.handle !== undefined) return yield* Effect.fail(new WorkspaceRootWriterError("state_conflict"))
          // The lock is a cross-process serialization boundary.  A competing
          // writer is expected during an idempotent replay, so wait briefly
          // for the owner instead of turning normal contention into a
          // permanent state conflict.  The bound remains fail-closed if an
          // owner disappears without a recoverable stale-lock proof.
          for (let attempt = 0; attempt < 1_000; attempt += 1) {
            const handle = acquireLock(paths)
            if (handle !== undefined) {
              exclusive.handle = handle
              return handle
            }
            yield* Effect.sleep("5 millis")
          }
          return yield* Effect.fail(new WorkspaceRootWriterError("state_conflict"))
        }),
        () => operation(),
        (handle) =>
          Effect.sync(() => {
            if (exclusive.handle === handle) exclusive.handle = undefined
            releaseLock(paths, handle)
          }),
      ),
  }
}
