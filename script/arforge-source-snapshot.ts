import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises"
import path from "node:path"
import { canonicalJson, sha256Text } from "./arforge-governance"

/** Input freshness only: this artifact neither grants permission nor accepts a feature. */
export const SOURCE_SNAPSHOT_PATH = "docs/evidence/implementation/source-snapshot.v1.json"
type Entry = Readonly<{
  path: string
  git_status: string
  kind: "file" | "deleted"
  size: number
  digest: string | null
}>
type Body = Readonly<{
  schema_version: "1.0"
  scope: "git-visible-working-tree"
  head: string | null
  excluded_paths: readonly string[]
  entries: readonly Entry[]
}>
export type SourceSnapshot = Body & Readonly<{ digest: string }>

const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  })
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const absent = (error: unknown) => isRecord(error) && error.code === "ENOENT"
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const safeRelative = (value: string) =>
  value.length > 0 &&
  !path.posix.isAbsolute(value) &&
  !path.win32.isAbsolute(value) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")

async function repositoryRoot(input: string) {
  const root = await realpath(path.resolve(input))
  const top = await realpath(git(root, ["rev-parse", "--show-toplevel"]).trim())
  if (root !== top) throw new Error("snapshot root must be the Git working-tree root")
  return root
}

/** Reject links (including junction parents); never hash a target outside the declared root. */
async function safeFile(root: string, relative: string) {
  if (!safeRelative(relative)) throw new Error("unsafe snapshot input path")
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`snapshot input contains link: ${relative}`)
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return current
}

export function parseGitStatus(output: string) {
  const statuses = new Map<string, string>()
  const rows = output.split("\0")
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (!row) continue
    const status = row.slice(0, 2)
    const name = row.slice(3)
    if (!safeRelative(name)) throw new Error("invalid path from Git status")
    statuses.set(name, status)
    // With -z, rename/copy records contain the destination first, then the old name.
    if (/[RC]/.test(status)) {
      const old = rows[++index]
      if (!old || !safeRelative(old)) throw new Error("invalid rename record from Git status")
    }
  }
  return statuses
}

function inventory(root: string) {
  const paths = [
    ...new Set(
      git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter((name) => name && name !== SOURCE_SNAPSHOT_PATH),
    ),
  ].sort(compareText)
  const statuses = parseGitStatus(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  })
  if (head.error) throw head.error
  return { head: head.status === 0 ? head.stdout.trim() : null, paths, statuses }
}

async function inputEntry(root: string, relative: string, gitStatus: string): Promise<Entry> {
  const file = await safeFile(root, relative)
  try {
    const info = await lstat(file)
    if (!info.isFile()) throw new Error(`snapshot input is not a regular file: ${relative}`)
    const handle = await open(file, "r")
    try {
      const before = await handle.stat()
      const hash = createHash("sha256")
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await handle.stat()
      await safeFile(root, relative)
      const current = await lstat(file)
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== current.ino ||
        before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== current.ctimeMs
      ) {
        throw new Error(`snapshot input changed while reading: ${relative}`)
      }
      return { path: relative, git_status: gitStatus, kind: "file", size: before.size, digest: hash.digest("hex") }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!absent(error) || !gitStatus.includes("D")) throw error
    return { path: relative, git_status: gitStatus, kind: "deleted", size: 0, digest: null }
  }
}

/** Reuse the snapshot's link rejection and streamed, stable-file hashing for declared evidence inputs. */
export async function hashDeclaredInput(rootInput: string, relative: string): Promise<string> {
  const root = await realpath(path.resolve(rootInput))
  const entry = await inputEntry(root, relative, "  ")
  if (!entry.digest) throw new Error(`declared input is unavailable: ${relative}`)
  return entry.digest
}

/** Safe read for small metadata documents; source files continue to use streamed hashing. */
export async function readDeclaredJson(rootInput: string, relative: string): Promise<unknown> {
  const root = await realpath(path.resolve(rootInput))
  const before = await hashDeclaredInput(root, relative)
  const text = await readFile(await safeFile(root, relative), "utf8")
  if (sha256Text(text) !== before || (await hashDeclaredInput(root, relative)) !== before)
    throw new Error(`declared metadata changed during read: ${relative}`)
  return JSON.parse(text)
}

export async function buildSourceSnapshot(rootInput: string): Promise<SourceSnapshot> {
  const root = await repositoryRoot(rootInput)
  const start = inventory(root)
  const entries: Entry[] = []
  // Bound open files/memory; each file is streamed, not read into a giant buffer.
  for (let index = 0; index < start.paths.length; index += 8) {
    entries.push(
      ...(await Promise.all(
        start.paths.slice(index, index + 8).map((name) => inputEntry(root, name, start.statuses.get(name) ?? "  ")),
      )),
    )
  }
  const end = inventory(root)
  const inventoryKey = (value: typeof start) =>
    canonicalJson({
      head: value.head,
      paths: value.paths,
      statuses: value.paths.map((name) => [name, value.statuses.get(name) ?? "  "]),
    })
  if (inventoryKey(start) !== inventoryKey(end))
    throw new Error("Git inputs changed during snapshot capture; retry with quiescent sources")
  const body: Body = {
    schema_version: "1.0",
    scope: "git-visible-working-tree",
    head: start.head,
    excluded_paths: [SOURCE_SNAPSHOT_PATH],
    entries,
  }
  return { ...body, digest: sha256Text(canonicalJson(body)) }
}

export async function writeSourceSnapshot(rootInput: string) {
  const root = await repositoryRoot(rootInput)
  const snapshot = await buildSourceSnapshot(root)
  const file = await safeFile(root, SOURCE_SNAPSHOT_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await safeFile(root, SOURCE_SNAPSHOT_PATH)
  const temporary = `${file}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    created = true
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2) + "\n")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await safeFile(root, SOURCE_SNAPSHOT_PATH)
    await rename(temporary, file)
  } finally {
    if (created) await rm(temporary, { force: true })
  }
  return { path: SOURCE_SNAPSHOT_PATH, digest: snapshot.digest, input_count: snapshot.entries.length }
}

export async function validateSourceSnapshot(rootInput: string) {
  const findings: Array<{ code: string; path: string; detail: string }> = []
  const changed: string[] = []
  let count = 0
  try {
    const root = await repositoryRoot(rootInput)
    const stored: unknown = JSON.parse(await readFile(await safeFile(root, SOURCE_SNAPSHOT_PATH), "utf8"))
    if (!isRecord(stored)) throw new Error("snapshot must be a JSON object")
    const { digest, ...body } = stored
    if (typeof digest !== "string" || digest !== sha256Text(canonicalJson(body))) {
      findings.push({
        code: "SNAPSHOT-INTEGRITY",
        path: SOURCE_SNAPSHOT_PATH,
        detail: "snapshot digest does not match its content",
      })
    }
    const current = await buildSourceSnapshot(root)
    count = current.entries.length
    // Full canonical comparison rejects unknown fields, omitted files and schema changes.
    if (canonicalJson(stored) !== canonicalJson(current)) {
      const previous = new Map<string, string>()
      for (const entry of Array.isArray(stored.entries) ? stored.entries : []) {
        if (isRecord(entry) && typeof entry.path === "string") previous.set(entry.path, canonicalJson(entry))
      }
      const next = new Map(current.entries.map((entry) => [entry.path, canonicalJson(entry)]))
      for (const name of [...new Set([...previous.keys(), ...next.keys()])].sort(compareText)) {
        if (previous.get(name) !== next.get(name)) changed.push(name)
      }
      findings.push({
        code: "SNAPSHOT-STALE",
        path: SOURCE_SNAPSHOT_PATH,
        detail: "snapshot differs from current Git-visible working-tree inputs; not a feature acceptance result",
      })
    }
  } catch (error) {
    findings.push({
      code: "SNAPSHOT-UNAVAILABLE",
      path: SOURCE_SNAPSHOT_PATH,
      detail: error instanceof Error ? error.message : "snapshot validation failed",
    })
  }
  return {
    schema_version: "1.0" as const,
    valid: findings.length === 0,
    findings,
    changed_paths: changed,
    input_count: count,
  }
}
