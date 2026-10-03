import type { ActionGateway } from "@arforge-ai/core/action-gateway"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import path from "node:path"
import { isProxy } from "node:util/types"
import { SessionID, MessageID, PartID } from "./schema"

const Digest = Schema.String
const ImmutableRevisionID = Schema.String
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const MAX_RESTORE_FILES = 4_096
export const MAX_TARGET_REVISIONS = 4_096
export const MAX_PARENT_CHAIN = 256
export const MAX_PATH_BYTES = 32_768
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAX_RAW_DEPTH = 64
export const MAX_RAW_NODES = 500_000
export const MAX_RAW_ARRAY_ITEMS = MAX_RESTORE_FILES
export const MAX_RAW_STRING_BYTES = MAX_PATH_BYTES
export const MAX_RAW_KEY_BYTES = 4_096

/** Hash used for a path which is proven absent on one side of a restore. */
export const ABSENT_CONTENT_HASH = "6ba7ac261b8361164016e481c4d2a0efdc3e9581351dae57fcd42d0e75d661c2"

const DirectoryIdentity = Schema.Struct({
  path: Schema.String,
  realPath: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  type: Schema.Literal("directory"),
})

const FileIdentity = Schema.Struct({
  path: Schema.String,
  realPath: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  type: Schema.Literal("file"),
})

const AbsentContent = Schema.Struct({
  kind: Schema.Literal("absent"),
  hash: Schema.Literal(ABSENT_CONTENT_HASH),
})

const FileContent = Schema.Struct({
  kind: Schema.Literal("file"),
  object: Schema.Literal("blob"),
  /** Git tree mode. Symlinks (120000), submodules (160000), and trees are not representable. */
  mode: Schema.Literals(["100644", "100755"]),
  hash: Digest,
  bytes: NonNegativeInteger,
})

const Content = Schema.Union([AbsentContent, FileContent], { mode: "oneOf" })
export type Content = typeof Content.Type

const CommitRevision = Schema.Struct({ kind: Schema.Literal("commit"), id: ImmutableRevisionID })
const SnapshotRevision = Schema.Struct({ kind: Schema.Literal("snapshot"), id: ImmutableRevisionID })
const Revision = Schema.Union([CommitRevision, SnapshotRevision], { mode: "oneOf" })

const Target = Schema.Struct({
  messageID: MessageID,
  messageSequence: NonNegativeInteger,
  partID: Schema.optional(PartID),
  partIndex: Schema.optional(NonNegativeInteger),
})

const File = Schema.Struct({
  /** Canonical path relative to projectRoot, always slash-separated. */
  relativePath: Schema.String,
  /** Canonical absolute path; this must resolve under location. */
  path: Schema.String,
  /** Every ordinary directory from projectRoot through this file's parent. */
  parentChain: Schema.Array(DirectoryIdentity),
  /** Present only when `current.kind` is `file`; symlink leaves are not representable. */
  leaf: Schema.NullOr(FileIdentity),
  /** Content resolved from sourceRevision. */
  preimage: Content,
  /** Content read from the worktree during preflight; must equal preimage. */
  current: Content,
  /** Content resolved from targetRevision. */
  target: Content,
  targetRevision: Revision,
})

const StableFields = {
  version: Schema.Literal(1),
  kind: Schema.Literals(["revert", "unrevert"]),
  sessionID: SessionID,
  projectID: Schema.String,
  projectRoot: Schema.String,
  location: Schema.String,
  projectRootAnchor: DirectoryIdentity,
  locationAnchor: DirectoryIdentity,
  target: Target,
  /** Canonical hash of the complete current Session projection. */
  sessionRevision: Digest,
  /** Current durable EventV2 aggregate sequence for sessionID. */
  eventHighWaterMark: NonNegativeInteger,
  sourceRevision: Revision,
  targetRevisions: Schema.Array(Revision),
  headCommit: ImmutableRevisionID,
  /** sha256 of the exact raw `git ls-files --stage -z` result. */
  indexFingerprint: Digest,
  /**
   * sha256 of a sorted, NUL-delimited dirty-entry sequence which includes
   * status, mode, path, and sha256 file bytes (or the symlink target). An
   * ordinary porcelain-status digest is insufficient because its text can
   * remain unchanged while file bytes drift.
   */
  dirtyFingerprint: Digest,
  files: Schema.Array(File),
}

/** Request-independent evidence which must be independently recaptured before execution. */
export const ClaimInput = Schema.Struct(StableFields)
export type ClaimInput = typeof ClaimInput.Type

/** Complete immutable preflight before the integrity checksum is attached. */
export const Preflight = Schema.Struct({
  ...StableFields,
  requestID: Schema.String,
})
export type Preflight = typeof Preflight.Type

/** Request-bound durable payload. */
export const Snapshot = Schema.Struct({
  ...Preflight.fields,
  digest: Digest,
})
export type Snapshot = typeof Snapshot.Type

/** Immutable preimage proof written before the first restore byte is changed. */
export const PreimageReceipt = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("session-revert-preimage"),
  snapshotDigest: Digest,
  sessionID: SessionID,
  projectID: Schema.String,
  projectRoot: Schema.String,
  location: Schema.String,
  projectRootAnchor: DirectoryIdentity,
  locationAnchor: DirectoryIdentity,
  target: Target,
  eventHighWaterMark: NonNegativeInteger,
  sourceRevision: Revision,
  headCommit: ImmutableRevisionID,
  indexFingerprint: Digest,
  dirtyFingerprint: Digest,
  files: Schema.Array(
    Schema.Struct({
      relativePath: Schema.String,
      path: Schema.String,
      parentChain: Schema.Array(DirectoryIdentity),
      leaf: Schema.NullOr(FileIdentity),
      preimage: Content,
      current: Content,
      target: Content,
      targetRevision: Revision,
    }),
  ),
  digest: Digest,
})
export type PreimageReceipt = typeof PreimageReceipt.Type

export class Error extends Schema.TaggedErrorClass<Error>()("SessionRevertSnapshot.Error", {
  message: Schema.String,
}) {}

const strictPreflight = Schema.decodeUnknownSync(Preflight, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictSnapshot = Schema.decodeUnknownSync(Snapshot, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictPreimageReceipt = Schema.decodeUnknownSync(PreimageReceipt, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictClaimInput = Schema.decodeUnknownSync(ClaimInput, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const REQUEST_ID = /^cpr_[A-Za-z0-9_-]{8,128}$/
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const IDENTITY_PART = /^\d+$/

/** sha256 of the canonical empty dirty-entry sequence. */
export const CLEAN_DIRTY_FINGERPRINT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const fail = (message: string): never => {
  throw new Error({ message })
}

/** Bound raw input iteratively before recursive schema/canonicalization paths. */
function assertRawBounds(value: unknown, label: string) {
  type Frame =
    | { readonly kind: "visit"; readonly value: unknown; readonly depth: number; readonly path: string }
    | { readonly kind: "leave"; readonly value: object }
  const stack: Array<Frame> = [{ kind: "visit", value, depth: 0, path: label }]
  const active = new WeakSet<object>()
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()!
    if (current.kind === "leave") {
      active.delete(current.value)
      continue
    }
    nodes++
    if (nodes > MAX_RAW_NODES) fail(`${label} exceeds ${MAX_RAW_NODES} raw nodes`)
    if (current.depth > MAX_RAW_DEPTH) fail(`${current.path} exceeds the raw depth limit`)

    if (current.value === null || typeof current.value === "boolean") continue
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) fail(`${current.path} contains a non-finite number`)
      continue
    }
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value) > MAX_RAW_STRING_BYTES)
        fail(`${current.path} contains an oversized raw string`)
      continue
    }
    const objectValue: object =
      typeof current.value === "object" && current.value !== null
        ? current.value
        : fail(`${current.path} contains a non-JSON value`)
    if (isProxy(objectValue)) fail(`${current.path} cannot be a Proxy`)
    if (active.has(objectValue)) fail(`${current.path} contains a cyclic reference`)
    active.add(objectValue)
    stack.push({ kind: "leave", value: objectValue })

    if (Array.isArray(objectValue)) {
      if (Object.getPrototypeOf(objectValue) !== Array.prototype)
        fail(`${current.path} contains an array with a non-standard prototype`)
      if (objectValue.length > MAX_RAW_ARRAY_ITEMS)
        fail(`${current.path} exceeds ${MAX_RAW_ARRAY_ITEMS} raw array items`)
      const descriptors = Object.getOwnPropertyDescriptors(objectValue)
      const keys = Reflect.ownKeys(objectValue)
      let itemCount = 0
      for (const key of keys) {
        const stringKey: string = typeof key === "string" ? key : fail(`${current.path} contains a symbol array key`)
        const descriptor = descriptors[stringKey] ?? fail(`${current.path}.${stringKey} has no own property descriptor`)
        if (descriptor.get || descriptor.set || !("value" in descriptor))
          fail(`${current.path}.${stringKey} cannot be an accessor property`)
        if (stringKey === "length") continue
        if (!/^(?:0|[1-9]\d*)$/.test(stringKey) || Number(stringKey) >= objectValue.length)
          fail(`${current.path} contains a non-index array property`)
        if (!descriptor.enumerable) fail(`${current.path}[${stringKey}] must be an enumerable data property`)
        itemCount++
      }
      if (itemCount !== objectValue.length) fail(`${current.path} cannot be a sparse array`)
      for (let index = objectValue.length - 1; index >= 0; index--) {
        const descriptor = descriptors[String(index)]!
        stack.push({
          kind: "visit",
          value: descriptor.value,
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(objectValue)
    if (prototype !== Object.prototype && prototype !== null) fail(`${current.path} contains a non-plain object`)
    const descriptors = Object.getOwnPropertyDescriptors(objectValue)
    for (const key of Reflect.ownKeys(objectValue)) {
      const stringKey: string = typeof key === "string" ? key : fail(`${current.path} contains a symbol field`)
      const descriptor = descriptors[stringKey] ?? fail(`${current.path}.${stringKey} has no own property descriptor`)
      if (Buffer.byteLength(stringKey) > MAX_RAW_KEY_BYTES) fail(`${current.path} contains an oversized field name`)
      if (descriptor.get || descriptor.set || !("value" in descriptor))
        fail(`${current.path}.${stringKey} cannot be an accessor property`)
      if (!descriptor.enumerable) fail(`${current.path}.${stringKey} must be an enumerable data property`)
      stack.push({
        kind: "visit",
        value: descriptor.value,
        depth: current.depth + 1,
        path: `${current.path}.${stringKey}`,
      })
    }
  }
}

function flavor(value: string) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)) return path.win32
  if (value.startsWith("/")) return path.posix
  return undefined
}

function canonicalAbsolute(value: string, label: string) {
  if (!value || value.includes("\0")) return fail(`${label} must be a non-empty absolute path`)
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) return fail(`${label} exceeds the path-size limit`)
  if (/^\\\\[?.]\\/.test(value)) return fail(`${label} cannot use a Windows device path`)
  const implementation = flavor(value)
  if (!implementation?.isAbsolute(value)) return fail(`${label} must be an absolute path`)
  const normalized = implementation.normalize(value)
  return implementation === path.win32 ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, target: string, allowRoot = true) {
  const implementation = flavor(root)
  if (!implementation || implementation !== flavor(target)) return false
  const relative = implementation.relative(root, target)
  if (!relative) return allowRoot
  return relative !== ".." && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative)
}

function assertWindowsSegment(segment: string, label: string) {
  if (!segment || /[\x00-\x1f<>:"|?*]/.test(segment) || /[ .]$/.test(segment))
    fail(`${label} contains an unsafe Windows path segment`)
  const base = segment.split(".", 1)[0]?.toLowerCase()
  if (base && /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/.test(base))
    fail(`${label} contains a reserved Windows path segment`)
}

function canonicalRelative(value: string, implementation: path.PlatformPath, label: string) {
  if (!value || value.includes("\0") || implementation.isAbsolute(value))
    return fail(`${label} must be a non-empty project-relative path`)
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) fail(`${label} exceeds the path-size limit`)
  if (value.includes("\\")) fail(`${label} must use slash separators`)
  const segments = value.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    fail(`${label} contains a non-canonical path segment`)
  if (implementation === path.win32) segments.forEach((segment) => assertWindowsSegment(segment, label))
  const normalized = segments.join("/")
  return implementation === path.win32 ? normalized.toLowerCase() : normalized
}

type RawDirectoryIdentity = typeof DirectoryIdentity.Type
type RawIdentity = RawDirectoryIdentity | typeof FileIdentity.Type

function identity<T extends RawIdentity>(input: T, expectedPath: string, label: string): T {
  const identityPath = canonicalAbsolute(input.path, `${label}.path`)
  const realPath = canonicalAbsolute(input.realPath, `${label}.realPath`)
  if (identityPath !== expectedPath) fail(`${label} path does not match its lexical boundary`)
  if (realPath !== identityPath) fail(`${label} crosses a symlink or junction boundary`)
  if (!IDENTITY_PART.test(input.device) || !IDENTITY_PART.test(input.inode)) fail(`${label} identity is invalid`)
  return { ...input, path: identityPath, realPath } as T
}

function sameIdentity(left: RawDirectoryIdentity, right: RawDirectoryIdentity) {
  return (
    left.path === right.path &&
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.type === right.type
  )
}

function revision(input: typeof Revision.Type, label: string) {
  const id = input.id.toLowerCase()
  if (!GIT_OBJECT.test(id)) fail(`${label} is not an immutable snapshot or commit ID`)
  return { kind: input.kind, id } as typeof Revision.Type
}

function content(input: typeof Content.Type, label: string): typeof Content.Type {
  if (input.kind === "absent") {
    if (input.hash !== ABSENT_CONTENT_HASH) fail(`${label} has an invalid absent-content hash`)
    return { kind: "absent" as const, hash: ABSENT_CONTENT_HASH }
  }
  const hash = input.hash.toLowerCase()
  if (!SHA256.test(hash)) fail(`${label} must carry a sha256 content hash`)
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) fail(`${label}.bytes must be a safe non-negative integer`)
  return { kind: "file" as const, object: "blob" as const, mode: input.mode, hash, bytes: input.bytes }
}

function sameContent(left: typeof Content.Type, right: typeof Content.Type) {
  return canonicalHash(left) === canonicalHash(right)
}

function revisionKey(value: typeof Revision.Type) {
  return `${value.kind}:${value.id}`
}

function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value
  for (const child of Object.values(value)) immutable(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

function canonicalize(raw: Preflight): Preflight {
  if (!REQUEST_ID.test(raw.requestID)) fail("requestID is invalid")
  if (!PROJECT_ID.test(raw.projectID)) fail("projectID is invalid")
  if (!SHA256.test(raw.sessionRevision.toLowerCase())) fail("sessionRevision must be a sha256 digest")
  if (!SHA256.test(raw.indexFingerprint.toLowerCase())) fail("indexFingerprint must be a sha256 digest")
  if (!SHA256.test(raw.dirtyFingerprint.toLowerCase())) fail("dirtyFingerprint must be a sha256 digest")
  if (!Number.isSafeInteger(raw.eventHighWaterMark) || raw.eventHighWaterMark < 0)
    fail("eventHighWaterMark must be a safe non-negative integer")

  const projectRoot = canonicalAbsolute(raw.projectRoot, "projectRoot")
  const implementation = flavor(projectRoot) ?? fail("projectRoot path flavor is unsupported")
  const location = canonicalAbsolute(raw.location, "location")
  if (flavor(location) !== implementation || !isWithin(projectRoot, location))
    fail("location is outside the project boundary")
  const projectRootAnchor = identity(raw.projectRootAnchor, projectRoot, "projectRootAnchor")
  const locationAnchor = identity(raw.locationAnchor, location, "locationAnchor")

  if ((raw.target.partID === undefined) !== (raw.target.partIndex === undefined))
    fail("target partID and partIndex must be present together")

  const sourceRevision = revision(raw.sourceRevision, "sourceRevision")
  const headCommit = raw.headCommit.toLowerCase()
  if (!GIT_OBJECT.test(headCommit)) fail("headCommit is not an immutable Git commit ID")
  if (sourceRevision.kind === "commit" && sourceRevision.id !== headCommit)
    fail("commit sourceRevision must equal the frozen HEAD commit")
  if (
    sourceRevision.kind === "commit" &&
    raw.files.length > 0 &&
    raw.dirtyFingerprint.toLowerCase() !== CLEAN_DIRTY_FINGERPRINT
  )
    fail("a dirty worktree requires an immutable source snapshot rather than HEAD")

  if (raw.targetRevisions.length > MAX_TARGET_REVISIONS)
    fail(`targetRevisions exceeds the ${MAX_TARGET_REVISIONS}-revision limit`)
  if (raw.files.length > MAX_RESTORE_FILES) fail(`files exceeds the ${MAX_RESTORE_FILES}-file limit`)

  const targetRevisions = raw.targetRevisions.map((item, index) => revision(item, `targetRevisions[${index}]`))
  targetRevisions.sort((left, right) => revisionKey(left).localeCompare(revisionKey(right)))
  if (new Set(targetRevisions.map(revisionKey)).size !== targetRevisions.length)
    fail("targetRevisions must not contain duplicates")

  const files = raw.files.map((item, index) => {
    const relativePath = canonicalRelative(item.relativePath, implementation, `files[${index}].relativePath`)
    const absolute = canonicalAbsolute(item.path, `files[${index}].path`)
    const expected = canonicalAbsolute(
      implementation.resolve(projectRoot, ...relativePath.split("/")),
      `files[${index}].path`,
    )
    if (absolute !== expected) fail(`files[${index}].path is not bound to relativePath`)
    if (!isWithin(location, absolute, false)) fail(`files[${index}].path is outside the session location`)

    const parent = implementation.dirname(absolute)
    const parentRelative = implementation.relative(projectRoot, parent)
    const parentSegments = parentRelative ? parentRelative.split(implementation.sep).filter(Boolean) : []
    const expectedChain = [projectRoot]
    for (let offset = 0; offset < parentSegments.length; offset++)
      expectedChain.push(
        canonicalAbsolute(implementation.join(projectRoot, ...parentSegments.slice(0, offset + 1)), "path"),
      )
    if (item.parentChain.length !== expectedChain.length)
      fail(`files[${index}].parentChain does not cover the complete no-follow boundary`)
    if (item.parentChain.length > MAX_PARENT_CHAIN)
      fail(`files[${index}].parentChain exceeds the ${MAX_PARENT_CHAIN}-directory limit`)
    const parentChain = item.parentChain.map((entry, offset) =>
      identity(entry, expectedChain[offset]!, `files[${index}].parentChain[${offset}]`),
    )
    if (!sameIdentity(parentChain[0]!, projectRootAnchor))
      fail(`files[${index}].parentChain does not match projectRootAnchor`)
    const locationOffset = expectedChain.indexOf(location)
    if (locationOffset < 0 || !sameIdentity(parentChain[locationOffset]!, locationAnchor))
      fail(`files[${index}].parentChain does not match locationAnchor`)

    const preimage = content(item.preimage, `files[${index}].preimage`)
    const current = content(item.current, `files[${index}].current`)
    const target = content(item.target, `files[${index}].target`)
    if (!sameContent(preimage, current)) fail(`files[${index}] current content drifted from its preimage`)

    const leaf = item.leaf
      ? {
          ...identity(item.leaf, absolute, `files[${index}].leaf`),
          type: "file" as const,
        }
      : null
    if ((current.kind === "file") !== Boolean(leaf))
      fail(`files[${index}].leaf does not match current content existence`)

    const targetRevision = revision(item.targetRevision, `files[${index}].targetRevision`)
    if (!targetRevisions.some((candidate) => revisionKey(candidate) === revisionKey(targetRevision)))
      fail(`files[${index}].targetRevision is not declared by targetRevisions`)

    return {
      relativePath,
      path: absolute,
      parentChain,
      leaf,
      preimage,
      current,
      target,
      targetRevision,
    }
  })
  files.sort((left, right) => left.path.localeCompare(right.path))
  if (new Set(files.map((item) => item.path)).size !== files.length) fail("session restore paths must be unique")
  const usedTargets = new Set(files.map((item) => revisionKey(item.targetRevision)))
  if (
    usedTargets.size !== targetRevisions.length ||
    targetRevisions.some((item) => !usedTargets.has(revisionKey(item)))
  )
    fail("targetRevisions must exactly match the file restore plan")

  const result: Preflight = {
    version: 1,
    kind: raw.kind,
    sessionID: raw.sessionID,
    projectID: raw.projectID,
    projectRoot,
    location,
    projectRootAnchor,
    locationAnchor,
    target: { ...raw.target },
    sessionRevision: raw.sessionRevision.toLowerCase(),
    eventHighWaterMark: raw.eventHighWaterMark,
    sourceRevision,
    targetRevisions,
    headCommit,
    indexFingerprint: raw.indexFingerprint.toLowerCase(),
    dirtyFingerprint: raw.dirtyFingerprint.toLowerCase(),
    files,
    requestID: raw.requestID,
  }
  const encoded = canonicalJson(result) ?? fail("session restore preflight is not canonically serializable")
  if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES)
    fail(`session restore preflight exceeds ${MAX_SNAPSHOT_BYTES} canonical bytes`)
  return result
}

function unsigned(snapshot: Snapshot): Preflight {
  const { digest: _digest, ...value } = snapshot
  return value
}

function stable(snapshot: Snapshot): ClaimInput {
  const { requestID: _requestID, digest: _digest, ...value } = snapshot
  return value
}

function integrityDigest(value: Preflight) {
  return canonicalHash(value) ?? fail("session restore preflight is not canonically serializable")
}

function preimageIntegrityDigest(value: Omit<PreimageReceipt, "digest">) {
  return canonicalHash(value) ?? fail("preimage receipt is not canonically serializable")
}

/** Build the only receipt accepted by unrevert: the first revert's frozen preimages. */
export function encodePreimageReceipt(input: Omit<PreimageReceipt, "digest">): PreimageReceipt {
  assertRawBounds(input, "session revert preimage receipt")
  let decoded: Omit<PreimageReceipt, "digest">
  try {
    decoded = Schema.decodeUnknownSync(Schema.Struct({ ...PreimageReceipt.fields, digest: Schema.optional(Digest) }))(
      input,
    ) as Omit<PreimageReceipt, "digest">
  } catch (cause) {
    return fail(
      `preimage receipt schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
    )
  }
  const digest = preimageIntegrityDigest(decoded)
  return immutable(strictPreimageReceipt({ ...decoded, digest }))
}

export function decodePreimageReceipt(input: unknown): PreimageReceipt {
  assertRawBounds(input, "session revert preimage receipt")
  const receipt = strictPreimageReceipt(input)
  const { digest: _digest, ...unsignedReceipt } = receipt
  if (receipt.digest !== preimageIntegrityDigest(unsignedReceipt))
    fail("preimage receipt digest does not match its payload")
  if (!SHA256.test(receipt.snapshotDigest)) fail("preimage receipt snapshotDigest must be a sha256 digest")
  const canonical = canonicalize({
    version: 1,
    kind: "revert",
    requestID: "cpr_receipt_validation",
    sessionID: receipt.sessionID,
    projectID: receipt.projectID,
    projectRoot: receipt.projectRoot,
    location: receipt.location,
    projectRootAnchor: receipt.projectRootAnchor,
    locationAnchor: receipt.locationAnchor,
    target: receipt.target,
    sessionRevision: receipt.sourceRevision.kind === "commit" ? receipt.snapshotDigest : receipt.snapshotDigest,
    eventHighWaterMark: receipt.eventHighWaterMark,
    sourceRevision: receipt.sourceRevision,
    targetRevisions: [
      ...new Map(
        receipt.files.map((file) => [`${file.targetRevision.kind}:${file.targetRevision.id}`, file.targetRevision]),
      ).values(),
    ],
    headCommit: receipt.headCommit,
    indexFingerprint: receipt.indexFingerprint,
    dirtyFingerprint: receipt.dirtyFingerprint,
    files: receipt.files,
  })
  const canonicalReceipt = {
    snapshotDigest: receipt.snapshotDigest,
    projectRoot: canonical.projectRoot,
    location: canonical.location,
    projectRootAnchor: canonical.projectRootAnchor,
    locationAnchor: canonical.locationAnchor,
    target: canonical.target,
    eventHighWaterMark: canonical.eventHighWaterMark,
    sourceRevision: canonical.sourceRevision,
    headCommit: canonical.headCommit,
    indexFingerprint: canonical.indexFingerprint,
    dirtyFingerprint: canonical.dirtyFingerprint,
    files: canonical.files,
  }
  const receivedReceipt = {
    snapshotDigest: receipt.snapshotDigest,
    projectRoot: receipt.projectRoot,
    location: receipt.location,
    projectRootAnchor: receipt.projectRootAnchor,
    locationAnchor: receipt.locationAnchor,
    target: receipt.target,
    eventHighWaterMark: receipt.eventHighWaterMark,
    sourceRevision: receipt.sourceRevision,
    headCommit: receipt.headCommit,
    indexFingerprint: receipt.indexFingerprint,
    dirtyFingerprint: receipt.dirtyFingerprint,
    files: receipt.files,
  }
  if (canonicalHash(canonicalReceipt) !== canonicalHash(receivedReceipt))
    fail("preimage receipt contains non-canonical or contradictory evidence")
  return immutable(receipt)
}

export function preimageReceipt(input: unknown): PreimageReceipt {
  const snapshot = sealed(input)
  return encodePreimageReceipt({
    version: 1,
    kind: "session-revert-preimage",
    snapshotDigest: snapshot.digest,
    sessionID: snapshot.sessionID,
    projectID: snapshot.projectID,
    projectRoot: snapshot.projectRoot,
    location: snapshot.location,
    projectRootAnchor: snapshot.projectRootAnchor,
    locationAnchor: snapshot.locationAnchor,
    target: snapshot.target,
    eventHighWaterMark: snapshot.eventHighWaterMark,
    sourceRevision: snapshot.sourceRevision,
    headCommit: snapshot.headCommit,
    indexFingerprint: snapshot.indexFingerprint,
    dirtyFingerprint: snapshot.dirtyFingerprint,
    files: snapshot.files.map((file) => ({
      relativePath: file.relativePath,
      path: file.path,
      parentChain: file.parentChain,
      leaf: file.leaf,
      preimage: file.preimage,
      current: file.current,
      target: file.target,
      targetRevision: file.targetRevision,
    })),
  })
}

function sealed(input: unknown): Snapshot {
  assertRawBounds(input, "session restore snapshot")
  let candidate: Snapshot
  try {
    candidate = strictSnapshot(input)
  } catch (cause) {
    return fail(`snapshot schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  const canonical = canonicalize(unsigned(candidate))
  if (canonicalHash(canonical) !== canonicalHash(unsigned(candidate)))
    fail("snapshot contains non-canonical scope or paths")
  if (!SHA256.test(candidate.digest) || candidate.digest !== integrityDigest(canonical))
    fail("snapshot digest does not match its stored payload")
  return immutable({ ...canonical, digest: candidate.digest })
}

/** Seal complete, independently collected preflight evidence into a request-bound payload. */
export function encode(input: Preflight): Snapshot {
  assertRawBounds(input, "session restore preflight")
  let decoded: Preflight
  try {
    decoded = strictPreflight(input)
  } catch (cause) {
    return fail(`preflight schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  const canonical = canonicalize(decoded)
  return immutable(strictSnapshot({ ...canonical, digest: integrityDigest(canonical) }))
}

/**
 * Decode a sealed payload and compare it with independently recaptured live
 * evidence. Passing evidence projected from the payload itself does not prove
 * freshness; callers must re-read the Session/Event/Git/filesystem state.
 */
export function decode(input: unknown, expected: ClaimInput): { readonly snapshot: Snapshot } {
  const snapshot = sealed(input)
  assertRawBounds(expected, "live session restore evidence")
  let current: ClaimInput
  try {
    current = strictClaimInput(expected)
  } catch (cause) {
    return fail(`live evidence schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  const canonicalCurrent = canonicalize({ ...current, requestID: snapshot.requestID })
  const expectedClaim = stable({ ...canonicalCurrent, digest: integrityDigest(canonicalCurrent) })
  if (canonicalHash(stable(snapshot)) !== canonicalHash(expectedClaim))
    fail("session, scope, path, revision, or hash evidence drifted after preflight")
  return immutable({ snapshot })
}

/** Exact request-bound payload used for durable execution binding. */
export function executionInput(input: unknown): Preflight {
  return immutable(unsigned(sealed(input)))
}

export function matchesPresentedInput(
  input: unknown,
  presented: {
    readonly kind: "revert" | "unrevert"
    readonly requestID: string
    readonly sessionID: SessionID
    readonly messageID?: MessageID
    readonly partID?: PartID
  },
) {
  try {
    const snapshot = sealed(input)
    return (
      snapshot.kind === presented.kind &&
      snapshot.requestID === presented.requestID &&
      snapshot.sessionID === presented.sessionID &&
      (snapshot.kind === "revert"
        ? presented.messageID !== undefined &&
          snapshot.target.messageID === presented.messageID &&
          snapshot.target.partID === presented.partID
        : presented.messageID === undefined && presented.partID === undefined)
    )
  } catch {
    return false
  }
}

/** Request-independent canonical identity used by ClaimIndex aliasing. */
export function claimMaterial(input: unknown): { readonly input: ClaimInput; readonly payload: ClaimInput } {
  const value = immutable(stable(sealed(input)))
  return immutable({ input: value, payload: value })
}

export type ActionMaterial = {
  readonly name: "session.revert" | "session.unrevert"
  readonly inputDigest: string
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly reasonSummary: string
  readonly requiresFreshHumanConfirmation: true
}

/** Rebuild the complete L3 declaration solely from a verified sealed payload. */
export function actionMaterial(input: unknown): ActionMaterial {
  const snapshot = sealed(input)
  const name = `session.${snapshot.kind}` as ActionMaterial["name"]
  const resources = [
    `session:${snapshot.sessionID}`,
    `session-event:${snapshot.sessionID}@${snapshot.eventHighWaterMark}`,
    `project:${snapshot.projectID}`,
    `git-head:${snapshot.headCommit}`,
    `git-index:${snapshot.indexFingerprint}`,
    `git-dirty:${snapshot.dirtyFingerprint}`,
    `snapshot:${revisionKey(snapshot.sourceRevision)}`,
    ...snapshot.targetRevisions.map((item) => `snapshot:${revisionKey(item)}`),
    ...snapshot.files.map((item) => `filesystem:${item.path}`),
  ]
  const expectedArtifacts = snapshot.files.flatMap((item) => (item.target.kind === "file" ? [item.path] : []))
  const successCriteria = [
    `session ${snapshot.sessionID} revert boundary is ${snapshot.target.messageID}${snapshot.target.partID ? `/${snapshot.target.partID}` : ""}`,
    `the session mutation is committed from event high-water mark ${snapshot.eventHighWaterMark} without a sequence conflict`,
    ...snapshot.files.map((item) =>
      item.target.kind === "file"
        ? `${item.path} is an ordinary Git blob with mode ${item.target.mode}, ${item.target.bytes} bytes, and sha256 ${item.target.hash}`
        : `${item.path} is absent`,
    ),
  ]
  return immutable({
    name,
    inputDigest:
      canonicalHash(claimMaterial(snapshot).input) ?? fail("session restore claim material is not canonical"),
    resources: [...new Set(resources)].sort(),
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L3",
      authority: "human",
      idempotency: "conditional",
      retryability: "guarded",
      reversibility: "compensatable",
      filesystemScope: [snapshot.location, ...snapshot.files.map((item) => item.path)],
      networkScope: [],
      secretScope: [],
      externalServices: ["git", "session-event-store", "snapshot-store"],
      compensation:
        snapshot.kind === "revert" ? "Restore the frozen source revision." : "Re-stage the frozen revert plan.",
      expectedArtifacts,
      successCriteria,
    }),
    reasonSummary: `${name} restores approved immutable file versions and changes session history; fresh human confirmation is required.`,
    requiresFreshHumanConfirmation: true,
  })
}

/** Future gateway integration must use this plan rather than caller-supplied resources. */
export function authorizationPlan(input: unknown): ActionGateway.AuthorizationPlan {
  const material = actionMaterial(input)
  return immutable({
    requests: [{ action: material.name, resources: material.resources }],
    metadata: { fresh: true, reason: material.reasonSummary },
  })
}

export * as SessionRevertSnapshot from "./revert-snapshot"
