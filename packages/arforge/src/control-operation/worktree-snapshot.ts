import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import type { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import path from "node:path"
import type { ControlRoots, PreparedCreate, PreparedRemove, PreparedReset } from "@/worktree"
import { worktreeEffectSemantics } from "./effect-catalog"

const Commit = Schema.String
const Digest = Schema.String
const Path = Schema.String
const IdentityPart = Schema.String

const DirectoryAnchor = Schema.Struct({
  /** Lexical path used for later no-follow revalidation. */
  path: Path,
  /** `realpath(path)` captured while this operation was prepared. */
  realPath: Path,
  device: IdentityPart,
  inode: IdentityPart,
})

const ScopeFields = {
  projectID: Schema.String,
  projectRoot: Path,
  location: Path,
  managedWorktreeRoot: Path,
  reservationRoot: Path,
  managedWorktreeAnchor: DirectoryAnchor,
  reservationAnchor: DirectoryAnchor,
}

const Ownership = Schema.Struct({
  version: Schema.Literal(1),
  projectID: Schema.String,
  requestID: Schema.String,
  actionID: Schema.String,
  directory: Path,
  branch: Schema.String,
  sourceCommit: Commit,
})

const CreateUnsigned = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("create"),
  requestID: Schema.String,
  ...ScopeFields,
  name: Schema.String,
  target: Path,
  branch: Schema.String,
  sourceCommit: Commit,
  ownershipReservationPath: Path,
})

const RemoveUnsigned = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("remove"),
  requestID: Schema.String,
  ...ScopeFields,
  target: Path,
  worktreePath: Path,
  branch: Schema.String,
  branchCommit: Commit,
  owner: Ownership,
  ownershipReservationPath: Path,
  mutationReservationPath: Path,
})

const ResetUnsigned = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("reset"),
  requestID: Schema.String,
  ...ScopeFields,
  target: Path,
  worktreePath: Path,
  branch: Schema.String,
  currentCommit: Commit,
  baseName: Schema.String,
  baseRef: Schema.String,
  baseCommit: Commit,
  owner: Ownership,
  ownershipReservationPath: Path,
  mutationReservationPath: Path,
})

export const UnsignedSnapshot = Schema.Union([CreateUnsigned, RemoveUnsigned, ResetUnsigned], { mode: "oneOf" })
export type UnsignedSnapshot = typeof UnsignedSnapshot.Type

const CreateSnapshot = Schema.Struct({ ...CreateUnsigned.fields, digest: Digest })
const RemoveSnapshot = Schema.Struct({ ...RemoveUnsigned.fields, digest: Digest })
const ResetSnapshot = Schema.Struct({ ...ResetUnsigned.fields, digest: Digest })

export const Snapshot = Schema.Union([CreateSnapshot, RemoveSnapshot, ResetSnapshot], { mode: "oneOf" })
export type Snapshot = typeof Snapshot.Type

export type Scope = {
  readonly projectID: string
  readonly projectRoot: string
  readonly location: string
  /** Canonical project-specific root under which managed worktrees may exist. */
  readonly managedWorktreeRoot: string
  /** Canonical project-specific root under which ownership journals may exist. */
  readonly reservationRoot: string
  /**
   * The nearest existing ordinary directory above `managedWorktreeRoot`.
   * It is not an authorization secret: it is an execution-time race detector.
   */
  readonly managedWorktreeAnchor: ControlRoots["managedWorktreeAnchor"]
  /** The equivalent root anchor for the ownership reservation hierarchy. */
  readonly reservationAnchor: ControlRoots["reservationAnchor"]
}

export type Prepared =
  | { readonly kind: "create"; readonly value: PreparedCreate }
  | { readonly kind: "remove"; readonly value: PreparedRemove }
  | { readonly kind: "reset"; readonly value: PreparedReset }

export class Error extends Schema.TaggedErrorClass<Error>()("WorktreeSnapshot.Error", {
  message: Schema.String,
}) {}

const strictDecode = Schema.decodeUnknownSync(Snapshot, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const REQUEST_ID = /^cpr_[A-Za-z0-9_-]{8,128}$/
const ACTION_ID = /^act_[A-Za-z0-9_-]{8,128}$/
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/

const fail = (message: string): never => {
  throw new Error({ message })
}

function flavor(value: string) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)) return path.win32
  if (value.startsWith("/")) return path.posix
  return undefined
}

function canonicalAbsolute(value: string, label: string) {
  if (!value || value.includes("\0")) return fail(`${label} must be a non-empty absolute path`)
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

function assertAnchor(input: ControlRoots["managedWorktreeAnchor"], root: string, label: string) {
  const anchorPath = canonicalAbsolute(input.path, `${label}.path`)
  const realPath = canonicalAbsolute(input.realPath, `${label}.realPath`)
  if (!/^\d+$/.test(input.device) || !/^\d+$/.test(input.inode)) fail(`${label} identity is invalid`)
  if (!isWithin(anchorPath, root)) fail(`${label} is not an ancestor of its controlled root`)
  return { path: anchorPath, realPath, device: input.device, inode: input.inode }
}

function assertScope(input: Scope) {
  if (!PROJECT_ID.test(input.projectID)) fail("projectID is invalid")
  const projectRoot = canonicalAbsolute(input.projectRoot, "projectRoot")
  const location = canonicalAbsolute(input.location, "location")
  const managedWorktreeRoot = canonicalAbsolute(input.managedWorktreeRoot, "managedWorktreeRoot")
  const reservationRoot = canonicalAbsolute(input.reservationRoot, "reservationRoot")
  if (!isWithin(projectRoot, location)) fail("location is outside the project boundary")
  const overlaps = (left: string, right: string) => isWithin(left, right) || isWithin(right, left)
  if (overlaps(projectRoot, managedWorktreeRoot))
    fail("managedWorktreeRoot and the primary project boundary cannot overlap")
  if (overlaps(projectRoot, reservationRoot)) fail("reservationRoot and the primary project boundary cannot overlap")
  if (overlaps(managedWorktreeRoot, reservationRoot)) fail("reservationRoot and managedWorktreeRoot cannot overlap")
  const managedWorktreeAnchor = assertAnchor(input.managedWorktreeAnchor, managedWorktreeRoot, "managedWorktreeAnchor")
  const reservationAnchor = assertAnchor(input.reservationAnchor, reservationRoot, "reservationAnchor")
  return {
    projectID: input.projectID,
    projectRoot,
    location,
    managedWorktreeRoot,
    reservationRoot,
    managedWorktreeAnchor,
    reservationAnchor,
  }
}

function assertRequestID(value: string) {
  if (!REQUEST_ID.test(value)) fail("requestID is invalid")
}

function assertCommit(value: string, label: string) {
  if (!COMMIT.test(value)) fail(`${label} is not an immutable Git commit ID`)
}

function assertBranch(value: string, label: string) {
  if (
    !value ||
    value.length > 255 ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(value)
  )
    fail(`${label} is not a safe Git ref`)
  if (value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")))
    fail(`${label} is not a safe Git ref`)
}

function assertTarget(scope: ReturnType<typeof assertScope>, value: string) {
  const target = canonicalAbsolute(value, "target")
  if (!isWithin(scope.managedWorktreeRoot, target, false)) fail("target is outside the managed worktree boundary")
  if (target === scope.projectRoot) fail("target cannot be the primary project")
  return target
}

function assertReservation(scope: ReturnType<typeof assertScope>, value: string, label: string) {
  const reservation = canonicalAbsolute(value, label)
  if (!isWithin(scope.reservationRoot, reservation, false)) fail(`${label} is outside the reservation boundary`)
  return reservation
}

function expectedOwnershipReservationPath(scope: ReturnType<typeof assertScope>, target: string) {
  const implementation = flavor(scope.reservationRoot)!
  const targetKey = createHash("sha256").update(target).digest("hex")
  return implementation.join(scope.reservationRoot, `${targetKey}.json`)
}

function reservationOwnerPath(mutationPath: string, kind: "remove" | "reset", requestID: string) {
  const suffix = `.${kind}.${createHash("sha256").update(requestID).digest("hex").slice(0, 32)}.json`
  if (!mutationPath.endsWith(suffix)) fail("mutation reservation is not bound to this request and action kind")
  return mutationPath.slice(0, -suffix.length)
}

function assertOwner(
  owner: PreparedRemove["owner"],
  scope: ReturnType<typeof assertScope>,
  target: string,
  branch: string,
) {
  if (owner.version !== 1) fail("ownership reservation version is unsupported")
  if (owner.projectID !== scope.projectID) fail("ownership reservation belongs to a different project")
  assertRequestID(owner.requestID)
  if (!ACTION_ID.test(owner.actionID)) fail("ownership reservation actionID is invalid")
  if (canonicalAbsolute(owner.directory, "owner.directory") !== target)
    fail("ownership reservation target does not match the prepared target")
  if (owner.branch !== branch) fail("ownership reservation branch does not match the prepared branch")
  assertBranch(owner.branch, "owner.branch")
  assertCommit(owner.sourceCommit, "owner.sourceCommit")
  return {
    version: 1 as const,
    projectID: owner.projectID,
    requestID: owner.requestID,
    actionID: owner.actionID,
    directory: target,
    branch: owner.branch,
    sourceCommit: owner.sourceCommit,
  }
}

/**
 * A deterministic storage-integrity checksum. It detects accidental mutation
 * and mismatched recovery payloads; it is deliberately not an authorization
 * signature and must be bound to a durable action by the caller.
 */
function integrityDigest(unsigned: UnsignedSnapshot) {
  return canonicalHash(unsigned) ?? fail("snapshot is not canonically serializable")
}

function seal(unsigned: UnsignedSnapshot): Snapshot {
  return strictDecode({ ...unsigned, digest: integrityDigest(unsigned) })
}

function assertPreparedRoots(value: ControlRoots, scope: ReturnType<typeof assertScope>) {
  const roots = {
    managedWorktreeRoot: canonicalAbsolute(value.managedWorktreeRoot, "prepared.managedWorktreeRoot"),
    reservationRoot: canonicalAbsolute(value.reservationRoot, "prepared.reservationRoot"),
    managedWorktreeAnchor: assertAnchor(
      value.managedWorktreeAnchor,
      canonicalAbsolute(value.managedWorktreeRoot, "prepared.managedWorktreeRoot"),
      "prepared.managedWorktreeAnchor",
    ),
    reservationAnchor: assertAnchor(
      value.reservationAnchor,
      canonicalAbsolute(value.reservationRoot, "prepared.reservationRoot"),
      "prepared.reservationAnchor",
    ),
  }
  if (
    roots.managedWorktreeRoot !== scope.managedWorktreeRoot ||
    roots.reservationRoot !== scope.reservationRoot ||
    roots.managedWorktreeAnchor.path !== scope.managedWorktreeAnchor.path ||
    roots.managedWorktreeAnchor.realPath !== scope.managedWorktreeAnchor.realPath ||
    roots.managedWorktreeAnchor.device !== scope.managedWorktreeAnchor.device ||
    roots.managedWorktreeAnchor.inode !== scope.managedWorktreeAnchor.inode ||
    roots.reservationAnchor.path !== scope.reservationAnchor.path ||
    roots.reservationAnchor.realPath !== scope.reservationAnchor.realPath ||
    roots.reservationAnchor.device !== scope.reservationAnchor.device ||
    roots.reservationAnchor.inode !== scope.reservationAnchor.inode
  )
    fail("prepared root anchors do not match the control-operation scope")
}

export function encode(prepared: Prepared, rawScope: Scope): Snapshot {
  const scope = assertScope(rawScope)
  const requestID = prepared.value.requestID
  assertRequestID(requestID)
  assertPreparedRoots(prepared.value.roots, scope)

  if (prepared.kind === "create") {
    if (prepared.value.start.project || prepared.value.start.extra)
      fail("startup scripts cannot be persisted in a control-operation snapshot")
    if (!NAME.test(prepared.value.info.name)) fail("worktree name is invalid")
    const branch = prepared.value.info.branch ?? fail("managed worktree create requires a branch")
    if (branch !== `arforge/${prepared.value.info.name}`) fail("worktree branch is not bound to its deterministic name")
    assertBranch(branch, "branch")
    assertCommit(prepared.value.sourceCommit, "sourceCommit")
    const target = assertTarget(scope, prepared.value.info.directory)
    const implementation = flavor(target)!
    if (implementation.basename(target) !== prepared.value.info.name)
      fail("target basename does not match worktree name")
    const ownershipReservationPath = assertReservation(
      scope,
      prepared.value.reservationPath,
      "ownershipReservationPath",
    )
    if (ownershipReservationPath !== expectedOwnershipReservationPath(scope, target))
      fail("ownershipReservationPath is not bound to the managed worktree target")
    return seal({
      version: 1,
      kind: "create",
      requestID,
      ...scope,
      name: prepared.value.info.name,
      target,
      branch,
      sourceCommit: prepared.value.sourceCommit,
      ownershipReservationPath,
    })
  }

  const target = assertTarget(scope, prepared.value.directory)
  if (canonicalAbsolute(prepared.value.worktreePath, "worktreePath") !== target)
    fail("worktreePath does not match the canonical target")
  const branch =
    prepared.kind === "remove" ? (prepared.value.branch ?? prepared.value.owner.branch) : prepared.value.owner.branch
  assertBranch(branch, "branch")
  const owner = assertOwner(prepared.value.owner, scope, target, branch)
  const mutationReservationPath = assertReservation(
    scope,
    prepared.value.mutationReservationPath,
    "mutationReservationPath",
  )
  const ownershipReservationPath = assertReservation(
    scope,
    reservationOwnerPath(mutationReservationPath, prepared.kind, requestID),
    "ownershipReservationPath",
  )
  if (ownershipReservationPath !== expectedOwnershipReservationPath(scope, target))
    fail("ownershipReservationPath is not bound to the managed worktree target")

  if (prepared.kind === "remove") {
    const branchCommit = prepared.value.branchCommit ?? fail("managed worktree remove requires a frozen branch commit")
    assertCommit(branchCommit, "branchCommit")
    return seal({
      version: 1,
      kind: "remove",
      requestID,
      ...scope,
      target,
      worktreePath: target,
      branch,
      branchCommit,
      owner,
      ownershipReservationPath,
      mutationReservationPath,
    })
  }

  if (prepared.value.start.project || prepared.value.start.extra)
    fail("startup scripts cannot be persisted in a control-operation snapshot")
  assertCommit(prepared.value.currentCommit, "currentCommit")
  assertBranch(prepared.value.base.ref, "baseRef")
  assertBranch(prepared.value.base.name, "baseName")
  assertCommit(prepared.value.base.commit, "baseCommit")
  return seal({
    version: 1,
    kind: "reset",
    requestID,
    ...scope,
    target,
    worktreePath: target,
    branch,
    currentCommit: prepared.value.currentCommit,
    baseName: prepared.value.base.name,
    baseRef: prepared.value.base.ref,
    baseCommit: prepared.value.base.commit,
    owner,
    ownershipReservationPath,
    mutationReservationPath,
  })
}

function unsigned(snapshot: Snapshot): UnsignedSnapshot {
  const { digest: _digest, ...value } = snapshot
  return value as UnsignedSnapshot
}

/** The exact canonical input whose digest is stored in action/run metadata. */
export function executionInput(snapshot: Snapshot): UnsignedSnapshot {
  return unsigned(snapshot)
}

export type CompletionResult =
  | {
      readonly kind: "worktree.create"
      readonly name: string
      readonly directory: string
      readonly branch: string
    }
  | {
      readonly kind: "worktree.remove" | "worktree.reset"
      readonly completed: true
    }

export type PresentedInput =
  | {
      readonly operation: "worktree.create"
      readonly requestID: string
      readonly payload: { readonly requestID: string; readonly name?: string; readonly startCommand?: string }
    }
  | {
      readonly operation: "worktree.remove" | "worktree.reset"
      readonly requestID: string
      readonly payload: { readonly requestID: string; readonly directory: string }
    }

/** Shared pure normalization used by preparation and exact-retry validation. */
export const normalizeCreateName = (requested: string | undefined, requestID: string) => {
  const normalized = requested
    ? requested
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "")
    : ""
  return normalized || `worktree-${createHash("sha256").update(requestID).digest("hex").slice(0, 12)}`
}

/**
 * Prove that an HTTP retry represents the same normalized input as an
 * existing sealed operation. This is intentionally pure: an exact retry may
 * arrive after create/remove changed the filesystem, so it cannot re-run
 * preflight merely to establish request identity.
 */
export function matchesPresentedInput(input: unknown, expected: PresentedInput): boolean {
  try {
    if (expected.payload.requestID !== expected.requestID) return false
    const candidate = strictDecode(input)
    const decoded = decode(candidate, {
      projectID: candidate.projectID,
      projectRoot: candidate.projectRoot,
      location: candidate.location,
      managedWorktreeRoot: candidate.managedWorktreeRoot,
      reservationRoot: candidate.reservationRoot,
      managedWorktreeAnchor: candidate.managedWorktreeAnchor,
      reservationAnchor: candidate.reservationAnchor,
    }).snapshot
    if (`worktree.${decoded.kind}` !== expected.operation) return false
    if (expected.operation === "worktree.create") {
      if (decoded.kind !== "create") return false
      return (
        decoded.name === normalizeCreateName(expected.payload.name, expected.requestID) &&
        (expected.payload.startCommand?.trim() ?? "") === ""
      )
    }
    if (decoded.kind === "create") return false
    return decoded.target === canonicalAbsolute(expected.payload.directory, "presented.directory")
  } catch {
    return false
  }
}

/**
 * Project the minimum terminal result needed by a desktop continuation. The
 * full sealed payload remains private: this re-runs strict schema, checksum,
 * path, ownership, and scope validation before returning display-safe fields.
 */
export function completionResult(
  input: unknown,
  expected: { readonly projectID: string; readonly location: string; readonly operation: string },
): CompletionResult {
  let candidate: Snapshot
  try {
    candidate = strictDecode(input)
  } catch (cause) {
    return fail(`snapshot schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  const decoded = decode(candidate, {
    projectID: candidate.projectID,
    projectRoot: candidate.projectRoot,
    location: candidate.location,
    managedWorktreeRoot: candidate.managedWorktreeRoot,
    reservationRoot: candidate.reservationRoot,
    managedWorktreeAnchor: candidate.managedWorktreeAnchor,
    reservationAnchor: candidate.reservationAnchor,
  }).snapshot
  if (
    decoded.projectID !== expected.projectID ||
    decoded.location !== canonicalAbsolute(expected.location, "expected.location")
  )
    fail("snapshot project or location does not match the requested control operation")
  const operation = `worktree.${decoded.kind}`
  if (operation !== expected.operation) fail("snapshot kind does not match the requested control operation")
  if (decoded.kind === "create") {
    return {
      kind: "worktree.create",
      name: decoded.name,
      directory: decoded.target,
      branch: decoded.branch,
    }
  }
  return { kind: operation, completed: true } as CompletionResult
}

function assertDecodedScope(snapshot: Snapshot, expected: Scope) {
  const scope = assertScope(expected)
  const stored = assertScope(snapshot)
  if (
    stored.projectID !== scope.projectID ||
    stored.projectRoot !== scope.projectRoot ||
    stored.location !== scope.location ||
    stored.managedWorktreeRoot !== scope.managedWorktreeRoot ||
    stored.reservationRoot !== scope.reservationRoot ||
    stored.managedWorktreeAnchor.path !== scope.managedWorktreeAnchor.path ||
    stored.managedWorktreeAnchor.realPath !== scope.managedWorktreeAnchor.realPath ||
    stored.managedWorktreeAnchor.device !== scope.managedWorktreeAnchor.device ||
    stored.managedWorktreeAnchor.inode !== scope.managedWorktreeAnchor.inode ||
    stored.reservationAnchor.path !== scope.reservationAnchor.path ||
    stored.reservationAnchor.realPath !== scope.reservationAnchor.realPath ||
    stored.reservationAnchor.device !== scope.reservationAnchor.device ||
    stored.reservationAnchor.inode !== scope.reservationAnchor.inode
  )
    fail("snapshot project or location scope does not match the current control run")
  if (
    snapshot.projectRoot !== stored.projectRoot ||
    snapshot.location !== stored.location ||
    snapshot.managedWorktreeRoot !== stored.managedWorktreeRoot ||
    snapshot.reservationRoot !== stored.reservationRoot ||
    snapshot.managedWorktreeAnchor.path !== stored.managedWorktreeAnchor.path ||
    snapshot.managedWorktreeAnchor.realPath !== stored.managedWorktreeAnchor.realPath ||
    snapshot.reservationAnchor.path !== stored.reservationAnchor.path ||
    snapshot.reservationAnchor.realPath !== stored.reservationAnchor.realPath
  )
    fail("snapshot paths are not canonical")
  return stored
}

export function decode(input: unknown, expected: Scope): { readonly snapshot: Snapshot; readonly prepared: Prepared } {
  let snapshot: Snapshot
  try {
    snapshot = strictDecode(input)
  } catch (cause) {
    return fail(`snapshot schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  if (snapshot.digest !== integrityDigest(unsigned(snapshot))) fail("snapshot digest does not match its stored payload")
  assertRequestID(snapshot.requestID)
  const scope = assertDecodedScope(snapshot, expected)
  const target = assertTarget(scope, snapshot.target)
  if (snapshot.target !== target) fail("snapshot target is not canonical")
  assertBranch(snapshot.branch, "branch")
  const ownershipReservationPath = assertReservation(
    scope,
    snapshot.ownershipReservationPath,
    "ownershipReservationPath",
  )
  if (snapshot.ownershipReservationPath !== ownershipReservationPath) fail("ownershipReservationPath is not canonical")
  if (ownershipReservationPath !== expectedOwnershipReservationPath(scope, target))
    fail("ownershipReservationPath is not bound to the managed worktree target")

  if (snapshot.kind === "create") {
    if (!NAME.test(snapshot.name) || snapshot.branch !== `arforge/${snapshot.name}`)
      fail("create name and branch binding is invalid")
    if (flavor(target)!.basename(target) !== snapshot.name) fail("create target basename does not match its name")
    assertCommit(snapshot.sourceCommit, "sourceCommit")
    return {
      snapshot,
      prepared: {
        kind: "create",
        value: {
          info: { name: snapshot.name, branch: snapshot.branch, directory: target },
          start: { project: "", extra: "" },
          requestID: snapshot.requestID,
          reservationPath: ownershipReservationPath,
          sourceCommit: snapshot.sourceCommit,
          roots: {
            managedWorktreeRoot: scope.managedWorktreeRoot,
            reservationRoot: scope.reservationRoot,
            managedWorktreeAnchor: scope.managedWorktreeAnchor,
            reservationAnchor: scope.reservationAnchor,
          },
        },
      },
    }
  }

  if (snapshot.worktreePath !== target) fail("worktreePath is not the canonical target")
  const mutationReservationPath = assertReservation(scope, snapshot.mutationReservationPath, "mutationReservationPath")
  if (snapshot.mutationReservationPath !== mutationReservationPath) fail("mutationReservationPath is not canonical")
  if (reservationOwnerPath(mutationReservationPath, snapshot.kind, snapshot.requestID) !== ownershipReservationPath)
    fail("mutation reservation does not belong to the stored ownership reservation")
  const owner = assertOwner(snapshot.owner, scope, target, snapshot.branch)

  if (snapshot.kind === "remove") {
    assertCommit(snapshot.branchCommit, "branchCommit")
    return {
      snapshot,
      prepared: {
        kind: "remove",
        value: {
          directory: target,
          worktreePath: target,
          branch: snapshot.branch,
          branchCommit: snapshot.branchCommit,
          requestID: snapshot.requestID,
          owner,
          mutationReservationPath,
          roots: {
            managedWorktreeRoot: scope.managedWorktreeRoot,
            reservationRoot: scope.reservationRoot,
            managedWorktreeAnchor: scope.managedWorktreeAnchor,
            reservationAnchor: scope.reservationAnchor,
          },
        },
      },
    }
  }

  assertCommit(snapshot.currentCommit, "currentCommit")
  assertBranch(snapshot.baseName, "baseName")
  assertBranch(snapshot.baseRef, "baseRef")
  assertCommit(snapshot.baseCommit, "baseCommit")
  return {
    snapshot,
    prepared: {
      kind: "reset",
      value: {
        directory: target,
        worktreePath: target,
        start: { project: "", extra: "" },
        requestID: snapshot.requestID,
        owner,
        mutationReservationPath,
        currentCommit: snapshot.currentCommit,
        base: { name: snapshot.baseName, ref: snapshot.baseRef, commit: snapshot.baseCommit },
        roots: {
          managedWorktreeRoot: scope.managedWorktreeRoot,
          reservationRoot: scope.reservationRoot,
          managedWorktreeAnchor: scope.managedWorktreeAnchor,
          reservationAnchor: scope.reservationAnchor,
        },
      },
    },
  }
}

export type ActionMaterial = {
  readonly name: "worktree.create" | "worktree.remove" | "worktree.reset"
  readonly inputDigest: string
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly reasonSummary: string
}

/**
 * Returns the frozen operation identity without request-bound reservation
 * material.  The sealed snapshot remains the exact executable payload; this
 * projection is only for ClaimIndex's canonical binding so a second user
 * gesture can become an alias without ever replacing the first snapshot.
 */
export function claimMaterial(snapshot: Snapshot): { readonly input: unknown; readonly payload: unknown } {
  const scope = {
    version: 1,
    projectID: snapshot.projectID,
    projectRoot: snapshot.projectRoot,
    location: snapshot.location,
    managedWorktreeRoot: snapshot.managedWorktreeRoot,
    reservationRoot: snapshot.reservationRoot,
    managedWorktreeAnchor: snapshot.managedWorktreeAnchor,
    reservationAnchor: snapshot.reservationAnchor,
  }
  if (snapshot.kind === "create") {
    const payload = {
      ...scope,
      kind: snapshot.kind,
      name: snapshot.name,
      target: snapshot.target,
      branch: snapshot.branch,
      sourceCommit: snapshot.sourceCommit,
    }
    return { input: payload, payload }
  }
  const stableOwner = {
    version: snapshot.owner.version,
    projectID: snapshot.owner.projectID,
    directory: snapshot.owner.directory,
    branch: snapshot.owner.branch,
    sourceCommit: snapshot.owner.sourceCommit,
  }
  if (snapshot.kind === "remove") {
    const payload = {
      ...scope,
      kind: snapshot.kind,
      target: snapshot.target,
      worktreePath: snapshot.worktreePath,
      branch: snapshot.branch,
      branchCommit: snapshot.branchCommit,
      owner: stableOwner,
    }
    return { input: payload, payload }
  }
  const payload = {
    ...scope,
    kind: snapshot.kind,
    target: snapshot.target,
    worktreePath: snapshot.worktreePath,
    branch: snapshot.branch,
    currentCommit: snapshot.currentCommit,
    baseName: snapshot.baseName,
    baseRef: snapshot.baseRef,
    baseCommit: snapshot.baseCommit,
    owner: stableOwner,
  }
  return { input: payload, payload }
}

/**
 * The one authorization plan a worktree control run may present.  It is
 * rebuilt from the sealed snapshot at execution time; callers never carry a
 * mutable plan across the approval boundary.
 */
export function authorizationPlan(snapshot: Snapshot, _actionID: string): ActionGateway.AuthorizationPlan {
  const material = actionMaterial(snapshot)
  return {
    requests: [{ action: material.name, resources: material.resources }],
    // Action identity is already bound by ActionGateway's durable input. It
    // must not appear in claim material: an equivalent second request has a
    // distinct presentation action ID but must remain a request alias.
    metadata: { reason: `${material.name} requires a fresh confirmation.` },
  }
}

/** Derives the complete ActionGateway declaration only from the sealed snapshot. */
export function actionMaterial(snapshot: Snapshot): ActionMaterial {
  const resources = (...items: ReadonlyArray<string>) => [...new Set(items)].sort()
  const common = {
    // Snapshot integrity remains request-bound, but durable action identity
    // must be stable when another request aliases the already sealed run.
    // The worker still verifies the complete payload and its digest before
    // handing anything to the guarded Worktree executor.
    inputDigest: canonicalHash(claimMaterial(snapshot).input) ?? fail("control claim material is not canonical"),
    semantics: (input: {
      readonly expectedArtifacts: ReadonlyArray<string>
      readonly successCriteria: ReadonlyArray<string>
      readonly networkScope?: ReadonlyArray<string>
    }) =>
      worktreeEffectSemantics({
        filesystemScope: [
          snapshot.projectRoot,
          snapshot.managedWorktreeRoot,
          snapshot.reservationRoot,
          snapshot.target,
          snapshot.ownershipReservationPath,
        ],
        ...input,
      }),
  }

  if (snapshot.kind === "create")
    return {
      name: "worktree.create",
      inputDigest: common.inputDigest,
      resources: resources(
        `filesystem:${snapshot.location}`,
        `git-metadata:${snapshot.projectRoot}`,
        `filesystem:${snapshot.target}`,
        `branch:${snapshot.branch}`,
        `commit:${snapshot.sourceCommit}`,
        `reservation:${snapshot.ownershipReservationPath}`,
        `project-registry:${snapshot.projectID}`,
        "git:worktree-add",
        "process:repository-configured-git-filter",
      ),
      semantics: common.semantics({
        expectedArtifacts: [snapshot.target, snapshot.ownershipReservationPath],
        successCriteria: [
          `git worktree list contains ${snapshot.target}`,
          `git HEAD at ${snapshot.target} equals ${snapshot.sourceCommit}`,
          `git branch ${snapshot.branch} resolves to ${snapshot.sourceCommit}`,
          `project registry ${snapshot.projectID} contains sandbox ${snapshot.target}`,
        ],
      }),
      reasonSummary: "Create a new isolated worktree and bootstrap it.",
    }

  if (snapshot.kind === "remove")
    return {
      name: "worktree.remove",
      inputDigest: common.inputDigest,
      resources: resources(
        `filesystem:${snapshot.target}`,
        `git-metadata:${snapshot.projectRoot}`,
        `branch:${snapshot.branch}`,
        `commit:${snapshot.branchCommit}`,
        `reservation:${snapshot.ownershipReservationPath}`,
        "git:worktree-remove",
        "filesystem:remove-recursive",
        `project-registry:${snapshot.projectID}`,
      ),
      semantics: common.semantics({
        expectedArtifacts: [],
        successCriteria: [
          `git worktree list excludes ${snapshot.target}`,
          `filesystem path ${snapshot.target} does not exist`,
          `git branch ${snapshot.branch} does not exist`,
          `project registry ${snapshot.projectID} excludes sandbox ${snapshot.target}`,
        ],
      }),
      reasonSummary: "Remove this isolated worktree, its files, and its Git branch.",
    }

  return {
    name: "worktree.reset",
    inputDigest: common.inputDigest,
    resources: resources(
      `filesystem:${snapshot.target}`,
      `git-metadata:${snapshot.projectRoot}`,
      "git:reset-hard",
      "git:clean-force",
      "git:submodule-reset-clean",
      `git:reset-source:${snapshot.baseRef}`,
      `commit:${snapshot.baseCommit}`,
      `reservation:${snapshot.ownershipReservationPath}`,
      `project-registry:${snapshot.projectID}`,
      "process:repository-configured-git-filter",
    ),
    semantics: common.semantics({
      expectedArtifacts: [snapshot.target],
      successCriteria: [
        `git HEAD at ${snapshot.target} equals ${snapshot.baseCommit}`,
        `git status --porcelain at ${snapshot.target} is empty`,
        `initialized submodules at ${snapshot.target} are reset and clean`,
      ],
      networkScope: ["git:submodule-remotes"],
    }),
    reasonSummary: "Reset and clean this isolated worktree to the approved Git source.",
  }
}

export * as WorktreeSnapshot from "./worktree-snapshot"
