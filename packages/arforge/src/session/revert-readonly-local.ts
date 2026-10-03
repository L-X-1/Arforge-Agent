import { AppProcess } from "@arforge-ai/core/process"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import { Global } from "@arforge-ai/core/global"
import { MessageTable, PartTable, SessionTable } from "@arforge-ai/core/session/sql"
import { Hash } from "@arforge-ai/core/util/hash"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { asc, eq } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { constants, type BigIntStats } from "node:fs"
import * as fsp from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "./session"
import {
  CaptureError,
  type CaptureInput,
  type FailureReason,
  type Interface,
  type PlannedFile,
  type Reader,
  type RepositoryObservation,
  type SessionObservation,
  make,
} from "./revert-readonly-inspector"
import { SessionRevertSnapshot } from "./revert-snapshot"

const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024
export const MAX_FILE_CONTENT_BYTES = 64 * 1024 * 1024
export const MAX_OBSERVATION_CONTENT_BYTES = 256 * 1024 * 1024
const MAX_DATABASE_ROWS = 250_000
const HASH_BUFFER_BYTES = 64 * 1024

/** Every Git subcommand reachable from capture. The runner rejects anything else before spawning Git. */
export const READ_ONLY_GIT_SUBCOMMANDS = ["cat-file", "ls-files", "ls-tree", "rev-parse", "status"] as const
const readOnlyGitSubcommands = new Set<string>(READ_ONLY_GIT_SUBCOMMANDS)

export function permitsGitSubcommand(input: string) {
  return readOnlyGitSubcommands.has(input)
}

type SessionRow = typeof SessionTable.$inferSelect
type MessageRow = typeof MessageTable.$inferSelect
type PartRow = typeof PartTable.$inferSelect

type SessionTransaction = {
  readonly eventBefore: number
  readonly eventAfter: number
  readonly session: SessionRow | undefined
  readonly messages: ReadonlyArray<MessageRow>
  readonly parts: ReadonlyArray<PartRow>
}

type GitBoundary = {
  readonly headCommit: string
  readonly index: Buffer
  readonly indexFingerprint: string
  readonly dirty: Buffer
}

type TreeContent = {
  readonly content: SessionRevertSnapshot.Preflight["files"][number]["preimage"]
  readonly objectID?: string
}

type DirectoryCapture = {
  readonly evidence: SessionRevertSnapshot.Preflight["projectRootAnchor"]
  readonly stamp: string
}

type CurrentCapture = Pick<SessionRevertSnapshot.Preflight["files"][number], "parentChain" | "leaf" | "current">

const fail = (reason: FailureReason, message: string) => new CaptureError({ reason, message })

export function checkContentBudget(totalBytes: number, fileBytes: number, label: string): number | CaptureError {
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > MAX_FILE_CONTENT_BYTES)
    return fail("resource_limit", `${label} exceeds the ${MAX_FILE_CONTENT_BYTES}-byte per-file content limit`)
  const next = totalBytes + fileBytes
  if (!Number.isSafeInteger(next) || next > MAX_OBSERVATION_CONTENT_BYTES)
    return fail("resource_limit", `${label} exceeds the ${MAX_OBSERVATION_CONTENT_BYTES}-byte observation limit`)
  return next
}

function errorText(cause: unknown) {
  return cause instanceof globalThis.Error ? cause.message : String(cause)
}

function missing(cause: unknown) {
  return Boolean(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
}

function lexicalPath(input: string) {
  if (!input || input.includes("\0") || /^\\\\[?.]\\/.test(input))
    throw fail("session_scope_mismatch", "a project path is empty, contains NUL, or uses a Windows device namespace")
  const value = path.normalize(path.resolve(input))
  return process.platform === "win32" ? value.toLowerCase() : value
}

function isWithin(root: string, target: string, allowRoot = true) {
  const relative = path.relative(root, target)
  if (!relative) return allowRoot
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function hash(input: string | Buffer) {
  return createHash("sha256").update(input).digest("hex")
}

function canonicalDigest(input: unknown, label: string) {
  const value = canonicalHash(input)
  if (!value) throw fail("evidence_invalid", `${label} is not canonically serializable`)
  return value
}

function same(left: unknown, right: unknown, label: string) {
  return canonicalDigest(left, label) === canonicalDigest(right, label)
}

function guarded<A>(body: () => A, reason: FailureReason, label: string): Effect.Effect<A, CaptureError> {
  return Effect.try({
    try: body,
    catch: (cause) => (cause instanceof CaptureError ? cause : fail(reason, `${label}: ${errorText(cause)}`)),
  })
}

function guardedPromise<A>(
  body: () => Promise<A>,
  reason: FailureReason,
  label: string,
): Effect.Effect<A, CaptureError> {
  return Effect.tryPromise({
    try: body,
    catch: (cause) => (cause instanceof CaptureError ? cause : fail(reason, `${label}: ${errorText(cause)}`)),
  })
}

function decodeProjection(input: SessionTransaction) {
  if (!input.session) throw fail("session_not_found", "the requested Session does not exist")
  if (input.messages.length + input.parts.length > MAX_DATABASE_ROWS)
    throw fail("resource_limit", `the Session projection exceeds ${MAX_DATABASE_ROWS} message and part rows`)

  const decodeSession = Schema.decodeUnknownSync(Session.Info)
  const decodeMessage = Schema.decodeUnknownSync(SessionV1.Info)
  const decodePart = Schema.decodeUnknownSync(SessionV1.Part)
  // fromRow intentionally materializes absent optionals as `undefined`, while
  // the strict schema decoder expects those keys to be omitted.
  const session = decodeSession(JSON.parse(JSON.stringify(Session.fromRow(input.session))))
  const parts = new Map<string, Array<typeof SessionV1.Part.Type>>()
  for (const row of input.parts) {
    if (row.session_id !== input.session.id)
      throw fail("session_projection_invalid", `part ${row.id} is attached to a different Session`)
    const value = decodePart({ ...row.data, id: row.id, sessionID: row.session_id, messageID: row.message_id })
    const list = parts.get(row.message_id)
    if (list) list.push(value)
    else parts.set(row.message_id, [value])
  }
  const messages = input.messages.map((row) => {
    const value = decodeMessage({ ...row.data, id: row.id, sessionID: row.session_id })
    return { info: value, parts: parts.get(row.id) ?? [] }
  })
  const known = new Set(input.messages.map((row) => row.id))
  for (const row of input.parts) {
    if (!known.has(row.message_id))
      throw fail("session_projection_invalid", `part ${row.id} refers to a missing message ${row.message_id}`)
  }
  return { session, messages }
}

function canonicalPlanPath(projectRoot: string, location: string, input: string) {
  if (!path.isAbsolute(input)) throw fail("session_projection_invalid", `patch path is not absolute: ${input}`)
  const casePreserving = path.normalize(path.resolve(input))
  const absolute = lexicalPath(input)
  if (!isWithin(projectRoot, absolute, false))
    throw fail("session_scope_mismatch", `patch path is outside the project root: ${input}`)
  if (!isWithin(location, absolute, false))
    throw fail("session_scope_mismatch", `patch path is outside the Session location: ${input}`)
  const gitPath = path.relative(projectRoot, casePreserving).split(path.sep).join("/")
  const relativePath = process.platform === "win32" ? gitPath.toLowerCase() : gitPath
  if (!relativePath || relativePath.split("/").some((segment) => !segment || segment === "." || segment === ".."))
    throw fail("session_projection_invalid", `patch path is not a canonical project-relative file: ${input}`)
  return { absolute, gitPath, relativePath }
}

function deriveRevertPlan(
  input: CaptureInput,
  projection: ReturnType<typeof decodeProjection>,
  projectRoot: string,
  location: string,
  projectID: string,
  preimageReceipt?: SessionRevertSnapshot.PreimageReceipt,
) {
  if (input.kind === "unrevert") {
    const stored = projection.session.revert
    if (!stored?.snapshot || !preimageReceipt)
      throw fail("source_revision_unavailable", "unrevert requires the first revert's immutable preimage receipt")
    if (
      preimageReceipt.sessionID !== input.sessionID ||
      preimageReceipt.projectID !== projectID ||
      preimageReceipt.digest !== stored.snapshot ||
      preimageReceipt.projectRoot !== projectRoot ||
      preimageReceipt.location !== location
    )
      throw fail("source_revision_unavailable", "the immutable preimage receipt does not match this Session scope")
    const targetMessageIndex = projection.messages.findIndex((message) => message.info.id === stored.messageID)
    if (targetMessageIndex < 0) throw fail("session_projection_invalid", "the stored revert boundary is absent")
    const targetMessage = projection.messages[targetMessageIndex]!
    const partIndex =
      stored.partID === undefined ? undefined : targetMessage.parts.findIndex((part) => part.id === stored.partID)
    if (stored.partID !== undefined && (partIndex === undefined || partIndex < 0))
      throw fail("session_projection_invalid", "the stored revert boundary part is absent")
    return {
      target: {
        messageID: stored.messageID,
        messageSequence: targetMessageIndex,
        ...(stored.partID !== undefined ? { partID: stored.partID, partIndex: partIndex! } : {}),
      },
      files: preimageReceipt.files.map((file) => ({
        gitPath: file.relativePath,
        relativePath: file.relativePath,
        path: file.path,
        targetRevision: { kind: "commit" as const, id: preimageReceipt.headCommit },
      })),
      targetRevisions: preimageReceipt.files.length
        ? [{ kind: "commit" as const, id: preimageReceipt.headCommit }]
        : [],
    }
  }
  if (!input.messageID) throw fail("invalid_request", "revert capture requires a messageID")
  if (projection.session.revert)
    throw fail(
      "source_revision_unavailable",
      "re-revert first restores a legacy mutable snapshot; a zero-write preflight cannot represent that two-stage source",
    )

  let lastUser: Extract<typeof SessionV1.Info.Type, { readonly role: "user" }> | undefined
  let boundary:
    | {
        readonly messageID: typeof input.messageID
        readonly partID?: typeof input.partID
      }
    | undefined
  let requestMessageFound = false
  let requestPartFound = input.partID === undefined
  const patches: Array<typeof SessionV1.PatchPart.Type> = []

  for (const message of projection.messages) {
    if (message.info.role === "user") lastUser = message.info
    if (message.info.id === input.messageID) requestMessageFound = true
    const remaining: Array<typeof SessionV1.Part.Type> = []
    for (const part of message.parts) {
      if (boundary) {
        if (part.type === "patch") patches.push(part)
        continue
      }
      const requestedPart =
        message.info.id === input.messageID && input.partID !== undefined && part.id === input.partID
      if (requestedPart) requestPartFound = true
      const requestedMessage = message.info.id === input.messageID && input.partID === undefined
      if (requestedMessage || requestedPart) {
        const partID = remaining.some((item) => item.type === "text" || item.type === "tool") ? input.partID : undefined
        boundary = {
          messageID: (!partID && lastUser ? lastUser.id : message.info.id) as typeof input.messageID,
          partID,
        }
      }
      remaining.push(part)
    }
  }

  if (!requestMessageFound) throw fail("target_not_found", `message ${input.messageID} is not in this Session`)
  if (!requestPartFound) throw fail("target_not_found", `part ${input.partID} is not in message ${input.messageID}`)
  if (!boundary)
    throw fail("target_not_found", "the target message has no legacy part boundary and cannot be reverted safely")

  const targetMessageSequence = projection.messages.findIndex((message) => message.info.id === input.messageID)
  if (targetMessageSequence < 0)
    throw fail("session_projection_invalid", "the requested revert boundary message is absent from the projection")
  const targetMessage = projection.messages[targetMessageSequence]!
  const targetPartIndex = input.partID ? targetMessage.parts.findIndex((part) => part.id === input.partID) : undefined
  if (targetPartIndex !== undefined && targetPartIndex < 0)
    throw fail("session_projection_invalid", "the requested revert boundary part is absent from its message")

  const files: PlannedFile[] = []
  const revisions = new Map<string, PlannedFile["targetRevision"]>()
  const seen = new Set<string>()
  for (const patch of patches) {
    const id = patch.hash.toLowerCase()
    if (!GIT_OBJECT.test(id))
      throw fail("session_projection_invalid", `patch ${patch.id} has no immutable snapshot tree ID`)
    const targetRevision = { kind: "snapshot" as const, id }
    revisions.set(id, targetRevision)
    for (const file of patch.files) {
      const planned = canonicalPlanPath(projectRoot, location, file)
      if (seen.has(planned.absolute)) continue
      seen.add(planned.absolute)
      if (files.length >= SessionRevertSnapshot.MAX_RESTORE_FILES)
        throw fail("resource_limit", `restore plan exceeds ${SessionRevertSnapshot.MAX_RESTORE_FILES} files`)
      files.push({
        gitPath: planned.gitPath,
        relativePath: planned.relativePath,
        path: planned.absolute,
        targetRevision,
      })
    }
  }
  // A conversation-only revert has no filesystem patches to restore. Keep the
  // empty plan: the sealed Session/Event/Git fence still protects the history
  // marker, while Snapshot.revert([]) is an explicit no-op before setRevert.
  files.sort((left, right) => left.path.localeCompare(right.path))
  const used = new Set(files.map((file) => file.targetRevision.id))
  const targetRevisions = [...revisions.values()]
    .filter((revision) => used.has(revision.id))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    target: {
      messageID: input.messageID,
      messageSequence: targetMessageSequence,
      ...(input.partID === undefined
        ? {}
        : {
            partID: input.partID,
            partIndex: targetPartIndex!,
          }),
    },
    files,
    targetRevisions,
  }
}

function deriveSessionObservation(
  input: CaptureInput,
  raw: SessionTransaction,
  context: { readonly directory: string; readonly worktree: string; readonly projectID: string },
  preimageReceipt?: SessionRevertSnapshot.PreimageReceipt,
): SessionObservation {
  if (raw.eventBefore !== raw.eventAfter)
    throw fail("event_drift", "the durable Session Event high-water mark changed inside the DB read transaction")
  if (raw.eventAfter < 0) throw fail("session_projection_invalid", "the Session has no durable Event aggregate")
  const projection = decodeProjection(raw)
  const projectRoot = lexicalPath(context.worktree)
  const location = lexicalPath(context.directory)
  if (projection.session.id !== input.sessionID)
    throw fail("session_projection_invalid", "the DB projection returned a different Session")
  if (projection.session.projectID !== context.projectID)
    throw fail("session_scope_mismatch", "the Session project does not match the active project")
  if (lexicalPath(projection.session.directory) !== location)
    throw fail("session_scope_mismatch", "the Session directory does not match the active local location")
  if (!isWithin(projectRoot, location))
    throw fail("session_scope_mismatch", "the active Session location is outside the project root")

  const revision = canonicalHash({ session: projection.session, messages: projection.messages })
  if (!revision) throw fail("session_projection_invalid", "the complete Session projection is not canonical JSON")
  const plan = deriveRevertPlan(input, projection, projectRoot, location, context.projectID, preimageReceipt)
  return {
    kind: input.kind,
    sessionID: input.sessionID,
    projectID: context.projectID,
    projectRoot,
    location,
    snapshotGitDir: lexicalPath(
      path.join(Global.Path.data, "snapshot", context.projectID, Hash.fast(context.worktree)),
    ),
    target: plan.target,
    sessionRevision: revision,
    eventHighWaterMark: raw.eventAfter,
    targetRevisions: plan.targetRevisions,
    files: plan.files,
    ...(preimageReceipt ? { preimageReceipt } : {}),
  }
}

function directoryStamp(info: BigIntStats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":")
}

async function captureDirectory(input: string, label: string): Promise<DirectoryCapture> {
  const target = lexicalPath(input)
  const info = await fsp.lstat(target, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink())
    throw fail("filesystem_unavailable", `${label} is not an ordinary no-follow directory`)
  const realPath = lexicalPath(await fsp.realpath(target))
  if (realPath !== target)
    throw fail("filesystem_unavailable", `${label} crosses a symlink, junction, or reparse boundary`)
  return {
    evidence: {
      path: target,
      realPath,
      device: String(info.dev),
      inode: String(info.ino),
      type: "directory",
    },
    stamp: directoryStamp(info),
  }
}

async function captureParentChain(projectRoot: string, location: string, file: string) {
  const parent = path.dirname(file)
  if (!isWithin(projectRoot, parent))
    throw fail("filesystem_unavailable", `file parent is outside the project root: ${file}`)
  const relative = path.relative(projectRoot, parent)
  const segments = relative ? relative.split(path.sep).filter(Boolean) : []
  const paths = [projectRoot]
  for (let index = 0; index < segments.length; index++)
    paths.push(lexicalPath(path.join(projectRoot, ...segments.slice(0, index + 1))))
  if (!paths.includes(location))
    throw fail("filesystem_unavailable", `file parent chain does not pass through the Session location: ${file}`)
  const captured: DirectoryCapture[] = []
  for (let index = 0; index < paths.length; index++)
    captured.push(await captureDirectory(paths[index]!, `parentChain[${index}]`))
  return captured
}

async function hashHandle(handle: fsp.FileHandle) {
  const digest = createHash("sha256")
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
  let bytes = 0
  while (true) {
    const result = await handle.read(buffer, 0, buffer.length, bytes)
    if (result.bytesRead === 0) break
    digest.update(buffer.subarray(0, result.bytesRead))
    bytes += result.bytesRead
    const budget = checkContentBudget(0, bytes, "file")
    if (budget instanceof CaptureError) throw budget
  }
  return { hash: digest.digest("hex"), bytes }
}

async function captureLeaf(file: string): Promise<
  | { readonly leaf: null; readonly hash?: undefined; readonly bytes?: undefined }
  | {
      readonly leaf: NonNullable<SessionRevertSnapshot.Preflight["files"][number]["leaf"]>
      readonly hash: string
      readonly bytes: number
    }
> {
  let before: BigIntStats
  try {
    before = await fsp.lstat(file, { bigint: true })
  } catch (cause) {
    if (missing(cause)) return { leaf: null }
    throw cause
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw fail("unsupported_object", `current path is not an ordinary file: ${file}`)
  if (before.size > BigInt(MAX_FILE_CONTENT_BYTES))
    throw fail("resource_limit", `${file} exceeds the ${MAX_FILE_CONTENT_BYTES}-byte content limit`)
  const realPath = lexicalPath(await fsp.realpath(file))
  if (realPath !== file)
    throw fail("filesystem_unavailable", `current file crosses a symlink, junction, or reparse boundary: ${file}`)

  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await fsp.open(file, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw fail("path_drift", `current file identity changed while it was opened: ${file}`)
    const content = await hashHandle(handle)
    const after = await fsp.lstat(file, { bigint: true })
    if (!after.isFile() || after.isSymbolicLink() || directoryStamp(before) !== directoryStamp(after))
      throw fail("path_drift", `current file changed while its bytes were hashed: ${file}`)
    if (!Number.isSafeInteger(Number(after.size)) || BigInt(content.bytes) !== after.size)
      throw fail("path_drift", `current file size changed while its bytes were hashed: ${file}`)
    const afterRealPath = lexicalPath(await fsp.realpath(file))
    if (afterRealPath !== realPath)
      throw fail("path_drift", `current file real path changed while its bytes were hashed: ${file}`)
    return {
      leaf: {
        path: file,
        realPath,
        device: String(after.dev),
        inode: String(after.ino),
        type: "file",
      },
      ...content,
    }
  } finally {
    await handle.close()
  }
}

async function captureCurrent(
  projectRoot: string,
  location: string,
  file: string,
  preimage: TreeContent["content"],
): Promise<CurrentCapture> {
  const before = await captureParentChain(projectRoot, location, file)
  const leaf = await captureLeaf(file)
  const after = await captureParentChain(projectRoot, location, file)
  if (!same(before, after, "parent identity chain"))
    throw fail("path_drift", `a parent directory identity changed while reading ${file}`)

  if (preimage.kind === "absent") {
    if (leaf.leaf) throw fail("source_revision_unavailable", `current file is absent from clean HEAD: ${file}`)
    return {
      parentChain: after.map((entry) => entry.evidence),
      leaf: null,
      current: { kind: "absent", hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH },
    }
  }
  if (!leaf.leaf) throw fail("source_revision_unavailable", `clean HEAD file is absent from the worktree: ${file}`)
  if (leaf.hash !== preimage.hash || leaf.bytes !== preimage.bytes)
    throw fail("source_revision_unavailable", `worktree bytes do not match clean HEAD for ${file}`)
  return {
    parentChain: after.map((entry) => entry.evidence),
    leaf: leaf.leaf,
    current: {
      kind: "file",
      object: "blob",
      mode: preimage.mode,
      hash: leaf.hash,
      bytes: leaf.bytes,
    },
  }
}

function parseIndex(input: Buffer) {
  const result = new Map<string, Array<{ readonly mode: string; readonly objectID: string; readonly stage: string }>>()
  for (const raw of input.toString("utf8").split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t")
    if (tab < 0) throw fail("git_unavailable", "git ls-files returned a malformed stage record")
    const header = raw.slice(0, tab).split(" ")
    const file = raw.slice(tab + 1)
    if (header.length !== 3 || !file) throw fail("git_unavailable", "git ls-files returned a malformed stage record")
    const entry = { mode: header[0]!, objectID: header[1]!, stage: header[2]! }
    const list = result.get(file)
    if (list) list.push(entry)
    else result.set(file, [entry])
  }
  return result
}

function assertIndexEntry(index: ReturnType<typeof parseIndex>, file: PlannedFile, source: TreeContent) {
  const entries = index.get(file.gitPath) ?? []
  if (source.content.kind === "absent") {
    if (entries.length) throw fail("source_revision_unavailable", `index contains ${file.gitPath}, absent from HEAD`)
    return
  }
  if (
    entries.length !== 1 ||
    entries[0]!.stage !== "0" ||
    entries[0]!.mode !== source.content.mode ||
    entries[0]!.objectID !== source.objectID
  )
    throw fail("source_revision_unavailable", `index mode or blob differs from HEAD for ${file.gitPath}`)
}

function gitObjectEvidence(input: RepositoryObservation["files"][number]) {
  return {
    relativePath: input.relativePath,
    path: input.path,
    preimage: input.preimage,
    target: input.target,
    targetRevision: input.targetRevision,
  }
}

function filesystemEvidence(input: RepositoryObservation["files"][number]) {
  return {
    relativePath: input.relativePath,
    path: input.path,
    parentChain: input.parentChain,
    leaf: input.leaf,
    current: input.current,
  }
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionRevertReadonlyInspector") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const appProcess = yield* AppProcess.Service

    const childEnvironment = Object.fromEntries(
      [
        "PATH",
        "Path",
        "PATHEXT",
        "SYSTEMROOT",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
      ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ) as Record<string, string>
    childEnvironment.GIT_OPTIONAL_LOCKS = "0"

    const runGit = (
      subcommand: string,
      args: ReadonlyArray<string>,
      options: { readonly cwd: string; readonly gitDir?: string; readonly snapshot?: boolean },
    ): Effect.Effect<Buffer, CaptureError> => {
      if (!permitsGitSubcommand(subcommand))
        return Effect.fail(fail("git_unavailable", `refusing non-read-only Git subcommand: ${subcommand}`))
      const command = [
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
        ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
        subcommand,
        ...args,
      ]
      return appProcess
        .run(
          ChildProcess.make("git", command, {
            cwd: options.cwd,
            env: childEnvironment,
            extendEnv: false,
            stdin: "ignore",
          }),
          { maxOutputBytes: MAX_GIT_OUTPUT_BYTES, maxErrorBytes: 64 * 1024 },
        )
        .pipe(
          Effect.mapError((cause) =>
            fail(options.snapshot ? "snapshot_store_unavailable" : "git_unavailable", errorText(cause)),
          ),
          Effect.flatMap((result) => {
            if (result.stdoutTruncated || result.stderrTruncated)
              return Effect.fail(fail("resource_limit", `${subcommand} exceeded the read-only Git output limit`))
            if (result.exitCode !== 0)
              return Effect.fail(
                fail(
                  options.snapshot ? "snapshot_store_unavailable" : "git_unavailable",
                  `${subcommand} failed with exit ${result.exitCode}: ${result.stderr.toString("utf8").trim()}`,
                ),
              )
            return Effect.succeed(result.stdout)
          }),
        )
    }

    const readBoundary = Effect.fnUntraced(function* (projectRoot: string) {
      const headCommit = (yield* runGit("rev-parse", ["--verify", "--end-of-options", "HEAD^{commit}"], {
        cwd: projectRoot,
      }))
        .toString("utf8")
        .trim()
        .toLowerCase()
      if (!GIT_OBJECT.test(headCommit)) return yield* fail("git_unavailable", "HEAD is not an immutable Git commit")
      const index = yield* runGit("ls-files", ["--stage", "-z", "--", "."], { cwd: projectRoot })
      const dirty = yield* runGit(
        "status",
        ["--porcelain=v2", "--untracked-files=all", "--no-renames", "-z", "--", "."],
        { cwd: projectRoot },
      )
      return { headCommit, index, indexFingerprint: hash(index), dirty } satisfies GitBoundary
    })

    const readTreeContent = Effect.fnUntraced(function* (input: {
      readonly projectRoot: string
      readonly gitDir?: string
      readonly revision: string
      readonly relativePath: string
      readonly snapshot: boolean
    }) {
      const tree = yield* runGit("ls-tree", ["-z", "--full-tree", input.revision, "--", input.relativePath], {
        cwd: input.projectRoot,
        gitDir: input.gitDir,
        snapshot: input.snapshot,
      })
      if (!tree.length)
        return {
          content: { kind: "absent", hash: SessionRevertSnapshot.ABSENT_CONTENT_HASH },
        } satisfies TreeContent
      const records = tree.toString("utf8").split("\0").filter(Boolean)
      if (records.length !== 1)
        return yield* fail("unsupported_object", `tree lookup was not exact for ${input.relativePath}`)
      const tab = records[0]!.indexOf("\t")
      const header = tab < 0 ? [] : records[0]!.slice(0, tab).split(" ")
      const file = tab < 0 ? "" : records[0]!.slice(tab + 1)
      if (header.length !== 3 || file !== input.relativePath)
        return yield* fail("unsupported_object", `tree lookup returned malformed evidence for ${input.relativePath}`)
      const [mode, object, objectID] = header
      if ((mode !== "100644" && mode !== "100755") || object !== "blob" || !objectID || !GIT_OBJECT.test(objectID))
        return yield* fail(
          "unsupported_object",
          `${input.relativePath} is a symlink, submodule, tree, or unsupported Git mode at ${input.revision}`,
        )
      const sizeText = (yield* runGit("cat-file", ["-s", objectID], {
        cwd: input.projectRoot,
        gitDir: input.gitDir,
        snapshot: input.snapshot,
      }))
        .toString("utf8")
        .trim()
      const size = Number(sizeText)
      if (!Number.isSafeInteger(size) || size < 0)
        return yield* fail("unsupported_object", `Git returned an invalid blob size for ${input.relativePath}`)
      const fileBudget = checkContentBudget(0, size, input.relativePath)
      if (fileBudget instanceof CaptureError) return yield* fileBudget
      const blob = yield* runGit("cat-file", ["blob", objectID], {
        cwd: input.projectRoot,
        gitDir: input.gitDir,
        snapshot: input.snapshot,
      })
      if (blob.length !== size)
        return yield* fail("git_drift", `Git blob size changed while reading ${input.relativePath}`)
      return {
        content: { kind: "file", object: "blob", mode, hash: hash(blob), bytes: blob.length },
        objectID,
      } satisfies TreeContent
    })

    const readRepositoryOnce = Effect.fnUntraced(function* (session: SessionObservation, boundary: GitBoundary) {
      const snapshotGitDir = session.snapshotGitDir
      const index =
        session.kind === "revert"
          ? yield* guarded(() => parseIndex(boundary.index), "git_unavailable", "cannot parse the exact Git index")
          : undefined
      const projectRoot = yield* guardedPromise(
        () => captureDirectory(session.projectRoot, "projectRoot"),
        "filesystem_unavailable",
        "cannot inspect projectRoot",
      )
      const location = yield* guardedPromise(
        () => captureDirectory(session.location, "location"),
        "filesystem_unavailable",
        "cannot inspect location",
      )
      if (!isWithin(projectRoot.evidence.path, location.evidence.path))
        return yield* fail("session_scope_mismatch", "location is outside the captured projectRoot")

      for (const revision of session.targetRevisions) {
        if (session.kind === "unrevert") continue
        if (revision.kind !== "snapshot")
          return yield* fail("unsupported_object", "legacy revert targets must be immutable snapshot trees")
        const kind = (yield* runGit("cat-file", ["-t", revision.id], {
          cwd: session.projectRoot,
          gitDir: snapshotGitDir,
          snapshot: true,
        }))
          .toString("utf8")
          .trim()
        if (kind !== "tree")
          return yield* fail("unsupported_object", `snapshot revision ${revision.id} is not a Git tree`)
      }

      const files: RepositoryObservation["files"][number][] = []
      let capturedContentBytes = 0
      const charge = Effect.fnUntraced(function* (bytes: number, label: string) {
        const next = checkContentBudget(capturedContentBytes, bytes, label)
        if (next instanceof CaptureError) return yield* next
        capturedContentBytes = next
      })
      for (const file of session.files) {
        if (session.kind === "unrevert") {
          const receipt = session.preimageReceipt
          const stored = receipt?.files.find((candidate) => candidate.path === file.path)
          if (!receipt || !stored)
            return yield* fail("source_revision_unavailable", `immutable preimage receipt does not cover ${file.path}`)
          const source = stored.target
          if (source.kind === "file") yield* charge(source.bytes, "revert target content")
          if (stored.preimage.kind === "file") yield* charge(stored.preimage.bytes, "receipt preimage content")
          const current = yield* guardedPromise(
            () => captureCurrent(session.projectRoot, session.location, file.path, source),
            "filesystem_unavailable",
            `cannot inspect ${file.path}`,
          )
          files.push({
            relativePath: file.relativePath,
            path: file.path,
            ...current,
            preimage: source,
            target: stored.preimage,
            targetRevision: file.targetRevision,
          })
          continue
        }
        const preimage = yield* readTreeContent({
          projectRoot: session.projectRoot,
          revision: boundary.headCommit,
          relativePath: file.gitPath,
          snapshot: false,
        })
        if (preimage.content.kind === "file") yield* charge(preimage.content.bytes, "source content")
        yield* guarded(
          () => assertIndexEntry(index!, file, preimage),
          "source_revision_unavailable",
          `cannot bind index evidence for ${file.gitPath}`,
        )
        const target = yield* readTreeContent({
          projectRoot: session.projectRoot,
          gitDir: snapshotGitDir,
          revision: file.targetRevision.id,
          relativePath: file.gitPath,
          snapshot: true,
        })
        if (target.content.kind === "file") yield* charge(target.content.bytes, "target content")
        if (preimage.content.kind === "file") yield* charge(preimage.content.bytes, "current content")
        const current = yield* guardedPromise(
          () => captureCurrent(session.projectRoot, session.location, file.path, preimage.content),
          "filesystem_unavailable",
          `cannot inspect ${file.path}`,
        )
        files.push({
          relativePath: file.relativePath,
          path: file.path,
          ...current,
          preimage: preimage.content,
          target: target.content,
          targetRevision: file.targetRevision,
        })
      }
      return {
        projectRootAnchor: projectRoot.evidence,
        locationAnchor: location.evidence,
        files,
      }
    })

    const readRepository: Reader["readRepository"] = (session) =>
      Effect.gen(function* () {
        const before = yield* readBoundary(session.projectRoot)
        const first = yield* readRepositoryOnce(session, before)
        const second = yield* readRepositoryOnce(session, before)
        const after = yield* readBoundary(session.projectRoot)

        if (
          before.headCommit !== after.headCommit ||
          before.indexFingerprint !== after.indexFingerprint ||
          !before.dirty.equals(after.dirty)
        )
          return yield* fail("git_drift", "HEAD, index, or dirty status changed inside a repository observation")
        if (before.dirty.length && session.files.length > 0)
          return yield* fail(
            "source_revision_unavailable",
            "the worktree or index is dirty; zero-write capture cannot create the immutable source snapshot required for compensation",
          )
        if (
          !(yield* guarded(
            () =>
              same(
                first.files.map(gitObjectEvidence),
                second.files.map(gitObjectEvidence),
                "immutable object evidence",
              ),
            "evidence_invalid",
            "cannot compare immutable object evidence",
          ))
        )
          return yield* fail("git_drift", "immutable source or target Git object evidence changed while reading files")
        if (
          !(yield* guarded(
            () =>
              same(
                {
                  projectRootAnchor: first.projectRootAnchor,
                  locationAnchor: first.locationAnchor,
                  files: first.files.map(filesystemEvidence),
                },
                {
                  projectRootAnchor: second.projectRootAnchor,
                  locationAnchor: second.locationAnchor,
                  files: second.files.map(filesystemEvidence),
                },
                "filesystem evidence",
              ),
            "evidence_invalid",
            "cannot compare filesystem evidence",
          ))
        )
          return yield* fail("path_drift", "a path identity or ordinary-file hash changed inside repository capture")

        return {
          projectRootAnchor: second.projectRootAnchor,
          locationAnchor: second.locationAnchor,
          sourceRevision:
            session.kind === "unrevert"
              ? { kind: "snapshot", id: session.preimageReceipt!.snapshotDigest }
              : { kind: "commit", id: after.headCommit },
          headCommit: after.headCommit,
          indexFingerprint: after.indexFingerprint,
          dirtyFingerprint: hash(after.dirty),
          files: second.files,
        } satisfies RepositoryObservation
      })

    const readSession: Reader["readSession"] = (input) =>
      Effect.gen(function* () {
        const context = yield* InstanceState.context.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              fail("session_scope_mismatch", `active project context is unavailable: ${Cause.pretty(cause)}`),
            ),
          ),
        )
        const raw = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const eventBefore =
                (yield* tx
                  .select({ seq: EventSequenceTable.seq })
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
                  .get())?.seq ?? -1
              const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get()
              const messages = yield* tx
                .select()
                .from(MessageTable)
                .where(eq(MessageTable.session_id, input.sessionID))
                .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
                .limit(MAX_DATABASE_ROWS + 1)
                .all()
              const parts = yield* tx
                .select()
                .from(PartTable)
                .where(eq(PartTable.session_id, input.sessionID))
                .orderBy(asc(PartTable.message_id), asc(PartTable.id))
                .limit(MAX_DATABASE_ROWS + 1)
                .all()
              const eventAfter =
                (yield* tx
                  .select({ seq: EventSequenceTable.seq })
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
                  .get())?.seq ?? -1
              return { eventBefore, eventAfter, session, messages, parts } satisfies SessionTransaction
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.fail(fail("database_unavailable", `read-only Session transaction failed: ${Cause.pretty(cause)}`)),
            ),
          )
        const projection = yield* guarded(
          () => decodeProjection(raw),
          "session_projection_invalid",
          "cannot decode the Session projection",
        )
        const preimageReceipt =
          input.kind === "unrevert"
            ? yield* guardedPromise(
                async () => {
                  const digest = projection.session.revert?.snapshot
                  if (!digest || !/^[0-9a-f]{64}$/.test(digest))
                    throw fail("source_revision_unavailable", "the stored revert receipt reference is invalid")
                  const receiptPath = path.join(
                    Global.Path.data,
                    "revert-receipts",
                    context.project.id,
                    String(input.sessionID),
                    `${digest}.json`,
                  )
                  const rawReceipt = JSON.parse(await fsp.readFile(receiptPath, "utf8")) as unknown
                  return SessionRevertSnapshot.decodePreimageReceipt(rawReceipt)
                },
                "source_revision_unavailable",
                "cannot load the first revert's immutable preimage receipt",
              )
            : undefined
        return yield* guarded(
          () =>
            deriveSessionObservation(
              input,
              raw,
              {
                directory: context.directory,
                worktree: context.worktree,
                projectID: context.project.id,
              },
              preimageReceipt,
            ),
          "session_projection_invalid",
          "cannot derive the Session revert plan",
        )
      })

    return Service.of(make({ readSession, readRepository }))
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, AppProcess.node],
})

export * as SessionRevertReadonlyLocal from "./revert-readonly-local"
