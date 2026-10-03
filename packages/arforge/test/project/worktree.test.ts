import { afterEach, describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let activeSafetyHook: Worktree.SafetyTestHookInterface | undefined
const safetyHooks = Layer.succeed(
  Worktree.SafetyTestHooks,
  Worktree.SafetyTestHooks.of({
    beforeGuard: (point) => Effect.suspend(() => activeSafetyHook?.beforeGuard?.(point) ?? Effect.void),
    afterSideEffect: (point) => Effect.suspend(() => activeSafetyHook?.afterSideEffect?.(point) ?? Effect.void),
  }),
)

const it = testEffect(
  Layer.provideMerge(
    LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node]), [
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    ]),
    safetyHooks,
  ),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip
const windowsOnly = process.platform === "win32" ? it.instance : it.instance.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }

  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    const ok = yield* svc.remove({ directory })
    if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${directory}`))
  })

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: { info: Worktree.Info; ready: { name: string; branch?: string } }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create(input)
      const props = yield* Fiber.join(ready)
      return { info, ready: props }
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  )

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

const directoryLink = (link: string, target: string) =>
  Effect.tryPromise({
    try: () => fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir"),
    catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
  })

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo()

          expect(info.name).toBeDefined()
          expect(typeof info.name).toBe("string")
          expect(info.branch).toBe(`arforge/${info.name}`)
          expect(info.directory).toContain(info.name)
        }),
      { git: true },
    )

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBe("arforge/my-feature")
        }),
      { git: true },
    )

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

          expect(info.name).toBe("my-feature-branch")
        }),
      { git: true },
    )

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* git(test.directory, ["branch", "arforge/my-feature"])

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBeUndefined()
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.makeWorktreeInfo())

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = normalize(list)
          const normalizedDir = normalize(info.directory)
          expect(normalizedList).toContain(normalizedDir)

          const branch = yield* gitResult(info.directory, ["symbolic-ref", "-q", "--short", "HEAD"])
          expect(branch.exitCode).not.toBe(0)

          const props = yield* Fiber.join(ready)
          expect(props.name).toBe(info.name)
          expect(props.branch).toBeUndefined()

          yield* svc.remove({ directory: info.directory })
        }),
      { git: true },
    )
  })

  describe("create + remove lifecycle", () => {
    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("arforge/")
            expect(info.directory).toBeDefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("arforge/")

            expect(ready.name).toBe(info.name)
            expect(ready.branch).toBe(info.branch)

            const list = yield* svc.list()
            expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))
          }),
        ),
      { git: true },
    )

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const list = yield* svc.list().pipe(provideInstance(info.directory))

            expect(list.map((item) => item.name)).toContain(info.name)
            expect(list.map((item) => item.name)).not.toContain(path.basename(test.directory).toLowerCase())
          }),
        ),
      { git: true },
    )

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("arforge/test-workspace")
          }),
        ),
      { git: true },
    )

    windowsOnly(
      "control-plane create blocks a junction inserted after preflight",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const name = `junction-${Date.now().toString(36)}`
          const prepared = yield* svc.prepareCreate({ name }, "cpr_junction_00000001")
          const outside = path.join(test.directory, `${name}-outside`)
          yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(outside, "sentinel.txt"), "must-survive"))
          yield* Effect.promise(() => fs.mkdir(path.dirname(prepared.info.directory), { recursive: true }))
          yield* directoryLink(prepared.info.directory, outside)
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => fs.rm(prepared.info.directory, { recursive: true, force: true })),
          )

          const exit = yield* Effect.exit(svc.createPrepared(prepared, "act_junction_00000001"))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "sentinel.txt"), "utf8"))).toBe(
            "must-survive",
          )
          const listed = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          expect(normalize(listed)).not.toContain(normalize(prepared.info.directory))
        }),
      { git: true },
    )

    it.instance(
      "control-plane create blocks a linked managed-root parent chain",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const prepared = yield* svc.prepareCreate(
            { name: `parent-link-${Date.now().toString(36)}` },
            "cpr_parent_link_000001",
          )
          const controlledRoot = prepared.roots.managedWorktreeRoot
          const outside = path.join(test.directory, "outside-managed-root")
          yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(outside, "sentinel.txt"), "must-survive"))
          yield* Effect.promise(() => fs.mkdir(path.dirname(controlledRoot), { recursive: true }))
          yield* directoryLink(controlledRoot, outside)
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => fs.rm(controlledRoot, { recursive: true, force: true })),
          )

          const exit = yield* Effect.exit(svc.createPrepared(prepared, "act_parent_link_000001"))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "sentinel.txt"), "utf8"))).toBe(
            "must-survive",
          )
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(prepared.info.directory)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }),
      { git: true },
    )

    it.instance(
      "control-plane create blocks reservation-root identity replacement",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const requestID = "cpr_reservation_identity_01"
          const discovered = yield* svc.prepareCreate({ name: "reservation-identity" }, requestID)
          const reservationRoot = discovered.roots.reservationRoot
          yield* Effect.promise(() => fs.mkdir(reservationRoot, { recursive: true }))
          const prepared = yield* svc.prepareCreate({ name: "reservation-identity" }, requestID)
          const approvedRoot = `${reservationRoot}.approved`
          yield* Effect.promise(() => fs.rename(reservationRoot, approvedRoot))
          yield* Effect.promise(() => fs.mkdir(reservationRoot))
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await fs.rm(reservationRoot, { recursive: true, force: true })
              await fs.rename(approvedRoot, reservationRoot).catch(() => undefined)
            }),
          )

          const exit = yield* Effect.exit(svc.createPrepared(prepared, "act_reservation_identity_01"))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(
            yield* Effect.promise(() =>
              fs
                .stat(prepared.reservationPath)
                .then(() => true)
                .catch(() => false),
            ),
          ).toBe(false)
        }),
      { git: true },
    )
  })

  describe("control-plane race guards", () => {
    it.instance(
      "remove never recursively deletes a replacement inserted after Git removal",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const name = `remove-race-${Date.now().toString(36)}`
          const created = yield* svc.prepareCreate({ name }, "cpr_remove_race_create_01")
          const info = yield* svc.createPrepared(created, "act_remove_race_create_01")
          const prepared = yield* svc.prepareRemove({ directory: info.directory }, "cpr_remove_race_execute_01")
          const outside = path.join(test.directory, `${name}-outside`)
          yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(outside, "sentinel.txt"), "must-survive"))
          const completed: Worktree.SafetySideEffect[] = []
          let injected = false
          activeSafetyHook = {
            beforeGuard: (point) =>
              point === "remove.fs-recursive-clean" && !injected
                ? Effect.promise(async () => {
                    injected = true
                    await fs.symlink(outside, info.directory, process.platform === "win32" ? "junction" : "dir")
                  })
                : Effect.void,
            afterSideEffect: (point) => Effect.sync(() => completed.push(point)),
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              activeSafetyHook = undefined
            }),
          )

          const exit = yield* Effect.exit(svc.removePrepared(prepared, "act_remove_race_execute_01"))
          activeSafetyHook = undefined
          expect(Exit.isFailure(exit)).toBe(true)
          expect(injected).toBe(true)
          expect(completed).toContain("remove.git-worktree-remove")
          expect(completed).not.toContain("remove.fs-recursive-clean")
          expect(completed).not.toContain("remove.project-registry-remove")
          expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "sentinel.txt"), "utf8"))).toBe(
            "must-survive",
          )

          yield* Effect.promise(() => fs.rm(info.directory, { recursive: true, force: true }))
          yield* gitResult(test.directory, ["worktree", "prune"])
          if (info.branch) yield* gitResult(test.directory, ["branch", "-D", "--", info.branch])
          yield* Effect.promise(() => fs.rm(prepared.roots.reservationRoot, { recursive: true, force: true }))
        }),
      { git: true },
      15_000,
    )

    it.instance(
      "reset stops all later Git effects when the target changes between stages",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const name = `reset-race-${Date.now().toString(36)}`
          const created = yield* svc.prepareCreate({ name }, "cpr_reset_race_create_001")
          const info = yield* svc.createPrepared(created, "act_reset_race_create_001")
          yield* Effect.promise(() => Bun.write(path.join(info.directory, "untracked.txt"), "remove during clean"))
          const prepared = yield* svc.prepareReset({ directory: info.directory }, "cpr_reset_race_execute_01")
          const parked = `${info.directory}.approved`
          const outside = path.join(test.directory, `${name}-outside`)
          yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(outside, "sentinel.txt"), "must-survive"))
          const completed: Worktree.SafetySideEffect[] = []
          let injected = false
          activeSafetyHook = {
            beforeGuard: (point) =>
              point === "reset.git-clean" && !injected
                ? Effect.promise(async () => {
                    injected = true
                    await fs.rename(info.directory, parked)
                    await fs.symlink(outside, info.directory, process.platform === "win32" ? "junction" : "dir")
                  })
                : Effect.void,
            afterSideEffect: (point) => Effect.sync(() => completed.push(point)),
          }
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              activeSafetyHook = undefined
              await fs.rm(info.directory, { recursive: true, force: true }).catch(() => undefined)
              await fs.rename(parked, info.directory).catch(() => undefined)
            }),
          )

          const exit = yield* Effect.exit(svc.resetPrepared(prepared, "act_reset_race_execute_01"))
          activeSafetyHook = undefined
          expect(Exit.isFailure(exit)).toBe(true)
          expect(injected).toBe(true)
          expect(completed).toContain("reset.git-reset-hard")
          expect(completed).not.toContain("reset.git-clean")
          expect(completed).not.toContain("reset.git-submodule-update")
          expect(completed).not.toContain("reset.git-status")
          expect(yield* Effect.promise(() => fs.readFile(path.join(outside, "sentinel.txt"), "utf8"))).toBe(
            "must-survive",
          )

          yield* Effect.promise(async () => {
            await fs.rm(info.directory, { recursive: true, force: true })
            await fs.rename(parked, info.directory)
          })
          yield* svc.remove({ directory: info.directory })
          yield* Effect.promise(() => fs.rm(prepared.roots.reservationRoot, { recursive: true, force: true }))
        }),
      { git: true },
      15_000,
    )

    windowsOnly(
      "reset prune rejects an internal parent replaced by an outside junction",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const name = `reset-prune-race-${Date.now().toString(36)}`
          const created = yield* svc.prepareCreate({ name }, "cpr_reset_prune_create_01")
          const info = yield* svc.createPrepared(created, "act_reset_prune_create_01")
          const prepared = yield* svc.prepareReset({ directory: info.directory }, "cpr_reset_prune_execute_01")
          const parent = path.join(info.directory, "prune-parent")
          const locked = path.join(parent, "locked")
          const parked = `${parent}.approved`
          const outside = path.join(test.directory, `${name}-outside`)
          const outsideTarget = path.join(outside, "locked")
          yield* Effect.promise(() => fs.mkdir(locked, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(locked, "untracked.txt"), "git-clean-target"))
          yield* Effect.promise(() => fs.mkdir(outsideTarget, { recursive: true }))
          yield* Effect.promise(() => Bun.write(path.join(outsideTarget, "sentinel.txt"), "must-survive"))

          const locker = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
            cwd: locked,
            stdout: "pipe",
            stderr: "pipe",
          })
          const reader = locker.stdout.getReader()
          const ready = yield* Effect.promise(() => reader.read())
          reader.releaseLock()
          expect(new TextDecoder().decode(ready.value)).toContain("ready")

          const completed: Worktree.SafetySideEffect[] = []
          let injected = false
          let parkedParent = false
          let junctionInstalled = false
          activeSafetyHook = {
            beforeGuard: (point) =>
              point === "reset.fs-prune" && !injected
                ? Effect.promise(async () => {
                    injected = true
                    locker.kill()
                    await locker.exited
                    await fs.rename(parent, parked)
                    parkedParent = true
                    await fs.symlink(outside, parent, "junction")
                    junctionInstalled = true
                  })
                : Effect.void,
            afterSideEffect: (point) => Effect.sync(() => completed.push(point)),
          }
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              activeSafetyHook = undefined
              if (locker.exitCode === null) {
                locker.kill()
                await locker.exited
              }
              if (junctionInstalled) await fs.unlink(parent).catch(() => undefined)
              if (parkedParent) await fs.rename(parked, parent).catch(() => undefined)
            }),
          )

          const exit = yield* Effect.exit(svc.resetPrepared(prepared, "act_reset_prune_execute_01"))
          activeSafetyHook = undefined
          expect(Exit.isFailure(exit)).toBe(true)
          expect(injected).toBe(true)
          expect(completed).toContain("reset.git-clean")
          expect(completed).not.toContain("reset.fs-prune")
          expect(completed).not.toContain("reset.git-clean-retry")
          expect(yield* Effect.promise(() => fs.readFile(path.join(outsideTarget, "sentinel.txt"), "utf8"))).toBe(
            "must-survive",
          )

          if (junctionInstalled) {
            yield* Effect.promise(() => fs.unlink(parent))
            junctionInstalled = false
          }
          if (parkedParent) {
            yield* Effect.promise(() => fs.rename(parked, parent))
            parkedParent = false
          }
          yield* svc.remove({ directory: info.directory })
          yield* Effect.promise(() => fs.rm(prepared.roots.reservationRoot, { recursive: true, force: true }))
        }),
      { git: true },
      20_000,
    )
  })

  describe("createFromInfo", () => {
    wintest(
      "creates git worktree and boots asynchronously",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = list.replace(/\\/g, "/")
          const normalizedDir = info.directory.replace(/\\/g, "/")
          expect(normalizedList).toContain(normalizedDir)

          yield* Fiber.join(ready)
          yield* removeCreatedWorktree(info.directory)
        }),
      { git: true },
    )
  })

  describe("list", () => {
    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service
          const parent = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-parent`)
          const target = path.join(parent, path.basename(test.directory))
          const branch = `same-basename-list-${Date.now()}`

          yield* fs.ensureDir(parent)
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])

          const list = yield* svc.list()
          const directory = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))

          expect(list.map((item) => ({ ...item, directory: normalize(item.directory) }))).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          })

          yield* svc.remove({ directory: target })
        }),
      { git: true },
    )
  })

  describe("remove edge cases", () => {
    it.instance(
      "remove non-existent directory succeeds silently",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const ok = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") })
          expect(ok).toBe(true)
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.remove({ directory: path.join(test.directory, "fake") }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )
  })
})
