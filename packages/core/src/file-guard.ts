import { createHash, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import * as NFS from "node:fs/promises"
import type { Stats } from "node:fs"
import { Effect, Schema } from "effect"

export class SymbolicLinkError extends Schema.TaggedErrorClass<SymbolicLinkError>()("FileGuard.SymbolicLinkError", {
  path: Schema.String,
}) {}

export class FileGuardError extends Schema.TaggedErrorClass<FileGuardError>()("FileGuard.Error", {
  method: Schema.String,
  message: Schema.String,
}) {}

/** A conditional atomic write observed a non-cooperating external change. */
export class ConditionalWriteConflictError extends Schema.TaggedErrorClass<ConditionalWriteConflictError>()(
  "FileGuard.ConditionalWriteConflictError",
  {
    path: Schema.String,
    expectedVersion: Schema.String,
    currentVersion: Schema.optional(Schema.String),
  },
) {}

export type FileFingerprint = {
  readonly digest: string
  readonly size: number
  readonly mode: number
  readonly identity: string
  readonly mtimeMs: number
}

export type FileSnapshot = FileFingerprint & {
  readonly content: Uint8Array
}

const toError = (method: string, cause: unknown) =>
  new FileGuardError({ method, message: cause instanceof Error ? cause.message : String(cause) })

const identity = (stat: Stats) => `${String(stat.dev)}:${String(stat.ino)}`

const makeSnapshot = (content: Uint8Array, stat: Stats): FileSnapshot => ({
  content,
  digest: createHash("sha256").update(content).digest("hex"),
  size: content.length,
  mode: stat.mode & 0o7777,
  identity: identity(stat),
  mtimeMs: stat.mtimeMs,
})

const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex")

const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

const assertNoSymbolicLinks = async (path: string) => {
  let current = path
  while (true) {
    try {
      const stat = await NFS.lstat(current)
      if (stat.isSymbolicLink()) throw new SymbolicLinkError({ path: current })
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export const snapshot = Effect.fn("FileGuard.snapshot")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      await assertNoSymbolicLinks(path)
      let stat: Stats
      try {
        stat = await NFS.lstat(path)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
        throw toError("lstat", cause)
      }
      if (stat.isSymbolicLink()) throw new SymbolicLinkError({ path })
      if (!stat.isFile()) throw toError("snapshot", new Error("Target is not a regular file"))
      const content = new Uint8Array(await NFS.readFile(path))
      return makeSnapshot(content, stat)
    },
    catch: (cause) =>
      cause instanceof SymbolicLinkError || cause instanceof FileGuardError ? cause : toError("snapshot", cause),
  })
})

export const isSymbolicLink = Effect.fn("FileGuard.isSymbolicLink")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        return (await NFS.lstat(path)).isSymbolicLink()
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return false
        throw cause
      }
    },
    catch: (cause) => toError("lstat", cause),
  })
})

export const atomicWrite = Effect.fn("FileGuard.atomicWrite")(function* (
  path: string,
  content: string | Uint8Array,
  mode?: number,
  options?: { overwrite?: boolean },
) {
  return yield* Effect.tryPromise({
    try: async () => {
      await assertNoSymbolicLinks(path)
      await NFS.mkdir(dirname(path), { recursive: true })
      let existing: Stats | undefined
      try {
        existing = await NFS.lstat(path)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause
      }
      if (existing?.isSymbolicLink()) throw new SymbolicLinkError({ path })
      // Keep the temporary basename independent of the target basename. A
      // valid Windows filename can already be close to the per-component
      // limit, and appending pid/UUID metadata to it would make the atomic
      // write fail before rename can occur.
      const temporary = join(dirname(path), `.arforge-tmp-${process.pid}-${randomUUID()}`)
      const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content)
      try {
        const handle = await NFS.open(temporary, "wx", mode ?? (existing ? existing.mode & 0o7777 : 0o666))
        try {
          await handle.write(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await assertNoSymbolicLinks(path)
        if (options?.overwrite === false) {
          try {
            // Publish a fully fsynced new file without replacing a file that
            // another writer created after our initial absence observation.
            await NFS.link(temporary, path)
          } catch (cause) {
            if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
              throw new ConditionalWriteConflictError({ path, expectedVersion: "absent" })
            throw cause
          }
        } else await NFS.rename(temporary, path)
        try {
          const directory = await NFS.open(dirname(path), "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        } catch {
          // Directory fsync is unavailable on some Windows filesystems.
        }
      } finally {
        await NFS.rm(temporary, { force: true }).catch(() => undefined)
      }
      const post = await NFS.lstat(path)
      if (post.isSymbolicLink()) throw new SymbolicLinkError({ path })
      return makeSnapshot(new Uint8Array(bytes), post)
    },
    catch: (cause) =>
      cause instanceof SymbolicLinkError ||
      cause instanceof FileGuardError ||
      cause instanceof ConditionalWriteConflictError
        ? cause
        : toError("atomicWrite", cause),
  })
})

/**
 * Write a replacement through a temporary file and re-check the expected
 * preimage immediately before the atomic rename. This closes the common
 * non-cooperating-writer window (a writer that changes the target after the
 * initial observation but before commit) while retaining the platform's
 * atomic rename semantics. A truly hostile writer can still race the final
 * kernel operation; callers therefore perform a postimage check and must
 * treat a conflict as a failed transaction rather than retrying blindly.
 */
export const atomicWriteIfUnchanged = Effect.fn("FileGuard.atomicWriteIfUnchanged")(function* (
  path: string,
  expected: Uint8Array,
  content: string | Uint8Array,
  mode?: number,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      await assertNoSymbolicLinks(path)
      await NFS.mkdir(dirname(path), { recursive: true })
      const expectedVersion = digest(expected)
      let initial: { content: Uint8Array; stat: Stats } | undefined
      try {
        const stat = await NFS.lstat(path)
        if (stat.isSymbolicLink()) throw new SymbolicLinkError({ path })
        if (!stat.isFile()) throw toError("conditionalAtomicWrite", new Error("Target is not a regular file"))
        const current = new Uint8Array(await NFS.readFile(path))
        if (!sameBytes(current, expected))
          throw new ConditionalWriteConflictError({
            path,
            expectedVersion,
            currentVersion: digest(current),
          })
        initial = { content: current, stat }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === "ENOENT")
          throw new ConditionalWriteConflictError({ path, expectedVersion })
        throw cause
      }

      const temporary = join(dirname(path), ".arforge-cas-" + process.pid + "-" + randomUUID())
      const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content)
      try {
        const handle = await NFS.open(temporary, "wx", mode ?? initial.stat.mode & 0o7777)
        try {
          await handle.write(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }

        // Re-read both bytes and identity after staging. This rejects an
        // external writer that did not participate in Arforge's Flock.
        let latest: { content: Uint8Array; stat: Stats } | undefined
        try {
          const stat = await NFS.lstat(path)
          if (stat.isSymbolicLink()) throw new SymbolicLinkError({ path })
          if (!stat.isFile()) throw toError("conditionalAtomicWrite", new Error("Target is not a regular file"))
          latest = { content: new Uint8Array(await NFS.readFile(path)), stat }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code === "ENOENT")
            throw new ConditionalWriteConflictError({ path, expectedVersion })
          throw cause
        }
        if (!sameBytes(latest.content, expected) || identity(latest.stat) !== identity(initial.stat))
          throw new ConditionalWriteConflictError({
            path,
            expectedVersion,
            currentVersion: digest(latest.content),
          })

        await NFS.rename(temporary, path)
        try {
          const directory = await NFS.open(dirname(path), "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        } catch {
          // Directory fsync is unavailable on some Windows filesystems.
        }

        const post = await NFS.lstat(path)
        if (post.isSymbolicLink()) throw new SymbolicLinkError({ path })
        if (!post.isFile()) throw toError("conditionalAtomicWrite", new Error("Target is not a regular file"))
        const postContent = new Uint8Array(await NFS.readFile(path))
        if (!sameBytes(postContent, bytes))
          throw new ConditionalWriteConflictError({
            path,
            expectedVersion,
            currentVersion: digest(postContent),
          })
        return makeSnapshot(postContent, post)
      } finally {
        await NFS.rm(temporary, { force: true }).catch(() => undefined)
      }
    },
    catch: (cause) =>
      cause instanceof SymbolicLinkError ||
      cause instanceof FileGuardError ||
      cause instanceof ConditionalWriteConflictError
        ? cause
        : toError("conditionalAtomicWrite", cause),
  })
})
