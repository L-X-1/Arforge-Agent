import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { path } from "@arforge-ai/core/effect/app-node-platform"
import { Global } from "@arforge-ai/core/global"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Database } from "@arforge-ai/core/database/database"
import { eq } from "drizzle-orm"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import type { ProjectV2 } from "@arforge-ai/core/project"
import type { Base as GitBase } from "@/git"
import { Slug } from "@arforge-ai/core/util/slug"
import { createHash, randomUUID } from "node:crypto"
import { errorMessage } from "../util/error"
import { GlobalBus } from "@/bus/global"
import { Git } from "@/git"
import { Effect, Layer, Path, Schema, Scope, Context, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { AppProcess } from "@arforge-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { WorktreeEvent } from "@arforge-ai/schema/worktree-event"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"

export const Event = WorktreeEvent

export const Info = Schema.Struct({
  name: Schema.String,
  branch: Schema.optional(Schema.String),
  directory: Schema.String,
}).annotate({ identifier: "Worktree" })
export type Info = Schema.Schema.Type<typeof Info>

export const CreateInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  startCommand: Schema.optional(
    Schema.String.annotate({ description: "Additional startup script to run after the project's start command" }),
  ),
}).annotate({ identifier: "WorktreeCreateInput" })
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const RemoveInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeRemoveInput" })
export type RemoveInput = Schema.Schema.Type<typeof RemoveInput>

export const ResetInput = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "WorktreeResetInput" })
export type ResetInput = Schema.Schema.Type<typeof ResetInput>

export class NotGitError extends Schema.TaggedErrorClass<NotGitError>()("WorktreeNotGitError", {
  message: Schema.String,
}) {}

export class NameGenerationFailedError extends Schema.TaggedErrorClass<NameGenerationFailedError>()(
  "WorktreeNameGenerationFailedError",
  {
    message: Schema.String,
  },
) {}

export class CreateFailedError extends Schema.TaggedErrorClass<CreateFailedError>()("WorktreeCreateFailedError", {
  message: Schema.String,
}) {}

export class StartCommandFailedError extends Schema.TaggedErrorClass<StartCommandFailedError>()(
  "WorktreeStartCommandFailedError",
  {
    message: Schema.String,
  },
) {}

export class RemoveFailedError extends Schema.TaggedErrorClass<RemoveFailedError>()("WorktreeRemoveFailedError", {
  message: Schema.String,
}) {}

export class ResetFailedError extends Schema.TaggedErrorClass<ResetFailedError>()("WorktreeResetFailedError", {
  message: Schema.String,
}) {}

export class ListFailedError extends Schema.TaggedErrorClass<ListFailedError>()("WorktreeListFailedError", {
  message: Schema.String,
}) {}

export class OwnershipFailedError extends Schema.TaggedErrorClass<OwnershipFailedError>()(
  "WorktreeOwnershipFailedError",
  {
    message: Schema.String,
  },
) {}

/** A sealed control worker failed one of the local capability/snapshot guards. */
export class ControlExecutionDeniedError extends Schema.TaggedErrorClass<ControlExecutionDeniedError>()(
  "WorktreeControlExecutionDeniedError",
  { message: Schema.String },
) {}

export type Error =
  | NotGitError
  | NameGenerationFailedError
  | CreateFailedError
  | StartCommandFailedError
  | RemoveFailedError
  | ResetFailedError
  | ListFailedError
  | OwnershipFailedError
  | ControlExecutionDeniedError

interface OwnershipReservation {
  readonly version: 1
  readonly projectID: string
  readonly requestID: string
  readonly actionID: string
  readonly directory: string
  readonly branch: string
  readonly sourceCommit: string
}

interface MutationReservation {
  readonly version: 1
  readonly kind: "remove" | "reset"
  readonly projectID: string
  readonly requestID: string
  readonly actionID: string
  readonly directory: string
  readonly sourceCommit: string
  readonly currentCommit: string
  readonly baseRef?: string
  readonly baseName?: string
}

/**
 * A read-only snapshot made before the control-plane asks for approval.  The
 * execution half receives this exact value rather than re-resolving caller
 * input after a human has approved it.
 */
export interface PreparedCreate {
  readonly info: Info
  readonly start: StartScripts
  readonly requestID: string
  readonly reservationPath: string
  readonly sourceCommit: string
  readonly roots: ControlRoots
}

export interface PreparedRemove {
  readonly directory: string
  readonly worktreePath: string
  readonly branch?: string
  readonly branchCommit?: string
  readonly requestID: string
  readonly owner: OwnershipReservation
  readonly mutationReservationPath: string
  readonly roots: ControlRoots
}

export interface PreparedReset {
  readonly directory: string
  readonly worktreePath: string
  readonly start: StartScripts
  readonly requestID: string
  readonly owner: OwnershipReservation
  readonly mutationReservationPath: string
  readonly currentCommit: string
  /** The exact immutable reset source inspected before the human approved this action. */
  readonly base: GitBase & { readonly commit: string }
  readonly roots: ControlRoots
}

interface StartScripts {
  readonly project: string
  readonly extra: string
}

/**
 * An ordinary-directory identity captured before a control-plane action is
 * approved. Revalidation deliberately uses both the lexical path and its
 * physical identity so a Windows junction/symlink replacement fails closed.
 */
export interface DirectoryAnchor {
  readonly path: string
  readonly realPath: string
  readonly device: string
  readonly inode: string
}

/**
 * Trusted roots for a prepared control-plane worktree operation. The roots
 * are persisted by the control-operation snapshot and checked before every
 * mutating Git/filesystem step; they are not credentials or authorization.
 */
export interface ControlRoots {
  readonly managedWorktreeRoot: string
  readonly reservationRoot: string
  readonly managedWorktreeAnchor: DirectoryAnchor
  readonly reservationAnchor: DirectoryAnchor
}

/** @internal Deterministic fault-injection seam used only by Worktree safety tests. */
export type SafetySideEffect =
  | "create.fs-mkdir-parent"
  | "create.git-worktree-add"
  | "create.git-reset-hard"
  | "create.project-registry-add"
  | "reservation.fs-mkdir-root"
  | "reservation.fs-publish"
  | "remove.git-fsmonitor-stop"
  | "remove.git-worktree-list"
  | "remove.git-current-head"
  | "remove.git-worktree-remove"
  | "remove.git-worktree-list-after-remove"
  | "remove.fs-recursive-clean"
  | "remove.project-registry-remove"
  | "remove.git-branch-resolve"
  | "remove.git-branch-delete"
  | "reset.git-worktree-list"
  | "reset.git-current-head"
  | "reset.git-base-verify"
  | "reset.git-reset-hard"
  | "reset.git-clean"
  | "reset.fs-prune"
  | "reset.git-clean-retry"
  | "reset.git-submodule-update"
  | "reset.git-submodule-reset"
  | "reset.git-submodule-clean"
  | "reset.git-status"
  | "reset.git-head-verify"

/** @internal Supplied only by tests; production builds deliberately omit this service. */
export interface SafetyTestHookInterface {
  readonly beforeGuard?: (point: SafetySideEffect) => Effect.Effect<void>
  readonly afterSideEffect?: (point: SafetySideEffect) => Effect.Effect<void>
}

/** @internal */
export class SafetyTestHooks extends Context.Service<SafetyTestHooks, SafetyTestHookInterface>()(
  "@arforge/WorktreeSafetyTestHooks",
) {}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

function stringField(input: Record<string, unknown>, key: string) {
  return typeof input[key] === "string" && input[key].length > 0
}

function isOwnershipReservation(input: unknown): input is OwnershipReservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  return (
    value.version === 1 &&
    stringField(value, "projectID") &&
    stringField(value, "requestID") &&
    stringField(value, "actionID") &&
    stringField(value, "directory") &&
    stringField(value, "branch") &&
    stringField(value, "sourceCommit")
  )
}

function isMutationReservation(input: unknown): input is MutationReservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const value = input as Record<string, unknown>
  return (
    value.version === 1 &&
    (value.kind === "remove" || value.kind === "reset") &&
    stringField(value, "projectID") &&
    stringField(value, "requestID") &&
    stringField(value, "actionID") &&
    stringField(value, "directory") &&
    stringField(value, "sourceCommit") &&
    stringField(value, "currentCommit") &&
    (value.kind !== "reset" || (stringField(value, "baseRef") && stringField(value, "baseName")))
  )
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export interface Interface {
  readonly makeWorktreeInfo: (options?: { name?: string; detached?: boolean }) => Effect.Effect<Info, Error>
  readonly createFromInfo: (info: Info, startCommand?: string) => Effect.Effect<void, Error>
  readonly create: (input?: CreateInput) => Effect.Effect<Info, Error>
  /** Read-only, deterministic preparation for an L3 control-plane create. */
  readonly prepareCreate: (input: CreateInput | undefined, requestID: string) => Effect.Effect<PreparedCreate, Error>
  /** Runs the approved setup, checkout, and bootstrap steps. Startup scripts are a separate L3 action. */
  readonly createPrepared: (input: PreparedCreate, actionID: string) => Effect.Effect<Info, Error>
  readonly list: () => Effect.Effect<(Omit<Info, "branch"> & { branch?: string })[], Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<boolean, Error>
  /** Read-only target resolution for an L3 control-plane remove. */
  readonly prepareRemove: (input: RemoveInput, requestID: string) => Effect.Effect<PreparedRemove, Error>
  readonly removePrepared: (input: PreparedRemove, actionID: string) => Effect.Effect<boolean, Error>
  readonly reset: (input: ResetInput) => Effect.Effect<boolean, Error>
  /** Read-only target resolution for an L3 control-plane reset. Startup scripts are a separate L3 action. */
  readonly prepareReset: (input: ResetInput, requestID: string) => Effect.Effect<PreparedReset, Error>
  readonly resetPrepared: (input: PreparedReset, actionID: string) => Effect.Effect<boolean, Error>
  /** Current trusted location scope used to decode a sealed control snapshot. */
  readonly controlScope: () => Effect.Effect<WorktreeSnapshot.Scope, OwnershipFailedError>
  /**
   * Internal control-worker entry point. The only mutation API that accepts a
   * persisted control operation: it receives a sealed snapshot, opaque
   * gateway/run capabilities, and the location-bound verifier that minted the
   * run capability; it never receives caller Prepared data or a raw action ID.
   */
  readonly executeSealedControl: (input: {
    readonly snapshot: WorktreeSnapshot.Snapshot
    readonly runID: AgentRuntime.RunID
    readonly actionID: AgentRuntime.ActionID
    readonly controlLease: DurableRun.RunLeaseCapability
    readonly authorization: ActionGateway.AuthorizationGrantCapability
    readonly controlLeaseValidated: () => Effect.Effect<void>
    /** The location-bound DurableRun that minted controlLease. */
    readonly durable: DurableRun.Interface
  }) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/Worktree") {}

type GitResult = { code: number; text: string; stderr: string }

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Path.Path
  | AppProcess.Service
  | Git.Service
  | Project.Service
  | InstanceStore.Service
  | Database.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const gitSvc = yield* Git.Service
    const project = yield* Project.Service
    const store = yield* InstanceStore.Service
    const safetyTestHooks = Option.getOrUndefined(yield* Effect.serviceOption(SafetyTestHooks))

    const beforeSafetyGuard = (point: SafetySideEffect) => safetyTestHooks?.beforeGuard?.(point) ?? Effect.void
    const afterSafetySideEffect = (point: SafetySideEffect) => safetyTestHooks?.afterSideEffect?.(point) ?? Effect.void

    function guardedSideEffect<A, E, R>(
      point: SafetySideEffect,
      guard: () => Effect.Effect<void, Error>,
      effect: Effect.Effect<A, E, R>,
    ) {
      return Effect.gen(function* () {
        yield* beforeSafetyGuard(point)
        yield* guard()
        const result = yield* effect
        yield* afterSafetySideEffect(point)
        return result
      })
    }

    // Do not leak the desktop process environment (including model/provider
    // credentials) into Git or project commands. Git only needs executable
    // discovery and the platform shell variables below; repository-local
    // configuration remains available from the checked-out worktree.
    const childEnvironment = Object.fromEntries(
      [
        "PATH",
        "Path",
        "SYSTEMROOT",
        "SystemRoot",
        "COMSPEC",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
      ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ) as Record<string, string>

    const git = Effect.fnUntraced(
      function* (args: string[], opts?: { cwd?: string }) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", args, {
            cwd: opts?.cwd,
            env: childEnvironment,
            extendEnv: false,
            stdin: "ignore",
          }),
        )
        return {
          code: result.exitCode,
          text: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        } satisfies GitResult
      },
      Effect.catch((e) =>
        Effect.succeed({
          code: 1,
          text: "",
          stderr: e instanceof Error ? e.message : String(e),
        } satisfies GitResult),
      ),
    )

    const lexicalPath = (input: string) => {
      const normalized = pathSvc.normalize(pathSvc.resolve(input))
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    }

    const isWithinPath = (root: string, target: string) => {
      const relative = pathSvc.relative(root, target)
      return (
        relative === "" ||
        (!relative.startsWith(`..${pathSvc.sep}`) && relative !== ".." && !pathSvc.isAbsolute(relative))
      )
    }

    const captureDirectoryAnchor = Effect.fnUntraced(function* (input: string, label: string) {
      const requested = lexicalPath(input)
      return yield* Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const info = await fsp.lstat(requested)
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new globalThis.Error(`${label} must be an ordinary directory, not a link or reparse point`)
          const realPath = lexicalPath(await fsp.realpath(requested))
          const realInfo = await fsp.lstat(realPath)
          if (!realInfo.isDirectory() || realInfo.isSymbolicLink())
            throw new globalThis.Error(`${label} resolves through a link or reparse point`)
          return {
            path: requested,
            realPath,
            device: String(info.dev),
            inode: String(info.ino),
          } satisfies DirectoryAnchor
        },
        catch: (cause) => new OwnershipFailedError({ message: `Cannot verify ${label}: ${errorMessage(cause)}` }),
      })
    })

    const assertDirectoryAnchor = Effect.fnUntraced(function* (anchor: DirectoryAnchor, label: string) {
      const current = yield* captureDirectoryAnchor(anchor.path, label)
      if (current.realPath !== anchor.realPath || current.device !== anchor.device || current.inode !== anchor.inode)
        return yield* new OwnershipFailedError({
          message: `${label} changed after approval; recovery is blocked`,
        })
      return current
    })

    /** Finds the closest existing ordinary ancestor without following a link. */
    const nearestExistingAnchor = Effect.fnUntraced(function* (input: string, label: string) {
      const requested = lexicalPath(input)
      let candidate = requested
      while (true) {
        if (yield* fs.existsSafe(candidate)) return yield* captureDirectoryAnchor(candidate, label)
        const parent = pathSvc.dirname(candidate)
        if (parent === candidate)
          return yield* new OwnershipFailedError({ message: `No existing directory anchors ${label}` })
        candidate = parent
      }
    })

    /**
     * Revalidates a prepared root and each existing/created path segment below
     * it. `create` is used only inside the already-authorized execution body.
     */
    const ensureSafeDirectoryChain = Effect.fnUntraced(function* (
      anchor: DirectoryAnchor,
      targetInput: string,
      label: string,
      create: boolean,
      createPoint: SafetySideEffect,
    ) {
      const target = lexicalPath(targetInput)
      if (!isWithinPath(anchor.path, target))
        return yield* new OwnershipFailedError({ message: `${label} is outside its prepared directory anchor` })
      yield* assertDirectoryAnchor(anchor, `${label} anchor`)
      const relative = pathSvc.relative(anchor.path, target)
      let current = anchor.path
      if (!relative) return yield* captureDirectoryAnchor(current, label)
      for (const segment of relative.split(pathSvc.sep).filter(Boolean)) {
        current = pathSvc.join(current, segment)
        if (!(yield* fs.existsSafe(current))) {
          if (!create) return yield* new OwnershipFailedError({ message: `${label} disappeared after approval` })
          yield* guardedSideEffect(
            createPoint,
            () => assertDirectoryAnchor(anchor, `${label} anchor`).pipe(Effect.asVoid),
            Effect.tryPromise({
              try: async () => {
                const fsp = await import("fs/promises")
                await fsp.mkdir(current)
              },
              catch: (cause) => new OwnershipFailedError({ message: `Cannot create ${label}: ${errorMessage(cause)}` }),
            }),
          )
        }
        const directory = yield* captureDirectoryAnchor(current, label)
        if (!isWithinPath(anchor.realPath, directory.realPath))
          return yield* new OwnershipFailedError({
            message: `${label} resolves outside its prepared directory anchor`,
          })
        yield* assertDirectoryAnchor(anchor, `${label} anchor`)
      }
      return yield* captureDirectoryAnchor(target, label)
    })

    const sameDirectory = (left: DirectoryAnchor, right: DirectoryAnchor) =>
      left.realPath === right.realPath && left.device === right.device && left.inode === right.inode

    type PruneTargetIdentity = {
      readonly realPath: string
      readonly device: string
      readonly inode: string
      readonly mode: number
    }

    /**
     * Verifies every lexical component below the captured worktree root
     * without trusting an earlier realpath result. This runs after the safety
     * hook and immediately before recursive removal, so replacing an internal
     * parent with a symlink, junction, or other reparse target fails closed.
     */
    const verifyPruneTarget = Effect.fnUntraced(function* (
      root: DirectoryAnchor,
      targetInput: string,
      expected?: PruneTargetIdentity,
    ) {
      const checkedRoot = yield* assertDirectoryAnchor(root, "reset prune worktree root")
      const target = lexicalPath(targetInput)
      if (target === root.path || !isWithinPath(root.path, target))
        return yield* new OwnershipFailedError({ message: "Reset prune target is outside the captured worktree" })

      const relative = pathSvc.relative(root.path, target)
      const segments = relative.split(pathSvc.sep).filter(Boolean)
      let current = root.path
      let identity: PruneTargetIdentity | undefined
      for (let index = 0; index < segments.length; index++) {
        current = pathSvc.join(current, segments[index]!)
        if (!(yield* fs.existsSafe(current))) return undefined
        const inspected = yield* Effect.tryPromise({
          try: async () => {
            const fsp = await import("fs/promises")
            const info = await fsp.lstat(current)
            if (info.isSymbolicLink())
              throw new globalThis.Error("path component is a symbolic link, junction, or reparse point")
            const isTarget = index === segments.length - 1
            if (!isTarget && !info.isDirectory())
              throw new globalThis.Error("parent path component is not an ordinary directory")
            const realPath = lexicalPath(await fsp.realpath(current))
            const expectedRealPath = lexicalPath(pathSvc.join(checkedRoot.realPath, ...segments.slice(0, index + 1)))
            if (realPath !== expectedRealPath || !isWithinPath(checkedRoot.realPath, realPath))
              throw new globalThis.Error("path component resolves outside the captured worktree root")
            return {
              realPath,
              device: String(info.dev),
              inode: String(info.ino),
              mode: info.mode,
            } satisfies PruneTargetIdentity
          },
          catch: (cause) =>
            new OwnershipFailedError({ message: `Cannot safely verify reset prune target: ${errorMessage(cause)}` }),
        })
        if (index === segments.length - 1) identity = inspected
      }
      yield* assertDirectoryAnchor(root, "reset prune worktree root")
      if (!identity) return undefined
      if (
        expected &&
        (identity.realPath !== expected.realPath ||
          identity.device !== expected.device ||
          identity.inode !== expected.inode ||
          identity.mode !== expected.mode)
      )
        return yield* new OwnershipFailedError({ message: "Reset prune target identity changed before removal" })
      return identity
    })

    const reservationRoot = (projectID: ProjectV2.ID) => {
      const projectKey = createHash("sha256").update(projectID).digest("hex").slice(0, 24)
      return lexicalPath(pathSvc.join(Global.Path.data, "worktree-reservations", projectKey))
    }

    const rootsFor = Effect.fnUntraced(function* (projectID: ProjectV2.ID) {
      const managedWorktreeRoot = lexicalPath(pathSvc.join(Global.Path.data, "worktree", projectID))
      const reservation = reservationRoot(projectID)
      return {
        managedWorktreeRoot,
        reservationRoot: reservation,
        managedWorktreeAnchor: yield* nearestExistingAnchor(managedWorktreeRoot, "managed worktree root"),
        reservationAnchor: yield* nearestExistingAnchor(reservation, "worktree reservation root"),
      } satisfies ControlRoots
    })

    const controlScope = Effect.fn("Worktree.controlScope")(function* () {
      const ctx = yield* InstanceState.context
      return {
        projectID: ctx.project.id,
        projectRoot: lexicalPath(ctx.project.worktree),
        location: lexicalPath(ctx.directory),
        ...(yield* rootsFor(ctx.project.id)),
      } satisfies WorktreeSnapshot.Scope
    })

    const assertRoots = Effect.fnUntraced(function* (roots: ControlRoots, projectID: ProjectV2.ID) {
      const expectedManagedRoot = lexicalPath(pathSvc.join(Global.Path.data, "worktree", projectID))
      const expectedReservationRoot = reservationRoot(projectID)
      if (
        lexicalPath(roots.managedWorktreeRoot) !== expectedManagedRoot ||
        lexicalPath(roots.reservationRoot) !== expectedReservationRoot
      )
        return yield* new OwnershipFailedError({ message: "Prepared control roots do not match this project" })
      if (!isWithinPath(roots.managedWorktreeAnchor.path, expectedManagedRoot))
        return yield* new OwnershipFailedError({ message: "Managed root is outside its prepared anchor" })
      if (!isWithinPath(roots.reservationAnchor.path, expectedReservationRoot))
        return yield* new OwnershipFailedError({ message: "Reservation root is outside its prepared anchor" })
      yield* assertDirectoryAnchor(roots.managedWorktreeAnchor, "managed worktree root anchor")
      yield* assertDirectoryAnchor(roots.reservationAnchor, "worktree reservation root anchor")
      return {
        managedWorktreeRoot: expectedManagedRoot,
        reservationRoot: expectedReservationRoot,
      }
    })

    const ensureManagedTarget = Effect.fnUntraced(function* (
      roots: ControlRoots,
      projectID: ProjectV2.ID,
      input: string,
      options: { readonly createParents: boolean; readonly requireTarget: boolean },
    ) {
      const checked = yield* assertRoots(roots, projectID)
      const target = lexicalPath(input)
      if (!isWithinPath(checked.managedWorktreeRoot, target) || target === checked.managedWorktreeRoot)
        return yield* new OwnershipFailedError({ message: "Worktree target is outside the managed worktree root" })
      const parent = pathSvc.dirname(target)
      yield* ensureSafeDirectoryChain(
        roots.managedWorktreeAnchor,
        parent,
        "managed worktree parent",
        options.createParents,
        "create.fs-mkdir-parent",
      )
      if (!options.requireTarget) return { target, identity: undefined }
      const identity = yield* ensureSafeDirectoryChain(
        roots.managedWorktreeAnchor,
        target,
        "managed worktree target",
        false,
        "create.fs-mkdir-parent",
      )
      return { target, identity }
    })

    const ensureReservationRoot = Effect.fnUntraced(function* (roots: ControlRoots, projectID: ProjectV2.ID) {
      const checked = yield* assertRoots(roots, projectID)
      return yield* ensureSafeDirectoryChain(
        roots.reservationAnchor,
        checked.reservationRoot,
        "worktree reservation root",
        true,
        "reservation.fs-mkdir-root",
      )
    })

    const MAX_NAME_ATTEMPTS = 26
    const candidate = Effect.fn("Worktree.candidate")(function* (input: {
      root: string
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      for (const attempt of Array.from({ length: MAX_NAME_ATTEMPTS }, (_, i) => i)) {
        const name = input.name ? (attempt === 0 ? input.name : `${input.name}-${Slug.create()}`) : Slug.create()
        const branch = input.detached ? undefined : `arforge/${name}`
        const directory = pathSvc.join(input.root, name)

        if (yield* fs.exists(directory).pipe(Effect.orDie)) continue

        if (branch) {
          const ref = `refs/heads/${branch}`
          const branchCheck = yield* git(["show-ref", "--verify", "--quiet", ref], { cwd: ctx.worktree })
          if (branchCheck.code === 0) continue
        }

        return { name, directory, ...(branch ? { branch } : {}) }
      }
      return yield* new NameGenerationFailedError({ message: "Failed to generate a unique worktree name" })
    })

    const makeWorktreeInfo = Effect.fn("Worktree.makeWorktreeInfo")(function* (input?: {
      name?: string
      detached?: boolean
    }) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const root = pathSvc.join(Global.Path.data, "worktree", ctx.project.id)
      yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie)

      return yield* candidate({ root, name: input?.name ? slugify(input.name) : "", detached: input?.detached })
    })

    const setup = Effect.fnUntraced(function* (
      info: Info,
      sourceCommit = "HEAD",
      beforeSideEffect?: () => Effect.Effect<void, Error>,
      afterCreateSideEffect?: () => Effect.Effect<void, Error>,
    ) {
      const ctx = yield* InstanceState.context
      const guard = beforeSideEffect ?? (() => Effect.void)
      const createdGuard = afterCreateSideEffect ?? guard
      // The legacy name allocator normally creates this directory. A
      // control-plane intent deliberately avoids all writes before approval,
      // so create it only at the authorized execution handoff.
      yield* guardedSideEffect(
        "create.fs-mkdir-parent",
        guard,
        fs.makeDirectory(pathSvc.dirname(info.directory), { recursive: true }).pipe(Effect.orDie),
      )
      const created = yield* guardedSideEffect(
        "create.git-worktree-add",
        guard,
        git(
          info.branch
            ? ["worktree", "add", "--no-checkout", "-b", info.branch, info.directory, sourceCommit]
            : ["worktree", "add", "--no-checkout", "--detach", info.directory, sourceCommit],
          { cwd: ctx.worktree },
        ),
      )
      if (created.code !== 0) {
        return yield* new CreateFailedError({
          message: created.stderr || created.text || "Failed to create git worktree",
        })
      }

      yield* guardedSideEffect(
        "create.project-registry-add",
        createdGuard,
        project.addSandbox(ctx.project.id, info.directory),
      )
    })

    const prepareStartScripts = Effect.fnUntraced(function* (projectID: ProjectV2.ID, extra?: string) {
      const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get().pipe(Effect.orDie)
      const persisted = row ? Project.fromRow(row) : undefined
      return {
        project: persisted?.commands?.start?.trim() ?? "",
        extra: extra?.trim() ?? "",
      } satisfies StartScripts
    })

    const requireNoControlPlaneStartScripts = (start: StartScripts) => {
      if (!start.project && !start.extra) return
      return new StartCommandFailedError({
        message:
          "Configured worktree startup scripts require a separate fresh confirmation and are not run by this action",
      })
    }

    const boot = Effect.fnUntraced(function* (
      info: Info,
      start: StartScripts,
      sourceCommit = "HEAD",
      beforeSideEffect?: () => Effect.Effect<void, Error>,
    ) {
      const ctx = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const projectID = ctx.project.id
      const guard = beforeSideEffect ?? (() => Effect.void)

      const populated = yield* guardedSideEffect(
        "create.git-reset-hard",
        guard,
        git(["reset", "--hard", sourceCommit], { cwd: info.directory }),
      )
      if (populated.code !== 0) {
        const message = populated.stderr || populated.text || "Failed to populate worktree"
        yield* Effect.logError("worktree checkout failed", { directory: info.directory, message })
        GlobalBus.emit("event", {
          directory: info.directory,
          project: ctx.project.id,
          workspace: workspaceID,
          payload: { type: Event.Failed.type, properties: { message } },
        })
        return yield* new CreateFailedError({ message })
      }

      const booted = yield* store.load({ directory: info.directory }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const message = errorMessage(error)
            yield* Effect.logError("worktree bootstrap failed", { directory: info.directory, message })
            GlobalBus.emit("event", {
              directory: info.directory,
              project: ctx.project.id,
              workspace: workspaceID,
              payload: { type: Event.Failed.type, properties: { message } },
            })
            return yield* new CreateFailedError({ message })
          }),
        ),
      )
      if (!booted) return yield* new CreateFailedError({ message: "Worktree bootstrap failed" })

      GlobalBus.emit("event", {
        directory: info.directory,
        project: ctx.project.id,
        workspace: workspaceID,
        payload: {
          type: Event.Ready.type,
          properties: { name: info.name, ...(info.branch ? { branch: info.branch } : {}) },
        },
      })

      const started = yield* runStartScripts(info.directory, start)
      if (!started)
        return yield* new StartCommandFailedError({ message: "A configured worktree startup command failed" })
    })

    const createFromInfo = Effect.fn("Worktree.createFromInfo")(function* (info: Info, startCommand?: string) {
      yield* setup(info)
      const start = yield* prepareStartScripts((yield* InstanceState.context).project.id, startCommand)
      yield* boot(info, start).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree bootstrap failed", { cause })),
        Effect.forkIn(scope),
      )
    })

    const create = Effect.fn("Worktree.create")(function* (input?: CreateInput) {
      const info = yield* makeWorktreeInfo({ name: input?.name })
      yield* createFromInfo(info, input?.startCommand)
      return info
    })

    const prepareCreate = Effect.fn("Worktree.prepareCreate")(function* (
      input: CreateInput | undefined,
      requestID: string,
    ) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const name = WorktreeSnapshot.normalizeCreateName(input?.name, requestID)
      const roots = yield* rootsFor(ctx.project.id)
      const info: Info = {
        name,
        branch: `arforge/${name}`,
        directory: pathSvc.join(roots.managedWorktreeRoot, name),
      }
      const start = yield* prepareStartScripts(ctx.project.id, input?.startCommand)
      const blocked = requireNoControlPlaneStartScripts(start)
      if (blocked) return yield* blocked
      const directory = lexicalPath(info.directory)
      if (!isWithinPath(roots.managedWorktreeRoot, directory) || directory === roots.managedWorktreeRoot)
        return yield* new OwnershipFailedError({ message: "Worktree target is outside the managed worktree root" })
      if (directory === (yield* canonical(ctx.project.worktree))) {
        return yield* new CreateFailedError({ message: "Cannot create a worktree over the primary workspace" })
      }
      const ownerPath = yield* reservationPath(ctx.project.id, directory)
      const existing = yield* readOwnership(ownerPath)
      let sourceCommit: string
      if (existing) {
        if (
          existing.projectID !== ctx.project.id ||
          existing.requestID !== requestID ||
          existing.directory !== directory ||
          existing.branch !== info.branch
        ) {
          return yield* new OwnershipFailedError({
            message: "This worktree name is reserved by a different control-plane action",
          })
        }
        sourceCommit = existing.sourceCommit
      } else {
        if (yield* fs.existsSafe(info.directory)) {
          return yield* new CreateFailedError({ message: "The requested worktree directory already exists" })
        }
        const branchExists =
          (yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${info.branch}`], { cwd: ctx.worktree })).code ===
          0
        if (branchExists)
          return yield* new CreateFailedError({ message: "The requested worktree branch already exists" })
        const commit = yield* resolveCommit(ctx.worktree, "HEAD")
        if (!commit) return yield* new CreateFailedError({ message: "Cannot resolve the immutable source commit" })
        sourceCommit = commit
      }
      return { info, start, requestID, reservationPath: ownerPath, sourceCommit, roots } satisfies PreparedCreate
    })

    const createPrepared = Effect.fn("Worktree.createPrepared")(function* (input: PreparedCreate, actionID: string) {
      const blocked = requireNoControlPlaneStartScripts(input.start)
      if (blocked) return yield* blocked
      const ctx = yield* InstanceState.context
      const target = lexicalPath(input.info.directory)
      const verifyBeforeCreate = () =>
        Effect.gen(function* () {
          yield* ensureManagedTarget(input.roots, ctx.project.id, target, {
            createParents: false,
            requireTarget: false,
          })
          if (yield* fs.existsSafe(target))
            return yield* new CreateFailedError({
              message: "Worktree creation is incomplete or target changed; recovery requires a new confirmation",
            })
          yield* ensureReservationRoot(input.roots, ctx.project.id)
        })
      const verifyCreatedTarget = () =>
        Effect.gen(function* () {
          yield* ensureManagedTarget(input.roots, ctx.project.id, target, {
            createParents: false,
            requireTarget: true,
          })
          yield* ensureReservationRoot(input.roots, ctx.project.id)
        })
      yield* ensureManagedTarget(input.roots, ctx.project.id, target, {
        createParents: true,
        requireTarget: false,
      })
      const primary = yield* canonical(ctx.project.worktree)
      if (target === primary)
        return yield* new CreateFailedError({ message: "Cannot create over the primary workspace" })
      if ((yield* reservationPath(ctx.project.id, target)) !== input.reservationPath) {
        return yield* new OwnershipFailedError({ message: "Worktree reservation path changed after approval" })
      }
      if (!(yield* resolveCommit(ctx.worktree, input.sourceCommit))) {
        return yield* new CreateFailedError({ message: "The approved source commit is no longer available" })
      }
      yield* reserveOwnership(
        input.reservationPath,
        {
          version: 1,
          projectID: ctx.project.id,
          requestID: input.requestID,
          actionID,
          directory: target,
          branch: input.info.branch ?? "detached",
          sourceCommit: input.sourceCommit,
        },
        input.roots,
        ctx.project.id,
      )
      const listed = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (listed.code !== 0) {
        return yield* new CreateFailedError({ message: listed.stderr || listed.text || "Failed to read git worktrees" })
      }
      const entry = yield* locateWorktree(parseWorktreeList(listed.text), target)
      if (entry?.path) {
        const branch = entry.branch?.replace(/^refs\/heads\//, "")
        if (branch !== input.info.branch) {
          return yield* new CreateFailedError({
            message: "Worktree target changed after approval; request a new confirmation",
          })
        }
        const commit = yield* resolveCommit(entry.path, "HEAD")
        if (commit !== input.sourceCommit) {
          return yield* new CreateFailedError({
            message: "Existing worktree does not match this action's immutable source commit",
          })
        }
        yield* guardedSideEffect(
          "create.project-registry-add",
          verifyCreatedTarget,
          project.addSandbox(ctx.project.id, entry.path),
        )
      } else {
        const directoryExists = yield* fs.exists(input.info.directory).pipe(Effect.orDie)
        const branchExists = input.info.branch
          ? (yield* git(["show-ref", "--verify", "--quiet", `refs/heads/${input.info.branch}`], { cwd: ctx.worktree }))
              .code === 0
          : false
        if (directoryExists || branchExists) {
          return yield* new CreateFailedError({
            message: "Worktree creation is incomplete or target changed; recovery requires a new confirmation",
          })
        }
        yield* setup(input.info, input.sourceCommit, verifyBeforeCreate, verifyCreatedTarget)
      }
      yield* boot(input.info, input.start, input.sourceCommit, verifyCreatedTarget)
      return input.info
    })

    const canonical = Effect.fnUntraced(function* (input: string) {
      const abs = pathSvc.resolve(input)
      const real = yield* fs.realPath(abs).pipe(Effect.catch(() => Effect.succeed(abs)))
      const normalized = pathSvc.normalize(real)
      return process.platform === "win32" ? normalized.toLowerCase() : normalized
    })

    const reservationPath = Effect.fnUntraced(function* (projectID: ProjectV2.ID, directory: string) {
      const target = yield* canonical(directory)
      const targetKey = createHash("sha256").update(target).digest("hex")
      return pathSvc.join(reservationRoot(projectID), `${targetKey}.json`)
    })

    const mutationReservationPath = (ownerPath: string, kind: MutationReservation["kind"], requestID: string) =>
      `${ownerPath}.${kind}.${createHash("sha256").update(requestID).digest("hex").slice(0, 32)}.json`

    const readOwnership = Effect.fnUntraced(function* (file: string) {
      if (!(yield* fs.existsSafe(file))) return undefined
      const value = yield* fs
        .readJson(file)
        .pipe(
          Effect.mapError(
            () =>
              new OwnershipFailedError({ message: "Worktree ownership reservation is unreadable; recovery stopped" }),
          ),
        )
      if (!isOwnershipReservation(value)) {
        return yield* new OwnershipFailedError({
          message: "Worktree ownership reservation is invalid; recovery stopped",
        })
      }
      return value
    })

    const readMutation = Effect.fnUntraced(function* (file: string) {
      if (!(yield* fs.existsSafe(file))) return undefined
      const value = yield* fs
        .readJson(file)
        .pipe(
          Effect.mapError(
            () =>
              new OwnershipFailedError({ message: "Worktree mutation reservation is unreadable; recovery stopped" }),
          ),
        )
      if (!isMutationReservation(value)) {
        return yield* new OwnershipFailedError({
          message: "Worktree mutation reservation is invalid; recovery stopped",
        })
      }
      return value
    })

    const writeExclusiveReservation = Effect.fnUntraced(function* (
      file: string,
      value: OwnershipReservation | MutationReservation,
      roots: ControlRoots,
      projectID: ProjectV2.ID,
    ) {
      const root = yield* ensureReservationRoot(roots, projectID)
      if (lexicalPath(pathSvc.dirname(file)) !== root.path || !isWithinPath(root.path, lexicalPath(file)))
        return yield* new OwnershipFailedError({
          message: "Worktree ownership reservation is outside its prepared reservation root",
        })
      const verifyReservationRoot = () =>
        Effect.gen(function* () {
          const current = yield* ensureReservationRoot(roots, projectID)
          if (!sameDirectory(root, current))
            return yield* new OwnershipFailedError({
              message: "Worktree reservation root identity changed before persistence",
            })
        })
      const result = yield* guardedSideEffect(
        "reservation.fs-publish",
        verifyReservationRoot,
        Effect.tryPromise({
          try: async () => {
            const fsp = await import("fs/promises")
            const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
            try {
              // Publish only a fully written inode. A crash before `link` leaves
              // an unreferenced temp file that a retry can ignore; a crash after
              // `link` leaves a complete immutable reservation. `link` is the
              // exclusive atomic claim and never overwrites another action.
              const handle = await fsp.open(temporary, "wx", 0o600)
              try {
                await handle.writeFile(JSON.stringify(value, null, 2), "utf8")
                await handle.sync()
              } finally {
                await handle.close()
              }
              await fsp.link(temporary, file)
              return true
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
              throw error
            } finally {
              await fsp.rm(temporary, { force: true }).catch(() => undefined)
            }
          },
          catch: (cause) =>
            new OwnershipFailedError({
              message: `Failed to persist the worktree ownership reservation: ${errorMessage(cause)}`,
            }),
        }),
      )
      return result
    })

    const reserveOwnership = Effect.fnUntraced(function* (
      file: string,
      expected: OwnershipReservation,
      roots: ControlRoots,
      projectID: ProjectV2.ID,
    ) {
      if (yield* writeExclusiveReservation(file, expected, roots, projectID)) return
      const existing = yield* readOwnership(file)
      if (
        !existing ||
        existing.version !== expected.version ||
        existing.projectID !== expected.projectID ||
        existing.requestID !== expected.requestID ||
        existing.actionID !== expected.actionID ||
        existing.directory !== expected.directory ||
        existing.branch !== expected.branch ||
        existing.sourceCommit !== expected.sourceCommit
      ) {
        return yield* new OwnershipFailedError({
          message: "This worktree target is reserved by a different control-plane action",
        })
      }
    })

    const reserveMutation = Effect.fnUntraced(function* (
      file: string,
      expected: MutationReservation,
      roots: ControlRoots,
      projectID: ProjectV2.ID,
    ) {
      if (yield* writeExclusiveReservation(file, expected, roots, projectID)) return
      const existing = yield* readMutation(file)
      if (
        !existing ||
        existing.version !== expected.version ||
        existing.kind !== expected.kind ||
        existing.projectID !== expected.projectID ||
        existing.requestID !== expected.requestID ||
        existing.actionID !== expected.actionID ||
        existing.directory !== expected.directory ||
        existing.sourceCommit !== expected.sourceCommit ||
        existing.currentCommit !== expected.currentCommit ||
        existing.baseRef !== expected.baseRef ||
        existing.baseName !== expected.baseName
      ) {
        return yield* new OwnershipFailedError({
          message: "This worktree mutation is reserved by a different control-plane action",
        })
      }
    })

    const resolveCommit = Effect.fnUntraced(function* (cwd: string, ref: string) {
      const result = yield* git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd })
      if (result.code !== 0) return undefined
      const commit = result.text.trim()
      return commit || undefined
    })

    const resolveCommitGuarded = Effect.fnUntraced(function* (
      point: SafetySideEffect,
      cwd: string,
      ref: string,
      guard: () => Effect.Effect<void, Error>,
    ) {
      const result = yield* guardedSideEffect(
        point,
        guard,
        git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd }),
      )
      if (result.code !== 0) return undefined
      const commit = result.text.trim()
      return commit || undefined
    })

    /**
     * Resolve the reset base without using the generic Git service, whose
     * process runner inherits the desktop environment. Control-plane
     * preparation must not expose provider credentials to repository Git
     * configuration, even for read-only discovery.
     */
    const safeDefaultBranch = Effect.fnUntraced(function* (cwd: string) {
      const remoteResult = yield* git(["remote"], { cwd })
      const remotes =
        remoteResult.code === 0
          ? remoteResult.text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          : []
      const remote = remotes.includes("origin")
        ? "origin"
        : remotes.length === 1
          ? remotes[0]
          : remotes.includes("upstream")
            ? "upstream"
            : remotes[0]
      if (remote) {
        const head = yield* git(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.code === 0) {
          const ref = head.text.trim().replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies GitBase
        }
      }

      const refs = yield* git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
      const branches =
        refs.code === 0
          ? refs.text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          : []
      const configured = yield* git(["config", "init.defaultBranch"], { cwd })
      const configuredName = configured.code === 0 ? configured.text.trim() : ""
      if (configuredName && branches.includes(configuredName)) {
        return { name: configuredName, ref: configuredName } satisfies GitBase
      }
      if (branches.includes("main")) return { name: "main", ref: "main" } satisfies GitBase
      if (branches.includes("master")) return { name: "master", ref: "master" } satisfies GitBase
      return undefined
    })

    const ownsSandbox = Effect.fnUntraced(function* (projectID: ProjectV2.ID, directory: string) {
      const info = yield* project.get(projectID)
      if (!info) return false
      const target = yield* canonical(directory)
      for (const sandbox of info.sandboxes) {
        if ((yield* canonical(sandbox)) === target) return true
      }
      return false
    })

    function parseWorktreeList(text: string) {
      return text
        .split("\n")
        .map((line) => line.trim())
        .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
          if (!line) return acc
          if (line.startsWith("worktree ")) {
            acc.push({ path: line.slice("worktree ".length).trim() })
            return acc
          }
          const current = acc[acc.length - 1]
          if (!current) return acc
          if (line.startsWith("branch ")) {
            current.branch = line.slice("branch ".length).trim()
          }
          return acc
        }, [])
    }

    const locateWorktree = Effect.fnUntraced(function* (
      entries: { path?: string; branch?: string }[],
      directory: string,
    ) {
      for (const item of entries) {
        if (!item.path) continue
        const key = yield* canonical(item.path)
        if (key === directory) return item
      }
      return undefined
    })

    const list = Effect.fn("Worktree.list")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return []
      }

      const result = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (result.code !== 0) {
        return yield* new ListFailedError({ message: result.stderr || result.text || "Failed to read git worktrees" })
      }

      const primary = yield* canonical(ctx.project.worktree)
      const primaryName = pathSvc.basename(primary).toLowerCase()
      return yield* Effect.forEach(parseWorktreeList(result.text), (entry) =>
        Effect.gen(function* () {
          if (!entry.path) return undefined
          const directory = yield* canonical(entry.path)
          if (directory === primary) return undefined
          const name = pathSvc.basename(directory).toLowerCase()
          return {
            name: name === primaryName ? pathSvc.basename(pathSvc.dirname(directory)) : name,
            directory,
            ...(entry.branch ? { branch: entry.branch.replace(/^refs\/heads\//, "") } : {}),
          }
        }),
      ).pipe(Effect.map((items) => items.filter((item) => item !== undefined)))
    })

    function stopFsmonitor(target: string, guard?: () => Effect.Effect<void, Error>, point?: SafetySideEffect) {
      return fs.exists(target).pipe(
        Effect.orDie,
        Effect.flatMap((exists) => {
          if (!exists) return Effect.void
          const command = git(["fsmonitor--daemon", "stop"], { cwd: target })
          return guard && point ? guardedSideEffect(point, guard, command) : command
        }),
      )
    }

    function cleanDirectory(target: string, expected?: DirectoryAnchor) {
      return Effect.tryPromise({
        try: async () => {
          const fsp = await import("fs/promises")
          const attempts = process.platform === "win32" ? 50 : 5
          for (const attempt of Array.from({ length: attempts }, (_, i) => i)) {
            try {
              if (expected) {
                const info = await fsp.lstat(target)
                const realPath = lexicalPath(await fsp.realpath(target))
                if (
                  !info.isDirectory() ||
                  info.isSymbolicLink() ||
                  realPath !== expected.realPath ||
                  String(info.dev) !== expected.device ||
                  String(info.ino) !== expected.inode
                )
                  throw new globalThis.Error("Worktree target was replaced; recursive cleanup is blocked")
              }
              await fsp.rm(target, { recursive: true, force: true })
              return
            } catch (error) {
              if (attempt === attempts - 1) throw error
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
          }
        },
        catch: (error) =>
          new RemoveFailedError({ message: errorMessage(error) || "Failed to remove git worktree directory" }),
      })
    }

    const cleanPreparedDirectory = Effect.fnUntraced(function* (
      target: string,
      expected: DirectoryAnchor,
      guard: () => Effect.Effect<void, Error>,
    ) {
      yield* beforeSafetyGuard("remove.fs-recursive-clean")
      if (!(yield* fs.existsSafe(target))) return false
      yield* guard()
      yield* cleanDirectory(target, expected)
      yield* afterSafetySideEffect("remove.fs-recursive-clean")
      return true
    })

    const remove = Effect.fn("Worktree.remove")(function* (input: RemoveInput) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = yield* canonical(input.directory)

      // Preserve the loaded path casing for the store cache; `directory` is lowercased on Windows.
      if (directory !== (yield* canonical(ctx.worktree))) yield* store.disposeDirectory(input.directory)

      const list = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new RemoveFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entries = parseWorktreeList(list.text)
      const entry = yield* locateWorktree(entries, directory)

      if (!entry?.path) {
        // An unregistered path may have been recreated by another process.
        // Never recursively delete it merely because Git no longer lists the
        // original worktree.
        return true
      }

      // Git may return the original casing when a caller supplied a normalized Windows path.
      yield* store.disposeDirectory(entry.path)
      yield* stopFsmonitor(entry.path)
      const removed = yield* git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree })
      if (removed.code !== 0) {
        const next = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
        if (next.code !== 0) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
          })
        }

        const stale = yield* locateWorktree(parseWorktreeList(next.text), directory)
        if (stale?.path) {
          return yield* new RemoveFailedError({
            message: removed.stderr || removed.text || "Failed to remove git worktree",
          })
        }
      }

      yield* cleanDirectory(entry.path)

      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      if (branch) {
        const deleted = yield* git(["branch", "-D", "--", branch], { cwd: ctx.worktree })
        if (deleted.code !== 0) {
          return yield* new RemoveFailedError({
            message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
          })
        }
      }

      return true
    })

    const prepareRemove = Effect.fn("Worktree.prepareRemove")(function* (input: RemoveInput, requestID: string) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const directory = yield* canonical(input.directory)
      const roots = yield* rootsFor(ctx.project.id)
      yield* ensureManagedTarget(roots, ctx.project.id, directory, { createParents: false, requireTarget: true })
      if (directory === (yield* canonical(ctx.worktree))) {
        return yield* new RemoveFailedError({ message: "Cannot remove the primary workspace" })
      }
      const ownerPath = yield* reservationPath(ctx.project.id, directory)
      const owner = yield* readOwnership(ownerPath)
      if (
        !owner ||
        owner.projectID !== ctx.project.id ||
        owner.directory !== directory ||
        owner.branch === "detached"
      ) {
        return yield* new OwnershipFailedError({
          message:
            "This legacy or externally created worktree has no control-plane ownership reservation. Removal is blocked; create a managed worktree or use a future explicit L3 claim flow.",
        })
      }
      const removeReservationPath = mutationReservationPath(ownerPath, "remove", requestID)
      const mutation = yield* readMutation(removeReservationPath)
      if (
        mutation &&
        (mutation.kind !== "remove" ||
          mutation.projectID !== ctx.project.id ||
          mutation.requestID !== requestID ||
          mutation.directory !== directory ||
          mutation.sourceCommit !== owner.sourceCommit)
      ) {
        return yield* new OwnershipFailedError({ message: "Worktree removal reservation does not match this action" })
      }
      const listed = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (listed.code !== 0) {
        return yield* new RemoveFailedError({ message: listed.stderr || listed.text || "Failed to read git worktrees" })
      }
      const entry = yield* locateWorktree(parseWorktreeList(listed.text), directory)
      const directoryExists = yield* fs.existsSafe(directory)
      if (!entry?.path && directoryExists) {
        return yield* new RemoveFailedError({
          message: "An unregistered path exists at the approved worktree location; recursive deletion is blocked",
        })
      }
      if (!entry?.path && !mutation) return yield* new RemoveFailedError({ message: "Worktree not found" })
      const branch = entry?.branch?.replace(/^refs\/heads\//, "") ?? owner.branch
      if (branch !== owner.branch) {
        return yield* new OwnershipFailedError({
          message: "Worktree branch no longer matches its ownership reservation",
        })
      }
      const sandboxOwned = yield* ownsSandbox(ctx.project.id, directory)
      if (entry?.path && !sandboxOwned) {
        return yield* new OwnershipFailedError({ message: "Worktree is not an active sandbox of this project" })
      }
      const currentCommit = mutation?.currentCommit ?? (yield* resolveCommit(entry?.path ?? ctx.worktree, branch))
      if (!currentCommit) {
        if (mutation) {
          return yield* new OwnershipFailedError({ message: "Removal reservation lost its immutable branch commit" })
        }
        return yield* new RemoveFailedError({ message: "Cannot resolve the immutable worktree branch commit" })
      }
      return {
        directory,
        worktreePath: entry?.path ?? owner.directory,
        branch,
        branchCommit: currentCommit,
        requestID,
        owner,
        mutationReservationPath: removeReservationPath,
        roots,
      } satisfies PreparedRemove
    })

    const removePrepared = Effect.fn("Worktree.removePrepared")(function* (input: PreparedRemove, actionID: string) {
      const ctx = yield* InstanceState.context
      yield* ensureManagedTarget(input.roots, ctx.project.id, input.directory, {
        createParents: false,
        requireTarget: false,
      })
      let targetIdentity: DirectoryAnchor | undefined
      const verifyTarget = () =>
        Effect.gen(function* () {
          const current = yield* ensureManagedTarget(input.roots, ctx.project.id, input.directory, {
            createParents: false,
            requireTarget: true,
          })
          if (!targetIdentity || !current.identity || !sameDirectory(current.identity, targetIdentity))
            return yield* new OwnershipFailedError({ message: "Worktree target identity changed after approval" })
        })
      if (yield* fs.existsSafe(input.directory)) {
        const current = yield* ensureManagedTarget(input.roots, ctx.project.id, input.directory, {
          createParents: false,
          requireTarget: true,
        })
        targetIdentity = current.identity
        if (!targetIdentity) return yield* new OwnershipFailedError({ message: "Worktree target identity is missing" })
      }
      const verifyRemoveEnvironment = () =>
        targetIdentity ? verifyTarget() : assertRoots(input.roots, ctx.project.id).pipe(Effect.asVoid)
      if ((yield* canonical(ctx.project.worktree)) === input.directory)
        return yield* new RemoveFailedError({ message: "Cannot remove the primary workspace" })
      if ((yield* canonical(input.worktreePath)) !== input.directory)
        return yield* new RemoveFailedError({
          message: "Worktree target changed after approval; request a new confirmation",
        })
      const currentOwner = yield* readOwnership(yield* reservationPath(ctx.project.id, input.directory))
      if (
        !currentOwner ||
        currentOwner.projectID !== input.owner.projectID ||
        currentOwner.requestID !== input.owner.requestID ||
        currentOwner.actionID !== input.owner.actionID ||
        currentOwner.directory !== input.owner.directory ||
        currentOwner.branch !== input.owner.branch ||
        currentOwner.sourceCommit !== input.owner.sourceCommit
      ) {
        return yield* new OwnershipFailedError({ message: "Worktree ownership changed after approval" })
      }
      const existingMutation = yield* readMutation(input.mutationReservationPath)
      const ownerPath = yield* reservationPath(ctx.project.id, input.directory)
      if (input.mutationReservationPath !== mutationReservationPath(ownerPath, "remove", input.requestID))
        return yield* new OwnershipFailedError({ message: "Worktree removal reservation is not bound to this target" })
      const listed = yield* guardedSideEffect(
        "remove.git-worktree-list",
        verifyRemoveEnvironment,
        git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree }),
      )
      if (listed.code !== 0)
        return yield* new RemoveFailedError({ message: listed.stderr || listed.text || "Failed to read git worktrees" })
      const entry = yield* locateWorktree(parseWorktreeList(listed.text), input.directory)
      const branch = entry?.branch?.replace(/^refs\/heads\//, "")
      if (entry?.path && branch !== input.branch)
        return yield* new RemoveFailedError({
          message: "Worktree target changed after approval; request a new confirmation",
        })

      if (!existingMutation) {
        if (!entry?.path || !(yield* ownsSandbox(ctx.project.id, input.directory))) {
          return yield* new OwnershipFailedError({
            message: "Worktree is no longer the approved active sandbox; removal did not start",
          })
        }
        const currentCommit = yield* resolveCommitGuarded("remove.git-current-head", entry.path, "HEAD", verifyTarget)
        if (!currentCommit || currentCommit !== input.branchCommit) {
          return yield* new RemoveFailedError({
            message: "Worktree commit changed after approval; request a new confirmation",
          })
        }
      }
      if (entry?.path && !targetIdentity)
        return yield* new OwnershipFailedError({ message: "Registered worktree target disappeared after approval" })
      yield* reserveMutation(
        input.mutationReservationPath,
        {
          version: 1,
          kind: "remove",
          projectID: ctx.project.id,
          requestID: input.requestID,
          actionID,
          directory: input.directory,
          sourceCommit: input.owner.sourceCommit,
          currentCommit: input.branchCommit ?? input.owner.sourceCommit,
        },
        input.roots,
        ctx.project.id,
      )

      let removedThisAttempt = false
      if (entry?.path) {
        if (!(yield* ownsSandbox(ctx.project.id, input.directory))) {
          return yield* new OwnershipFailedError({ message: "Worktree is no longer an active project sandbox" })
        }
        yield* store.disposeDirectory(entry.path)
        yield* stopFsmonitor(entry.path, verifyTarget, "remove.git-fsmonitor-stop")
        const removed = yield* guardedSideEffect(
          "remove.git-worktree-remove",
          verifyTarget,
          git(["worktree", "remove", "--force", entry.path], { cwd: ctx.worktree }),
        )
        if (removed.code !== 0) {
          const next = yield* guardedSideEffect(
            "remove.git-worktree-list-after-remove",
            () => assertRoots(input.roots, ctx.project.id).pipe(Effect.asVoid),
            git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree }),
          )
          if (next.code !== 0 || (yield* locateWorktree(parseWorktreeList(next.text), input.directory))?.path) {
            return yield* new RemoveFailedError({
              message: removed.stderr || removed.text || next.stderr || next.text || "Failed to remove git worktree",
            })
          }
        }
        removedThisAttempt = true
      }

      if (removedThisAttempt && targetIdentity) {
        yield* cleanPreparedDirectory(input.directory, targetIdentity, verifyTarget)
      } else if (yield* fs.existsSafe(input.directory)) {
        return yield* new RemoveFailedError({
          message: "An unregistered path appeared at the removed worktree location; recursive deletion is blocked",
        })
      }

      yield* guardedSideEffect(
        "remove.project-registry-remove",
        () => assertRoots(input.roots, ctx.project.id).pipe(Effect.asVoid),
        project.removeSandbox(ctx.project.id, input.directory),
      )

      if (input.branch) {
        const verifyRemovedRoots = () => assertRoots(input.roots, ctx.project.id).pipe(Effect.asVoid)
        const commit = yield* resolveCommitGuarded(
          "remove.git-branch-resolve",
          ctx.worktree,
          input.branch,
          verifyRemovedRoots,
        )
        if (commit) {
          if (commit !== input.branchCommit) {
            return yield* new RemoveFailedError({
              message: "Worktree branch commit changed after approval; branch deletion is blocked",
            })
          }
          const deleted = yield* guardedSideEffect(
            "remove.git-branch-delete",
            verifyRemovedRoots,
            git(["branch", "-D", "--", input.branch], { cwd: ctx.worktree }),
          )
          if (deleted.code !== 0)
            return yield* new RemoveFailedError({
              message: deleted.stderr || deleted.text || "Failed to delete worktree branch",
            })
        }
      }
      return true
    })

    const gitExpect = Effect.fnUntraced(function* (
      point: SafetySideEffect,
      args: string[],
      opts: { cwd: string },
      error: (r: GitResult) => Error,
      beforeSideEffect?: () => Effect.Effect<void, Error>,
    ) {
      const result = yield* guardedSideEffect(point, beforeSideEffect ?? (() => Effect.void), git(args, opts))
      if (result.code !== 0) return yield* error(result)
      return result
    })

    const runStartCommand = Effect.fnUntraced(
      function* (directory: string, cmd: string) {
        const [shell, args] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["bash", ["-lc", cmd]]
        const result = yield* appProcess.run(
          ChildProcess.make(shell, args as string[], {
            cwd: directory,
            env: childEnvironment,
            extendEnv: false,
            stdin: "ignore",
          }),
        )
        return { code: result.exitCode, stderr: result.stderr.toString("utf8") }
      },
      Effect.catch(() => Effect.succeed({ code: 1, stderr: "" })),
    )

    const runStartScript = Effect.fnUntraced(function* (directory: string, cmd: string, kind: string) {
      const text = cmd.trim()
      if (!text) return true
      const result = yield* runStartCommand(directory, text)
      if (result.code === 0) return true
      yield* Effect.logError("worktree start command failed", { kind, directory, message: result.stderr })
      return false
    })

    const runStartScripts = Effect.fnUntraced(function* (directory: string, input: StartScripts) {
      const ok = yield* runStartScript(directory, input.project, "project")
      if (!ok) return false
      return yield* runStartScript(directory, input.extra, "worktree")
    })

    const prune = Effect.fnUntraced(function* (
      root: string,
      entries: string[],
      rootIdentity: DirectoryAnchor,
      beforeSideEffect?: () => Effect.Effect<void, Error>,
    ) {
      const base = lexicalPath(root)
      yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const target = lexicalPath(pathSvc.resolve(root, entry))
            if (target === base) return
            if (!isWithinPath(base, target)) return
            yield* guardedSideEffect(
              "reset.fs-prune",
              beforeSideEffect ?? (() => Effect.void),
              Effect.gen(function* () {
                const captured = yield* verifyPruneTarget(rootIdentity, target)
                if (!captured) return
                // Re-run the complete no-follow chain at the removal boundary;
                // the captured inode prevents a target swap between checks.
                const verified = yield* verifyPruneTarget(rootIdentity, target, captured)
                if (!verified) return
                yield* fs.remove(target, { recursive: true }).pipe(Effect.ignore)
              }),
            )
          }),
        { concurrency: 1 },
      )
    })

    const sweep = Effect.fnUntraced(function* (
      root: string,
      beforeSideEffect?: () => Effect.Effect<void, Error>,
      preparedRootIdentity?: DirectoryAnchor,
    ) {
      const guard = beforeSideEffect ?? (() => Effect.void)
      const rootIdentity = preparedRootIdentity ?? (yield* captureDirectoryAnchor(root, "reset prune worktree root"))
      const first = yield* guardedSideEffect("reset.git-clean", guard, git(["clean", "-ffdx"], { cwd: root }))
      if (first.code === 0) return first

      const entries = failedRemoves(first.stderr, first.text)
      if (!entries.length) return first

      yield* prune(root, entries, rootIdentity, beforeSideEffect)
      return yield* guardedSideEffect("reset.git-clean-retry", guard, git(["clean", "-ffdx"], { cwd: root }))
    })

    const resetPreparedInternal = Effect.fnUntraced(function* (
      input: PreparedReset,
      controlPlane: boolean,
      actionID?: string,
    ) {
      const ctx = yield* InstanceState.context
      if (controlPlane) {
        const blocked = requireNoControlPlaneStartScripts(input.start)
        if (blocked) return yield* blocked
      }
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }

      const directory = input.directory
      const primary = yield* canonical(ctx.project.worktree)
      if (directory === primary) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }

      if ((yield* canonical(input.worktreePath)) !== directory)
        return yield* new ResetFailedError({
          message: "Worktree target changed after approval; request a new confirmation",
        })

      let targetIdentity: DirectoryAnchor | undefined
      const verifyResetTarget = () =>
        Effect.gen(function* () {
          const current = yield* ensureManagedTarget(input.roots, ctx.project.id, directory, {
            createParents: false,
            requireTarget: true,
          })
          if (!targetIdentity || !current.identity || !sameDirectory(current.identity, targetIdentity))
            return yield* new OwnershipFailedError({ message: "Worktree target identity changed after approval" })
        })
      if (controlPlane) {
        const verified = yield* ensureManagedTarget(input.roots, ctx.project.id, directory, {
          createParents: false,
          requireTarget: true,
        })
        targetIdentity = verified.identity
        if (!targetIdentity) return yield* new OwnershipFailedError({ message: "Worktree target identity is missing" })
      }

      const list = controlPlane
        ? yield* guardedSideEffect(
            "reset.git-worktree-list",
            verifyResetTarget,
            git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree }),
          )
        : yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (list.code !== 0) {
        return yield* new ResetFailedError({ message: list.stderr || list.text || "Failed to read git worktrees" })
      }

      const entry = yield* locateWorktree(parseWorktreeList(list.text), directory)
      if (!entry?.path) {
        return yield* new ResetFailedError({ message: "Worktree not found" })
      }

      const worktreePath = entry.path
      if ((yield* canonical(worktreePath)) !== directory)
        return yield* new ResetFailedError({
          message: "Worktree target changed after approval; request a new confirmation",
        })

      const base = input.base
      if (controlPlane) {
        if (!actionID) return yield* new OwnershipFailedError({ message: "Reset action identity is missing" })
        const owner = yield* readOwnership(yield* reservationPath(ctx.project.id, directory))
        if (
          !owner ||
          owner.projectID !== input.owner.projectID ||
          owner.requestID !== input.owner.requestID ||
          owner.actionID !== input.owner.actionID ||
          owner.directory !== input.owner.directory ||
          owner.branch !== input.owner.branch ||
          owner.sourceCommit !== input.owner.sourceCommit
        ) {
          return yield* new OwnershipFailedError({ message: "Worktree ownership changed after approval" })
        }
        if (!(yield* ownsSandbox(ctx.project.id, directory))) {
          return yield* new OwnershipFailedError({ message: "Worktree is no longer an active project sandbox" })
        }
        const branch = entry.branch?.replace(/^refs\/heads\//, "")
        if (branch !== owner.branch) {
          return yield* new OwnershipFailedError({ message: "Worktree branch no longer matches its owner" })
        }
        const existingMutation = yield* readMutation(input.mutationReservationPath)
        const ownerPath = yield* reservationPath(ctx.project.id, directory)
        if (input.mutationReservationPath !== mutationReservationPath(ownerPath, "reset", input.requestID))
          return yield* new OwnershipFailedError({ message: "Worktree reset reservation is not bound to this target" })
        const currentCommit = yield* resolveCommitGuarded(
          "reset.git-current-head",
          worktreePath,
          "HEAD",
          verifyResetTarget,
        )
        if (!currentCommit) return yield* new ResetFailedError({ message: "Cannot resolve the worktree commit" })
        if (existingMutation) {
          if (currentCommit !== input.currentCommit && currentCommit !== base.commit) {
            return yield* new ResetFailedError({
              message: "Worktree commit changed during recovery; reset is blocked",
            })
          }
        } else if (currentCommit !== input.currentCommit) {
          return yield* new ResetFailedError({
            message: "Worktree commit changed after approval; request a new confirmation",
          })
        }
        yield* reserveMutation(
          input.mutationReservationPath,
          {
            version: 1,
            kind: "reset",
            projectID: ctx.project.id,
            requestID: input.requestID,
            actionID,
            directory,
            sourceCommit: base.commit,
            currentCommit: input.currentCommit,
            baseRef: base.ref,
            baseName: base.name,
          },
          input.roots,
          ctx.project.id,
        )
      }

      const availableBase = controlPlane
        ? yield* resolveCommitGuarded("reset.git-base-verify", ctx.project.worktree, base.commit, verifyResetTarget)
        : yield* resolveCommit(ctx.project.worktree, base.commit)
      if (!availableBase) {
        return yield* new ResetFailedError({ message: "The approved reset commit is no longer available" })
      }

      // Instance disposal belongs inside the authorized action. The desktop
      // performs only post-success UI cleanup.
      if (controlPlane) yield* verifyResetTarget()
      yield* store.disposeDirectory(worktreePath)

      yield* gitExpect(
        "reset.git-reset-hard",
        ["reset", "--hard", base.commit],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset worktree to target" }),
        controlPlane ? verifyResetTarget : undefined,
      )

      const cleanResult = yield* sweep(
        worktreePath,
        controlPlane ? verifyResetTarget : undefined,
        controlPlane ? targetIdentity : undefined,
      )
      if (cleanResult.code !== 0) {
        return yield* new ResetFailedError({
          message: cleanResult.stderr || cleanResult.text || "Failed to clean worktree",
        })
      }

      yield* gitExpect(
        "reset.git-submodule-update",
        ["submodule", "update", "--init", "--recursive", "--force"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to update submodules" }),
        controlPlane ? verifyResetTarget : undefined,
      )

      yield* gitExpect(
        "reset.git-submodule-reset",
        ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to reset submodules" }),
        controlPlane ? verifyResetTarget : undefined,
      )

      yield* gitExpect(
        "reset.git-submodule-clean",
        ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"],
        { cwd: worktreePath },
        (r) => new ResetFailedError({ message: r.stderr || r.text || "Failed to clean submodules" }),
        controlPlane ? verifyResetTarget : undefined,
      )

      const status = controlPlane
        ? yield* guardedSideEffect(
            "reset.git-status",
            verifyResetTarget,
            git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath }),
          )
        : yield* git(["-c", "core.fsmonitor=false", "status", "--porcelain=v1"], { cwd: worktreePath })
      if (status.code !== 0) {
        return yield* new ResetFailedError({ message: status.stderr || status.text || "Failed to read git status" })
      }

      if (status.text.trim()) {
        return yield* new ResetFailedError({ message: `Worktree reset left local changes:\n${status.text.trim()}` })
      }

      const settledCommit = controlPlane
        ? yield* resolveCommitGuarded("reset.git-head-verify", worktreePath, "HEAD", verifyResetTarget)
        : yield* resolveCommit(worktreePath, "HEAD")
      if (settledCommit !== base.commit) {
        return yield* new ResetFailedError({ message: "Worktree did not settle on the approved immutable commit" })
      }

      return true
    })

    const prepareResetInternal = Effect.fnUntraced(function* (
      input: ResetInput,
      controlPlane: boolean,
      requestID = "legacy",
    ) {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new NotGitError({ message: "Worktrees are only supported for git projects" })
      }
      const directory = yield* canonical(input.directory)
      const roots = yield* rootsFor(ctx.project.id)
      if (directory === (yield* canonical(ctx.worktree))) {
        return yield* new ResetFailedError({ message: "Cannot reset the primary workspace" })
      }
      const listed = yield* git(["worktree", "list", "--porcelain"], { cwd: ctx.worktree })
      if (listed.code !== 0)
        return yield* new ResetFailedError({ message: listed.stderr || listed.text || "Failed to read git worktrees" })
      const entry = yield* locateWorktree(parseWorktreeList(listed.text), directory)
      if (!entry?.path) return yield* new ResetFailedError({ message: "Worktree not found" })
      if (controlPlane)
        yield* ensureManagedTarget(roots, ctx.project.id, directory, { createParents: false, requireTarget: true })
      const start = yield* prepareStartScripts(ctx.project.id)
      if (controlPlane) {
        const blocked = requireNoControlPlaneStartScripts(start)
        if (blocked) return yield* blocked
      }
      const branch = entry.branch?.replace(/^refs\/heads\//, "")
      const currentCommit = yield* resolveCommit(entry.path, "HEAD")
      if (!currentCommit) return yield* new ResetFailedError({ message: "Cannot resolve the worktree commit" })
      const ownerPath = yield* reservationPath(ctx.project.id, directory)
      const owner = controlPlane
        ? yield* readOwnership(ownerPath)
        : ({
            version: 1,
            projectID: ctx.project.id,
            requestID,
            actionID: "legacy",
            directory,
            branch: branch ?? "detached",
            sourceCommit: currentCommit,
          } satisfies OwnershipReservation)
      if (
        !owner ||
        owner.projectID !== ctx.project.id ||
        owner.directory !== directory ||
        owner.branch !== (branch ?? "detached")
      ) {
        return yield* new OwnershipFailedError({
          message:
            "This legacy or externally created worktree has no control-plane ownership reservation. Reset is blocked; create a managed worktree or use a future explicit L3 claim flow.",
        })
      }
      if (controlPlane && !(yield* ownsSandbox(ctx.project.id, directory))) {
        return yield* new OwnershipFailedError({ message: "Worktree is not an active sandbox of this project" })
      }
      const resetReservationPath = mutationReservationPath(ownerPath, "reset", requestID)
      const mutation = controlPlane ? yield* readMutation(resetReservationPath) : undefined
      if (
        mutation &&
        (mutation.kind !== "reset" ||
          mutation.projectID !== ctx.project.id ||
          mutation.requestID !== requestID ||
          mutation.directory !== directory ||
          !mutation.baseRef ||
          !mutation.baseName)
      ) {
        return yield* new OwnershipFailedError({ message: "Worktree reset reservation does not match this action" })
      }
      const discoveredBase = mutation
        ? undefined
        : controlPlane
          ? yield* safeDefaultBranch(ctx.project.worktree)
          : yield* gitSvc.defaultBranch(ctx.project.worktree)
      if (!mutation && !discoveredBase) return yield* new ResetFailedError({ message: "Default branch not found" })
      const baseRef = mutation?.baseRef ?? discoveredBase!.ref
      const baseName = mutation?.baseName ?? discoveredBase!.name
      const baseCommit = mutation?.sourceCommit ?? (yield* resolveCommit(ctx.project.worktree, baseRef))
      if (!baseCommit) return yield* new ResetFailedError({ message: "Cannot resolve the immutable reset commit" })
      return {
        directory,
        worktreePath: entry.path,
        start,
        requestID,
        owner,
        mutationReservationPath: resetReservationPath,
        currentCommit: mutation?.currentCommit ?? currentCommit,
        base: { name: baseName, ref: baseRef, commit: baseCommit },
        roots,
      } satisfies PreparedReset
    })

    const prepareReset = Effect.fn("Worktree.prepareReset")(function* (input: ResetInput, requestID: string) {
      return yield* prepareResetInternal(input, true, requestID)
    })

    const resetPrepared = Effect.fn("Worktree.resetPrepared")(function* (input: PreparedReset, actionID: string) {
      return yield* resetPreparedInternal(input, true, actionID)
    })

    const executeSealedControl = Effect.fn("Worktree.executeSealedControl")(function* (input: {
      readonly snapshot: WorktreeSnapshot.Snapshot
      readonly runID: AgentRuntime.RunID
      readonly actionID: AgentRuntime.ActionID
      readonly controlLease: DurableRun.RunLeaseCapability
      readonly authorization: ActionGateway.AuthorizationGrantCapability
      readonly controlLeaseValidated: () => Effect.Effect<void>
      readonly durable: DurableRun.Interface
    }) {
      const owned = yield* input.durable.validateControlLease(input.controlLease).pipe(
        Effect.mapError(
          () =>
            new ControlExecutionDeniedError({
              message: "The control worker no longer owns the durable run lease.",
            }),
        ),
      )
      if (owned.run.id !== input.runID || owned.run.status !== "running")
        return yield* new ControlExecutionDeniedError({
          message: "The durable control run is not in an owned running state.",
        })

      const ctx = yield* InstanceState.context
      const roots = yield* rootsFor(ctx.project.id)
      let decoded: ReturnType<typeof WorktreeSnapshot.decode>
      try {
        decoded = WorktreeSnapshot.decode(input.snapshot, {
          projectID: ctx.project.id,
          projectRoot: lexicalPath(ctx.project.worktree),
          location: lexicalPath(ctx.directory),
          ...roots,
        })
      } catch (cause) {
        return yield* new ControlExecutionDeniedError({
          message: cause instanceof globalThis.Error ? cause.message : "The sealed worktree snapshot is invalid.",
        })
      }
      const material = WorktreeSnapshot.actionMaterial(decoded.snapshot)
      const expectedActionID = ActionGateway.stableControlPlaneActionID({
        subject: owned.run.subject,
        name: material.name,
        resources: material.resources,
        inputDigest: material.inputDigest,
        policyVersion: ActionGateway.POLICY_VERSION,
      })
      const gateway: ActionGateway.Input = {
        kind: "control-plane",
        controlPlane: owned.run.subject,
        runID: owned.run.id,
        runLease: input.controlLease,
        actionID: input.actionID,
        name: material.name,
        resources: material.resources,
        semantics: material.semantics,
        reasonSummary: material.reasonSummary,
        initiator: owned.run.initiator,
        traceID: owned.run.traceID,
        inputDigest: material.inputDigest,
      }
      const authorization = WorktreeSnapshot.authorizationPlan(decoded.snapshot, input.actionID)
      const scope = canonicalHash(WorktreeSnapshot.authorizationPlan(decoded.snapshot, input.actionID)?.requests)
      let grant: AgentRuntime.AuthorizationGrant | undefined
      try {
        grant = ActionGateway.capabilityGrant(input.authorization)
        if (!grant || grant.subject?.type !== "control-plane")
          return yield* new ControlExecutionDeniedError({
            message: "The authorization grant does not carry a control-plane subject.",
          })
        if (
          ActionGateway.capabilityAuthority(input.authorization) !== "human" ||
          grant.actionID !== input.actionID ||
          grant.runID !== input.runID ||
          grant.subject.id !== owned.run.subject.id ||
          canonicalHash(ActionGateway.capabilityRequests(input.authorization)) !== scope
        )
          return yield* new ControlExecutionDeniedError({
            message: "The authorization grant does not match the sealed worktree operation.",
          })
      } catch {
        return yield* new ControlExecutionDeniedError({ message: "The authorization grant capability is invalid." })
      }
      if (
        owned.run.operation.kind !== material.name ||
        owned.run.operation.actionID !== input.actionID ||
        input.actionID !== expectedActionID ||
        owned.run.operation.inputDigest !== material.inputDigest ||
        owned.run.operation.payloadDigest !== canonicalHash(decoded.snapshot) ||
        !canonicalHash(owned.run.operation.payload) ||
        canonicalHash(owned.run.operation.payload) !== canonicalHash(decoded.snapshot) ||
        owned.run.operation.authorizationDigest !== ActionGateway.intentDigestOf(gateway, authorization)
      )
        return yield* new ControlExecutionDeniedError({
          message: "The durable operation does not exactly match the sealed worktree snapshot.",
        })

      // This is the one-way lease handoff boundary. Every capability, sealed
      // snapshot, grant, and durable identity check above has completed, and
      // no code below reads controlLease again. The worker may now rotate the
      // opaque capability while heartbeating through the side effect and all
      // interrupt cleanup.
      yield* input.controlLeaseValidated()

      if (decoded.prepared.kind === "create") {
        yield* createPrepared(decoded.prepared.value, input.actionID)
        return
      }
      if (decoded.prepared.kind === "remove") {
        yield* removePrepared(decoded.prepared.value, input.actionID)
        return
      }
      yield* resetPrepared(decoded.prepared.value, input.actionID)
    })

    const reset = Effect.fn("Worktree.reset")(function* (input: ResetInput) {
      const prepared = yield* prepareResetInternal(input, false)
      yield* resetPreparedInternal(prepared, false)
      yield* runStartScripts(prepared.worktreePath, prepared.start).pipe(
        Effect.catchCause((cause) => Effect.logError("worktree start task failed", { cause })),
        Effect.forkIn(scope),
      )
      return true
    })

    return Service.of({
      makeWorktreeInfo,
      createFromInfo,
      create,
      prepareCreate,
      createPrepared,
      list,
      remove,
      prepareRemove,
      removePrepared,
      reset,
      prepareReset,
      resetPrepared,
      controlScope,
      executeSealedControl,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, path, AppProcess.node, Git.node, Project.node, InstanceStore.node, Database.node],
})

export * as Worktree from "."
