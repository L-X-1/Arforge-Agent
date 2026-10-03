import fs from "fs/promises"
import path from "path"
import os from "os"
import { createHash } from "node:crypto"
import { spawn } from "child_process"
import { describe, expect } from "bun:test"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function provide(directory: string, filesystemLayer = LayerNode.compile(FSUtil.node), rollbackRoot?: string) {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  const replacements: LayerNode.Replacements = [
    [Location.node, activeLocation],
    [FSUtil.node, filesystemLayer],
    ...(rollbackRoot === undefined ? [] : [[RollbackArtifact.node, RollbackArtifact.layerWith(rollbackRoot)] as const]),
  ]
  return Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([LocationMutation.node, FileMutation.node, RollbackArtifact.node]),
      replacements,
    ),
  )
}

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

type ProcessMutationResult =
  | { readonly kind: "success"; readonly result: unknown }
  | { readonly kind: "error"; readonly tag?: string; readonly message: string }

const processTestRoot = path.join(import.meta.dir, "..", "..")
const mutationWorker = path.join(import.meta.dir, "fixture", "file-mutation-worker.ts")
const flockWorker = path.join(import.meta.dir, "fixture", "effect-flock-worker.ts")

const runMutationWorker = (input: {
  readonly directory: string
  readonly target?: string
  readonly expected?: string
  readonly content: string
  readonly operation?: "write" | "fingerprint" | "move"
  readonly source?: string
  readonly destination?: string
  readonly expectedSource?: string
  readonly expectedDestination?: string
  readonly pauseAfterReadMs?: number
  readonly readMarker?: string
}) =>
  new Promise<ProcessMutationResult>((resolve, reject) => {
    const child = spawn(process.execPath, [mutationWorker, JSON.stringify(input)], {
      cwd: processTestRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FileMutation worker exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as ProcessMutationResult)
      } catch (error) {
        reject(new Error(`FileMutation worker returned invalid JSON: ${String(error)}`))
      }
    })
  })

const waitForFile = async (file: string, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fs.stat(file)
      return
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`Timed out waiting for ${file}`)
}

const spawnFlockWorker = (input: {
  readonly key: string
  readonly dir: string
  readonly active: string
  readonly holdMs: number
}) => {
  const child = spawn(process.execPath, [flockWorker, JSON.stringify(input)], {
    cwd: processTestRoot,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const stderr: Buffer[] = []
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Flock worker exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)),
    )
  })
  return { child, done }
}

describe("FileMutation", () => {
  it.live("writes an existing internal file and returns a stable result", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "hello.txt" })

        expect(yield* (yield* FileMutation.Service).write({ target, content: "after" })).toEqual({
          operation: "write",
          target: target.canonical,
          resource: "hello.txt",
          existed: true,
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes a prospective internal file and creates parent directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const target = yield* (yield* LocationMutation.Service).resolve({
          path: path.join("src", "nested", "hello.txt"),
        })
        const result = yield* (yield* FileMutation.Service).write({ target, content: "hello" })

        expect(result).toEqual({
          operation: "write",
          target: target.canonical,
          resource: "src/nested/hello.txt",
          existed: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(result.target, "utf8"))).toBe("hello")
      }).pipe(provide(directory)),
    ),
  )

  it.live("preserves exactly one BOM for text writes and normalizes created text", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const preservedPath = path.join(directory, "preserved.txt")
        yield* Effect.promise(() => fs.writeFile(preservedPath, "\uFEFFbefore"))
        const preserved = yield* (yield* LocationMutation.Service).resolve({ path: "preserved.txt" })
        const created = yield* (yield* LocationMutation.Service).resolve({ path: "created.txt" })
        const files = yield* FileMutation.Service

        yield* files.writeTextPreservingBom({ target: preserved, content: "\uFEFFafter" })
        yield* files.writeTextPreservingBom({ target: created, content: "\uFEFF\uFEFF\uFEFFcreated" })

        expect(yield* Effect.promise(() => fs.readFile(preservedPath, "utf8"))).toBe("\uFEFFafter")
        expect(yield* Effect.promise(() => fs.readFile(created.canonical, "utf8"))).toBe("\uFEFFcreated")
      }).pipe(provide(directory)),
    ),
  )

  it.live("returns preimage and postimage fingerprints with a rollback receipt", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "receipt.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "receipt.txt" })
        const receipt = yield* (yield* FileMutation.Service).writeTextWithReceipt({ target, content: "after" })

        expect(receipt.preimage).toMatchObject({ size: 6, mode: receipt.postimage.mode })
        expect(receipt.postimage).toMatchObject({ size: 5 })
        expect(receipt.postimage.identity).not.toBe(receipt.preimage?.identity)
        expect(receipt.postimage.digest).not.toBe(receipt.preimage?.digest)
        expect(receipt.rollback).toEqual({ kind: "restore_preimage", digest: receipt.preimage?.digest })
      }).pipe(provide(directory)),
    ),
  )

  it.live("uses the canonical rollback owner for created and restored files", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "rollback.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "rollback.txt" })
        const files = yield* FileMutation.Service
        const encodedBefore = new TextEncoder().encode("before")
        const encodedAfter = new TextEncoder().encode("after")

        yield* files.writeIfUnchanged({ target, expected: encodedBefore, content: encodedAfter })
        yield* files.rollback({ kind: "restore", target, expected: encodedAfter, content: encodedBefore })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("before")

        const created = yield* (yield* LocationMutation.Service).resolve({ path: "created-by-rollback.txt" })
        yield* files.create({ target: created, content: encodedAfter })
        yield* files.rollback({ kind: "remove-created", target: created, expected: encodedAfter })
        expect(
          yield* Effect.promise(() =>
            fs.stat(created.canonical).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)

        const deleted = yield* (yield* LocationMutation.Service).resolve({ path: "recreated-by-rollback.txt" })
        yield* files.create({ target: deleted, content: encodedBefore })
        yield* files.remove({ target: deleted })
        yield* files.rollback({ kind: "recreate", target: deleted, content: encodedBefore })
        expect(yield* Effect.promise(() => fs.readFile(deleted.canonical, "utf8"))).toBe("before")

        const conflict = yield* (yield* LocationMutation.Service).resolve({ path: "rollback-conflict.txt" })
        yield* files.create({ target: conflict, content: encodedAfter })
        const rollbackError = yield* files
          .rollback({ kind: "remove-created", target: conflict, expected: encodedBefore })
          .pipe(Effect.flip)
        expect(rollbackError).toMatchObject({ _tag: "FileMutation.StaleContentError" })
        expect(yield* Effect.promise(() => fs.readFile(conflict.canonical, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("executes an evidence-bound rollback from inverse artifacts and verifies the preimage", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const encoder = new TextEncoder()
        const beforeUpdated = encoder.encode("before-updated")
        const afterUpdated = encoder.encode("after-updated")
        const beforeRemoved = encoder.encode("before-removed")
        const afterCreated = encoder.encode("after-created")
        const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

        yield* Effect.promise(() => fs.writeFile(path.join(directory, "updated.txt"), afterUpdated))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "created.txt"), afterCreated))
        const artifacts = yield* RollbackArtifact.Service
        const updatedArtifact = yield* Effect.promise(() => artifacts.store.put(beforeUpdated))
        const removedArtifact = yield* Effect.promise(() => artifacts.store.put(beforeRemoved))
        const entries: AgentRuntime.MutationIntentEntry[] = [
          {
            target: "updated.txt",
            operation: "write",
            beforeDigest: digest(beforeUpdated),
            afterDigest: digest(afterUpdated),
            afterByteLength: afterUpdated.byteLength,
            rollbackArtifact: updatedArtifact,
            recovery: "restore-from-artifact",
          },
          {
            target: "created.txt",
            operation: "create",
            afterDigest: digest(afterCreated),
            afterByteLength: afterCreated.byteLength,
            recovery: "remove-if-matching",
          },
          {
            target: "removed.txt",
            operation: "remove",
            beforeDigest: digest(beforeRemoved),
            rollbackArtifact: removedArtifact,
            recovery: "manual-review",
          },
        ]
        const now = DateTime.makeUnsafe(1_000)
        const intent = AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: AgentRuntime.MutationTransactionID.create(),
          actionID: AgentRuntime.ActionID.create(),
          intentDigest: "d".repeat(64),
          idempotencyKey: "artifact-rollback-test",
          phase: "rollback_required",
          entries,
          manifestDigest: MutationIntent.manifestDigest(entries)!,
          automaticRetryAllowed: false,
          createdAt: now,
          updatedAt: now,
        })
        const files = yield* FileMutation.Service
        const initial = yield* FileMutation.inspectIntent({
          files,
          worktree: directory,
          intent,
        })
        expect(initial.decision).toBe("postimage_matches")
        expect(initial.rollbackAvailable).toBe(true)

        const receipt = yield* files.rollbackIntent({
          worktree: directory,
          intent,
          observationDigest: initial.observationDigest,
        })

        expect(receipt.transactionID).toBe(intent.transactionID)
        expect(receipt.inspection.decision).toBe("preimage_matches")
        expect(receipt.inspection.rollbackAvailable).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "updated.txt"), "utf8"))).toBe(
          "before-updated",
        )
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "removed.txt"), "utf8"))).toBe(
          "before-removed",
        )
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(directory, "created.txt")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory, undefined, path.join(directory, ".rollback-artifacts"))),
    ),
  )

  it.live("fails closed when a rollback approval is stale and leaves the changed target untouched", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const encoder = new TextEncoder()
        const before = encoder.encode("before")
        const after = encoder.encode("after")
        const changed = encoder.encode("changed")
        const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
        const targetPath = path.join(directory, "stale.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, after))
        const artifacts = yield* RollbackArtifact.Service
        const artifact = yield* Effect.promise(() => artifacts.store.put(before))
        const entries: AgentRuntime.MutationIntentEntry[] = [
          {
            target: "stale.txt",
            operation: "write",
            beforeDigest: digest(before),
            afterDigest: digest(after),
            afterByteLength: after.byteLength,
            rollbackArtifact: artifact,
            recovery: "restore-from-artifact",
          },
        ]
        const now = DateTime.makeUnsafe(1_000)
        const intent = AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: AgentRuntime.MutationTransactionID.create(),
          actionID: AgentRuntime.ActionID.create(),
          intentDigest: "e".repeat(64),
          idempotencyKey: "stale-rollback-test",
          phase: "rollback_required",
          entries,
          manifestDigest: MutationIntent.manifestDigest(entries)!,
          automaticRetryAllowed: false,
          createdAt: now,
          updatedAt: now,
        })
        const files = yield* FileMutation.Service
        const initial = yield* FileMutation.inspectIntent({ files, worktree: directory, intent })
        yield* Effect.promise(() => fs.writeFile(targetPath, changed))
        const error = yield* files
          .rollbackIntent({ worktree: directory, intent, observationDigest: initial.observationDigest })
          .pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FileMutation.MutationRollbackError" })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("changed")
      }).pipe(provide(directory, undefined, path.join(directory, ".rollback-artifacts"))),
    ),
  )

  it.live("rejects create when a prospective target appears after resolution", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "appeared.txt")
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "appeared.txt" })
        yield* Effect.promise(() => fs.writeFile(targetPath, "winner"))

        expect(
          yield* (yield* FileMutation.Service).create({ target, content: "replacement" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "FileMutation.TargetExistsError",
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("winner")
      }).pipe(provide(directory)),
    ),
  )

  it.live("creates when an existing target disappears after resolution", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "removed.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "removed.txt" })
        yield* Effect.promise(() => fs.rm(targetPath))

        expect(yield* (yield* FileMutation.Service).create({ target, content: "after" })).toEqual({
          operation: "write",
          target: target.canonical,
          resource: "removed.txt",
          existed: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("after")
      }).pipe(provide(directory)),
    ),
  )

  it.live("removes an existing internal file", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "remove.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "remove"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "remove.txt" })
        const result = yield* (yield* FileMutation.Service).remove({ target })

        expect(result).toEqual({
          operation: "remove",
          target: target.canonical,
          resource: "remove.txt",
          existed: true,
        })
        expect(
          yield* Effect.promise(() =>
            fs.stat(targetPath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("removes only when the expected bytes still match", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "conditional-remove.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "current"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "conditional-remove.txt" })
        const error = yield* (yield* FileMutation.Service)
          .removeIfUnchanged({ target, expected: new TextEncoder().encode("stale") })
          .pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "FileMutation.StaleContentError" })
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("current")
      }).pipe(provide(directory)),
    ),
  )

  it.live("fails closed before a mutation can cross a link or junction path component", () =>
    withTmp((directory) => {
      const blockedParent = path.join(directory, "linked-parent")
      const blocked = path.join(blockedParent, "created.txt")
      const target: FileMutation.Target = { canonical: blocked, resource: "linked-parent/created.txt" }
      const filesystem = blockSymbolicPath(blockedParent)
      return Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const error = yield* files.create({ target, content: "must-not-escape" }).pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "FileSystemError", method: "create" })
        expect(String(error)).toContain("Symbolic link or junction path component is not supported")
        expect(
          yield* Effect.promise(() =>
            fs.stat(blocked).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory, filesystem))
    }),
  )

  it.live("does not read or publish a move when its source path is link-bound", () =>
    withTmp((directory) => {
      const blockedParent = path.join(directory, "linked-parent")
      const sourcePath = path.join(blockedParent, "source.txt")
      const destinationPath = path.join(directory, "destination.txt")
      const source: FileMutation.Target = { canonical: sourcePath, resource: "linked-parent/source.txt" }
      const destination: FileMutation.Target = { canonical: destinationPath, resource: "destination.txt" }
      const filesystem = blockSymbolicPath(blockedParent)
      return Effect.gen(function* () {
        const files = yield* FileMutation.Service
        const error = yield* files
          .moveIfUnchanged({
            source,
            destination,
            expectedSource: new TextEncoder().encode("source"),
            content: "destination",
          })
          .pipe(Effect.flip)

        expect(error).toMatchObject({ _tag: "FileSystemError", method: "moveIfUnchanged" })
        expect(
          yield* Effect.promise(() =>
            fs.stat(destinationPath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory, filesystem))
    }),
  )

  it.live("orders overlapping reverse moves so one CAS wins without deadlocking", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const firstPath = path.join(directory, "source A 空格.txt")
        const secondPath = path.join(directory, "source B-ß.txt")
        yield* Effect.promise(() => Promise.all([fs.writeFile(firstPath, "first"), fs.writeFile(secondPath, "second")]))
        const first: FileMutation.Target = { canonical: firstPath, resource: "source A 空格.txt" }
        const second: FileMutation.Target = { canonical: secondPath, resource: "source B-ß.txt" }
        const files = yield* FileMutation.Service
        const outcomes = yield* Effect.all(
          [
            files
              .moveIfUnchanged({
                source: first,
                destination: second,
                expectedSource: new TextEncoder().encode("first"),
                expectedDestination: new TextEncoder().encode("second"),
                content: "first moved",
              })
              .pipe(Effect.exit),
            files
              .moveIfUnchanged({
                source: second,
                destination: first,
                expectedSource: new TextEncoder().encode("second"),
                expectedDestination: new TextEncoder().encode("first"),
                content: "second moved",
              })
              .pipe(Effect.exit),
          ],
          { concurrency: 2 },
        )

        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
        expect(outcomes.filter(Exit.isFailure)).toHaveLength(1)
        const remaining = yield* Effect.promise(async () => {
          const files = await Promise.all(
            [firstPath, secondPath].map((candidate) =>
              fs.readFile(candidate, "utf8").then(
                (content) => ({ candidate, content }),
                () => undefined,
              ),
            ),
          )
          return files.filter((value): value is { candidate: string; content: string } => value !== undefined)
        })
        expect(remaining).toHaveLength(1)
        expect(["first moved", "second moved"]).toContain(remaining[0].content)
      }).pipe(provide(directory)),
    ),
  )

  it.live("serializes overlapping reverse moves across independent processes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const firstName = "process A 空格.txt"
        const secondName = "process B-ß.txt"
        const firstPath = path.join(directory, firstName)
        const secondPath = path.join(directory, secondName)
        yield* Effect.promise(() => Promise.all([fs.writeFile(firstPath, "first"), fs.writeFile(secondPath, "second")]))
        const results = yield* Effect.promise(() =>
          Promise.all([
            runMutationWorker({
              directory,
              operation: "move",
              source: firstName,
              destination: secondName,
              expectedSource: "first",
              expectedDestination: "second",
              content: "first moved",
            }),
            runMutationWorker({
              directory,
              operation: "move",
              source: secondName,
              destination: firstName,
              expectedSource: "second",
              expectedDestination: "first",
              content: "second moved",
            }),
          ]),
        )

        expect(results.filter((result) => result.kind === "success")).toHaveLength(1)
        expect(results.filter((result) => result.kind === "error")).toHaveLength(1)
        const remaining = yield* Effect.promise(async () => {
          const files = await Promise.all(
            [firstPath, secondPath].map((candidate) =>
              fs.readFile(candidate, "utf8").then(
                (content) => ({ candidate, content }),
                () => undefined,
              ),
            ),
          )
          return files.filter((value): value is { candidate: string; content: string } => value !== undefined)
        })
        expect(remaining).toHaveLength(1)
        expect(["first moved", "second moved"]).toContain(remaining[0].content)
      }).pipe(provide(directory)),
    ),
  )

  it.live("moves and transforms a source under one ordered two-target CAS", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const sourcePath = path.join(directory, "source.txt")
        const destinationPath = path.join(directory, "nested", "destination.txt")
        yield* Effect.promise(() => fs.writeFile(sourcePath, "before"))
        const location = yield* LocationMutation.Service
        const source = yield* location.resolve({ path: "source.txt" })
        const destination = yield* location.resolve({ path: "nested/destination.txt" })
        const result = yield* (yield* FileMutation.Service).moveIfUnchanged({
          source,
          destination,
          expectedSource: new TextEncoder().encode("before"),
          content: "after",
        })

        expect(result).toEqual({
          operation: "move",
          source: source.canonical,
          destination: destination.canonical,
          sourceResource: "source.txt",
          destinationResource: "nested/destination.txt",
          overwritten: false,
        })
        expect(yield* Effect.promise(() => fs.readFile(destinationPath, "utf8"))).toBe("after")
        expect(
          yield* Effect.promise(() =>
            fs.stat(sourcePath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires an exact source preimage and never overwrites an unexpected destination", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const sourcePath = path.join(directory, "source.txt")
        const destinationPath = path.join(directory, "destination.txt")
        yield* Effect.promise(() =>
          Promise.all([fs.writeFile(sourcePath, "current"), fs.writeFile(destinationPath, "keep")]),
        )
        const location = yield* LocationMutation.Service
        const source = yield* location.resolve({ path: "source.txt" })
        const destination = yield* location.resolve({ path: "destination.txt" })
        const files = yield* FileMutation.Service

        const stale = yield* files
          .moveIfUnchanged({
            source,
            destination,
            expectedSource: new TextEncoder().encode("stale"),
            content: "new",
          })
          .pipe(Effect.flip)
        expect(stale).toMatchObject({ _tag: "FileMutation.StaleContentError" })

        const exists = yield* files
          .moveIfUnchanged({
            source,
            destination,
            expectedSource: new TextEncoder().encode("current"),
            content: "new",
          })
          .pipe(Effect.flip)
        expect(exists).toMatchObject({ _tag: "FileMutation.TargetExistsError" })
        expect(yield* Effect.promise(() => fs.readFile(sourcePath, "utf8"))).toBe("current")
        expect(yield* Effect.promise(() => fs.readFile(destinationPath, "utf8"))).toBe("keep")
      }).pipe(provide(directory)),
    ),
  )

  it.live("overwrites a destination only with its exact preimage", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const sourcePath = path.join(directory, "source.txt")
        const destinationPath = path.join(directory, "destination.txt")
        yield* Effect.promise(() =>
          Promise.all([fs.writeFile(sourcePath, "from"), fs.writeFile(destinationPath, "old")]),
        )
        const location = yield* LocationMutation.Service
        const source = yield* location.resolve({ path: "source.txt" })
        const destination = yield* location.resolve({ path: "destination.txt" })
        const result = yield* (yield* FileMutation.Service).moveIfUnchanged({
          source,
          destination,
          expectedSource: new TextEncoder().encode("from"),
          expectedDestination: new TextEncoder().encode("old"),
          content: "replaced",
        })

        expect(result.overwritten).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(destinationPath, "utf8"))).toBe("replaced")
        expect(
          yield* Effect.promise(() =>
            fs.stat(sourcePath).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }).pipe(provide(directory)),
    ),
  )

  it.live("writes an explicitly resolved external target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "external.txt")
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const result = yield* (yield* FileMutation.Service).write({ target, content: "external" })

          expect(result).toEqual({
            operation: "write",
            target: target.canonical,
            resource: target.resource,
            existed: false,
          })
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("external")
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("removes an explicitly resolved external target", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "external.txt")
          yield* Effect.promise(() => fs.writeFile(targetPath, "external"))
          const target = yield* (yield* LocationMutation.Service).resolve({ path: targetPath })
          const result = yield* (yield* FileMutation.Service).remove({ target })

          expect(result).toEqual({
            operation: "remove",
            target: target.canonical,
            resource: target.resource,
            existed: true,
          })
          expect(
            yield* Effect.promise(() =>
              fs.stat(targetPath).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("reports a missing target as not removed without checking existence first", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "missing.txt" })

        expect(yield* (yield* FileMutation.Service).remove({ target })).toEqual({
          operation: "remove",
          target: target.canonical,
          resource: "missing.txt",
          existed: false,
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("serializes concurrent writes to the same canonical target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "initial"))
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          Effect.gen(function* () {
            writes++
            if (writes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            } else {
              yield* Deferred.succeed(secondStarted, undefined)
            }
            yield* write
          }),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* mutation.resolve({ path: "shared.txt" })
          const secondPlan = yield* mutation.resolve({ path: "shared.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(secondStarted)).toBe(false)

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Deferred.await(secondStarted)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("second")
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live("allows only one concurrent conditional write based on the same bytes", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "shared.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "initial"))
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          Effect.gen(function* () {
            writes++
            if (writes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
            }
            yield* write
          }),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const target = yield* mutation.resolve({ path: "shared.txt" })
          const expected = new TextEncoder().encode("initial")
          const first = yield* files.writeIfUnchanged({ target, expected, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files
            .writeIfUnchanged({ target, expected, content: "second" })
            .pipe(Effect.flip, Effect.forkChild)

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(first)
          expect(yield* Fiber.join(second)).toMatchObject({ _tag: "FileMutation.StaleContentError" })
          expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("first")
          expect(writes).toBe(1)
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )

  it.live(
    "fails closed when a non-cooperating writer changes the target during the read-to-commit window",
    () =>
      Effect.promise(async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutation-noncooperating-"))
        const targetPath = path.join(directory, "shared.txt")
        const readMarker = path.join(directory, "read.marker")
        await fs.writeFile(targetPath, "initial")

        try {
          const worker = runMutationWorker({
            directory,
            target: "shared.txt",
            expected: "initial",
            content: "arforge-result",
            pauseAfterReadMs: 350,
            readMarker,
          })
          await waitForFile(readMarker)
          // Deliberately bypass FileMutation/Flock: this models an editor or
          // another process that does not participate in Arforge's lease.
          await fs.writeFile(targetPath, "external-change")

          const result = await worker
          expect(result.kind).toBe("error")
          expect((result as Extract<ProcessMutationResult, { readonly kind: "error" }>).tag).toBe(
            "FileMutation.StaleContentError",
          )
          expect(await fs.readFile(targetPath, "utf8")).toBe("external-change")
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      }),
    30_000,
  )

  it.live(
    "allows only one conditional write across cooperating processes",
    () =>
      Effect.promise(async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutation-process-"))
        const targetPath = path.join(directory, "shared.txt")
        await fs.writeFile(targetPath, "initial")

        try {
          const results = await Promise.all(
            ["first", "second"].map((content) =>
              runMutationWorker({
                directory,
                target: "shared.txt",
                expected: "initial",
                content,
                // Make the read-to-commit window large enough that a
                // process-local mutex alone would let both workers win.
                pauseAfterReadMs: 150,
              }),
            ),
          )
          const successes = results.filter((result) => result.kind === "success")
          const stale = results.filter(
            (result): result is Extract<ProcessMutationResult, { readonly kind: "error" }> =>
              result.kind === "error" && result.tag === "FileMutation.StaleContentError",
          )

          expect(successes).toHaveLength(1)
          expect(stale).toHaveLength(1)
          expect(["first", "second"]).toContain(await fs.readFile(targetPath, "utf8"))
        } finally {
          await fs.rm(directory, { recursive: true, force: true })
        }
      }),
    30_000,
  )

  it.live(
    "waits for the cross-process mutation lease before comparing bytes",
    () =>
      Effect.promise(async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutation-lease-"))
        const targetPath = path.join(directory, "held.txt")
        await fs.writeFile(targetPath, "initial")
        const canonical = path.normalize(path.resolve(targetPath))
        const key = `file-mutation:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`
        const lockDir = path.join(os.tmpdir(), "arforge-file-mutation-locks")
        const active = path.join(directory, "flock-active")
        const holder = spawnFlockWorker({ key, dir: lockDir, active, holdMs: 400 })

        try {
          await waitForFile(active)
          const started = Date.now()
          const result = await runMutationWorker({
            directory,
            target: "held.txt",
            expected: "initial",
            content: "replacement",
          })

          expect(result.kind).toBe("success")
          expect(Date.now() - started).toBeGreaterThanOrEqual(250)
          expect(await fs.readFile(targetPath, "utf8")).toBe("replacement")
          await holder.done
        } finally {
          if (holder.child.exitCode === null) holder.child.kill()
          await holder.done.catch(() => undefined)
          await fs.rm(directory, { recursive: true, force: true })
        }
      }),
    30_000,
  )

  it.live(
    "serializes recovery fingerprints behind the cross-process mutation lease",
    () =>
      Effect.promise(async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutation-fingerprint-"))
        const targetPath = path.join(directory, "held.txt")
        await fs.writeFile(targetPath, "initial")
        const canonical = path.normalize(path.resolve(targetPath))
        const key = `file-mutation:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`
        const lockDir = path.join(os.tmpdir(), "arforge-file-mutation-locks")
        const active = path.join(directory, "flock-active")
        const holder = spawnFlockWorker({ key, dir: lockDir, active, holdMs: 400 })

        try {
          await waitForFile(active)
          const started = Date.now()
          const result = await runMutationWorker({
            directory,
            target: "held.txt",
            expected: "unused",
            content: "unused",
            operation: "fingerprint",
          })

          expect(result.kind).toBe("success")
          expect((result as Extract<ProcessMutationResult, { readonly kind: "success" }>).result).toMatchObject({
            digest: expect.any(String),
            size: 7,
          })
          expect(Date.now() - started).toBeGreaterThanOrEqual(250)
          expect(await fs.readFile(targetPath, "utf8")).toBe("initial")
          await holder.done
        } finally {
          if (holder.child.exitCode === null) holder.child.kill()
          await holder.done.catch(() => undefined)
          await fs.rm(directory, { recursive: true, force: true })
        }
      }),
    30_000,
  )

  it.live("rejects a conditional write when target content is already stale", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "stale.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "current"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "stale.txt" })

        const error = yield* (yield* FileMutation.Service)
          .writeIfUnchanged({ target, expected: new TextEncoder().encode("older"), content: "replacement" })
          .pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "FileMutation.StaleContentError", path: target.canonical })
        const stale = error as FileMutation.StaleContentError
        expect(stale.observedVersion).toMatch(/^[a-f0-9]{64}$/)
        expect(stale.currentVersion).toMatch(/^[a-f0-9]{64}$/)
        expect(stale.observedVersion).not.toBe(stale.currentVersion)
        expect(yield* Effect.promise(() => fs.readFile(targetPath, "utf8"))).toBe("current")
      }).pipe(provide(directory)),
    ),
  )

  it.live("reports a conditional write as stale when the target is removed", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "removed.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "before"))
        const target = yield* (yield* LocationMutation.Service).resolve({ path: "removed.txt" })
        const expected = new TextEncoder().encode("before")
        yield* Effect.promise(() => fs.rm(targetPath))

        const error = yield* (yield* FileMutation.Service)
          .writeIfUnchanged({ target, expected, content: "replacement" })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(FileMutation.StaleContentError)
        expect((error as FileMutation.StaleContentError).path).toBe(target.canonical)
        expect((error as FileMutation.StaleContentError).currentVersion).toBeUndefined()
        expect((error as FileMutation.StaleContentError).observedVersion).toMatch(/^[a-f0-9]{64}$/)
      }).pipe(provide(directory)),
    ),
  )

  it.live("allows distinct canonical targets to proceed independently", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const secondFinished = yield* Deferred.make<void>()
        const secondPath = path.join(directory, "second.txt")
        let writes = 0
        const filesystem = instrumentWrites((write) =>
          ++writes === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
                Effect.andThen(write),
              )
            : write.pipe(Effect.andThen(Deferred.succeed(secondFinished, undefined))),
        )

        yield* Effect.gen(function* () {
          const mutation = yield* LocationMutation.Service
          const files = yield* FileMutation.Service
          const firstPlan = yield* mutation.resolve({ path: "first.txt" })
          const secondPlan = yield* mutation.resolve({ path: "second.txt" })
          const first = yield* files.write({ target: firstPlan, content: "first" }).pipe(Effect.forkChild)
          yield* Deferred.await(firstStarted)
          const second = yield* files.write({ target: secondPlan, content: "second" }).pipe(Effect.forkChild)
          yield* Deferred.await(secondFinished)
          expect(yield* Effect.promise(() => fs.readFile(secondPath, "utf8"))).toBe("second")

          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
        }).pipe(provide(directory, filesystem))
      }),
    ),
  )
})

function instrumentWrites(run: <E>(write: Effect.Effect<void, E>, target: string) => Effect.Effect<void, E>) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const filesystem = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...filesystem,
        writeWithDirs: (target, content, mode) => run(filesystem.writeWithDirs(target, content, mode), target),
        ...(filesystem.writeIfUnchanged
          ? {
              writeIfUnchanged: (target: string, expected: Uint8Array, content: string | Uint8Array, mode?: number) =>
                run(filesystem.writeIfUnchanged!(target, expected, content, mode), target),
            }
          : {}),
        writeFile: (target, content, options) => run(filesystem.writeFile(target, content, options), target),
        writeFileString: (target, content, options) =>
          run(filesystem.writeFileString(target, content, options), target),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

/**
 * Exercise the Core link guard on every host, including Windows where creating
 * a real symlink/junction may require an unavailable developer privilege. The
 * node filesystem remains real for all other operations; only the lstat-like
 * capability reports the selected path component as link-bound.
 */
function blockSymbolicPath(blocked: string) {
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const filesystem = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...filesystem,
        isSymbolicLink: (candidate: string) =>
          candidate === blocked ? Effect.succeed(true) : filesystem.isSymbolicLink(candidate),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}
