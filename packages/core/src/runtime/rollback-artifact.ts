import { createHash, randomUUID } from "node:crypto"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rename, rm, lstat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path"
import { Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"

const DIGEST = /^[a-f0-9]{64}$/
const ARTIFACT_NAME = /^rollback-([a-f0-9]{64})\.bin$/
const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const ENCRYPTED_ENVELOPE = new TextEncoder().encode("ARFORGE-ROLLBACK-ARTIFACT-ENC1\0")

export type RollbackArtifactRef = Readonly<{
  readonly version: 1
  readonly artifactID: string
  readonly digest: string
  readonly byteLength: number
}>

/**
 * The smallest shape needed to collect live inverse-artifact references from
 * durable aggregates. Keeping this structural avoids coupling the profile
 * store to DurableAction and, more importantly, keeps the store as the only
 * owner of artifact bytes and lifecycle decisions.
 */
export type RollbackArtifactReferenceSource = Readonly<{
  readonly mutationIntent?: Readonly<{
    readonly entries: ReadonlyArray<Readonly<{ readonly rollbackArtifact?: RollbackArtifactRef }>>
  }>
}>

export type RollbackArtifactStoreOptions = Readonly<{
  /** A profile-owned directory outside the workspace being mutated. */
  readonly root: string
  readonly maxArtifactBytes?: number
  /** A profile-wide on-disk quota. Existing references are never evicted by a sweep. */
  readonly maxTotalBytes?: number
  /** Optional at-rest protector. The reference digest always describes plaintext bytes. */
  readonly protector?: RollbackArtifactProtector
  /** Refuse plaintext persistence when the caller requires an encrypted profile. */
  readonly requireEncryption?: boolean
}>

export type RollbackArtifactSweepOptions = Readonly<{
  readonly maxAgeMs?: number
  readonly nowMs?: number
  /** Durable references that must survive retention, even when old. */
  readonly referenced?: ReadonlyArray<RollbackArtifactRef>
  /** Optional one-shot quota override for maintenance tooling. */
  readonly maxTotalBytes?: number
  /** When true, remove oldest unreferenced valid artifacts until quota is met. */
  readonly enforceQuota?: boolean
}>

export type RollbackArtifactAuditOptions = Readonly<{
  readonly maxAgeMs?: number
  readonly nowMs?: number
  readonly referenced?: ReadonlyArray<RollbackArtifactRef>
  readonly maxTotalBytes?: number
}>

export type RollbackArtifactAudit = Readonly<{
  readonly scannedEntries: number
  readonly artifactCount: number
  readonly totalBytes: number
  readonly referencedCount: number
  readonly orphanCount: number
  readonly expiredOrphanCount: number
  readonly missingReferenceCount: number
  readonly invalidCount: number
  readonly unsafeCount: number
  readonly corruptCount: number
  readonly overQuota: boolean
}>

export type RollbackArtifactSweepReport = RollbackArtifactAudit &
  Readonly<{
    readonly removed: number
  }>

/** Optional profile-owned encryption boundary; implementations must not log plaintext. */
export type RollbackArtifactProtector = Readonly<{
  readonly protect: (plaintext: Uint8Array) => Uint8Array | Promise<Uint8Array>
  readonly unprotect: (ciphertext: Uint8Array) => Uint8Array | Promise<Uint8Array>
}>

/** AES-256-GCM protector for callers that already own a profile key. */
export const makeAes256GcmProtector = (key: Uint8Array): RollbackArtifactProtector => {
  if (key.byteLength !== 32)
    throw new RollbackArtifactError("encryption_unavailable", "Rollback artifact AES-256-GCM keys must be 32 bytes.")
  const secret = Buffer.from(key)
  return {
    protect: (plaintext) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", secret, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]))
    },
    unprotect: (ciphertext) => {
      if (ciphertext.byteLength < 28) throw new Error("rollback artifact encryption envelope is truncated")
      const decipher = createDecipheriv("aes-256-gcm", secret, ciphertext.subarray(0, 12))
      decipher.setAuthTag(ciphertext.subarray(12, 28))
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]))
    },
  }
}

export class RollbackArtifactError extends Error {
  readonly code:
    | "invalid_root"
    | "invalid_reference"
    | "too_large"
    | "digest_mismatch"
    | "length_mismatch"
    | "not_found"
    | "unsafe_entry"
    | "corrupt_artifact"
    | "quota_exceeded"
    | "encryption_required"
    | "encryption_unavailable"
    | "encryption_failed"
    | "io_error"
  readonly path?: string

  constructor(
    code:
      | "invalid_root"
      | "invalid_reference"
      | "too_large"
      | "digest_mismatch"
      | "length_mismatch"
      | "not_found"
      | "unsafe_entry"
      | "corrupt_artifact"
      | "quota_exceeded"
      | "encryption_required"
      | "encryption_unavailable"
      | "encryption_failed"
      | "io_error",
    message: string,
    path?: string,
  ) {
    super(message)
    this.name = "RollbackArtifactError"
    this.code = code
    this.path = path
  }
}

const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const artifactIDOf = (digest: string): `rollback-${string}` => `rollback-${digest}`

const validateDigest = (digest: string) => {
  if (!DIGEST.test(digest)) throw new RollbackArtifactError("invalid_reference", "Rollback artifact digest is invalid.")
}

/** Validate a durable reference without touching the filesystem. */
export const validateRollbackArtifactRef = (reference: RollbackArtifactRef): void => {
  if (
    reference.version !== 1 ||
    reference.artifactID !== artifactIDOf(reference.digest) ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 0
  )
    throw new RollbackArtifactError("invalid_reference", "Rollback artifact reference is invalid.")
  validateDigest(reference.digest)
}

/**
 * Collect and de-duplicate live references in a stable digest order.
 *
 * DurableAction replay is the source of truth. A conflicting byte length for
 * the same digest is treated as invalid history instead of choosing one
 * reference, so maintenance can never silently protect the wrong object.
 */
export const collectReferencedArtifacts = (
  sources: ReadonlyArray<RollbackArtifactReferenceSource>,
): ReadonlyArray<RollbackArtifactRef> => {
  const references = new Map<string, RollbackArtifactRef>()
  for (const source of sources) {
    for (const entry of source.mutationIntent?.entries ?? []) {
      const reference = entry.rollbackArtifact
      if (reference === undefined) continue
      validateRollbackArtifactRef(reference)
      const previous = references.get(reference.digest)
      if (previous !== undefined && previous.byteLength !== reference.byteLength)
        throw new RollbackArtifactError(
          "invalid_reference",
          "Durable rollback references disagree about an artifact length.",
        )
      references.set(reference.digest, reference)
    }
  }
  return [...references.values()].sort((left, right) => left.digest.localeCompare(right.digest))
}

const validateRoot = (root: string) => {
  const resolved = resolve(root)
  if (!isAbsolute(resolved) || resolved === dirname(resolved))
    throw new RollbackArtifactError("invalid_root", "Rollback artifact root must be a non-root absolute directory.")
  return resolved
}

/**
 * A small, content-addressed store for inverse file bytes.
 *
 * The store is deliberately not an EventV2 or DurableAction writer. Durable
 * records may keep only the returned reference and digest; callers must still
 * perform a fresh fingerprint and explicit CAS before using these bytes.
 */
export class RollbackArtifactStore {
  readonly root: string
  readonly maxArtifactBytes: number
  readonly maxTotalBytes: number
  readonly requireEncryption: boolean
  private readonly protector?: RollbackArtifactProtector

  constructor(options: RollbackArtifactStoreOptions) {
    this.root = validateRoot(options.root)
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes <= 0)
      throw new RollbackArtifactError("too_large", "Rollback artifact size limit must be a positive safe integer.")
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes <= 0)
      throw new RollbackArtifactError(
        "quota_exceeded",
        "Rollback artifact total quota must be a positive safe integer.",
      )
    this.protector = options.protector
    this.requireEncryption = options.requireEncryption ?? false
    if (this.requireEncryption && this.protector === undefined)
      throw new RollbackArtifactError(
        "encryption_unavailable",
        "This rollback artifact profile requires an at-rest protector, but none is configured.",
      )
  }

  private pathFor(digest: string) {
    validateDigest(digest)
    const candidate = resolve(this.root, `${artifactIDOf(digest)}.bin`)
    const containment = relative(this.root, candidate)
    if (isAbsolute(containment) || containment === ".." || containment.startsWith(`..${sep}`))
      throw new RollbackArtifactError("invalid_reference", "Rollback artifact path escaped its store root.")
    return candidate
  }

  private async ensureRoot() {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const entry = await lstat(this.root)
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new RollbackArtifactError("unsafe_entry", "Rollback artifact root is not a private directory.", this.root)
      // chmod is meaningful on Unix and harmlessly best-effort on Windows;
      // the store still remains profile-owned by construction.
      await chmod(this.root, 0o700).catch(() => undefined)
    } catch (error) {
      if (error instanceof RollbackArtifactError) throw error
      throw new RollbackArtifactError(
        "io_error",
        `Unable to create rollback artifact root: ${String(error)}`,
        this.root,
      )
    }
  }

  private async assertRegularFile(path: string) {
    try {
      const entry = await lstat(path)
      if (!entry.isFile())
        throw new RollbackArtifactError("unsafe_entry", "Rollback artifact is not a regular file.", path)
      return entry
    } catch (error) {
      if (error instanceof RollbackArtifactError) throw error
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new RollbackArtifactError("not_found", "Rollback artifact does not exist.", path)
      throw new RollbackArtifactError("io_error", `Unable to inspect rollback artifact: ${String(error)}`, path)
    }
  }

  private async encode(content: Uint8Array): Promise<Uint8Array> {
    if (this.protector === undefined) {
      if (this.requireEncryption)
        throw new RollbackArtifactError(
          "encryption_unavailable",
          "This rollback artifact profile refuses plaintext persistence.",
        )
      return content
    }
    try {
      const protectedBytes = await this.protector.protect(content)
      return new Uint8Array(Buffer.concat([Buffer.from(ENCRYPTED_ENVELOPE), Buffer.from(protectedBytes)]))
    } catch (error) {
      throw new RollbackArtifactError(
        "encryption_failed",
        `Unable to protect rollback artifact bytes: ${String(error)}`,
      )
    }
  }

  private async decode(payload: Uint8Array, path: string): Promise<Uint8Array> {
    const encrypted = ENCRYPTED_ENVELOPE.every((byte, index) => payload[index] === byte)
    if (!encrypted) {
      if (this.requireEncryption)
        throw new RollbackArtifactError(
          "encryption_required",
          "A plaintext rollback artifact was found in an encrypted profile.",
          path,
        )
      return payload
    }
    if (this.protector === undefined)
      throw new RollbackArtifactError(
        "encryption_unavailable",
        "An encrypted rollback artifact requires its profile protector.",
        path,
      )
    try {
      return new Uint8Array(await this.protector.unprotect(payload.subarray(ENCRYPTED_ENVELOPE.byteLength)))
    } catch (error) {
      throw new RollbackArtifactError(
        "encryption_failed",
        `Unable to unprotect rollback artifact bytes: ${String(error)}`,
        path,
      )
    }
  }

  private referenceDigests(references: ReadonlyArray<RollbackArtifactRef> | undefined) {
    const digests = new Set<string>()
    for (const reference of references ?? []) {
      validateRollbackArtifactRef(reference)
      digests.add(reference.digest)
    }
    return digests
  }

  async put(content: Uint8Array, expectedDigest?: string): Promise<RollbackArtifactRef> {
    if (content.byteLength > this.maxArtifactBytes)
      throw new RollbackArtifactError("too_large", "Rollback artifact exceeds the configured size limit.")
    const digest = digestOf(content)
    if (expectedDigest !== undefined && expectedDigest !== digest)
      throw new RollbackArtifactError(
        "digest_mismatch",
        "Rollback artifact content does not match its expected digest.",
      )
    const destination = this.pathFor(digest)
    await this.ensureRoot()
    const encoded = await this.encode(content)
    try {
      const existing = await lstat(destination)
      if (!existing.isFile())
        throw new RollbackArtifactError(
          "unsafe_entry",
          "Existing rollback artifact is not a regular file.",
          destination,
        )
      const current = await this.read({
        version: 1,
        artifactID: artifactIDOf(digest),
        digest,
        byteLength: content.byteLength,
      })
      if (current.content.byteLength !== content.byteLength || digestOf(current.content) !== digest)
        throw new RollbackArtifactError(
          "corrupt_artifact",
          "Existing rollback artifact failed integrity verification.",
          destination,
        )
      return current.ref
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof RollbackArtifactError) throw error
        throw new RollbackArtifactError(
          "io_error",
          `Unable to inspect existing rollback artifact: ${String(error)}`,
          destination,
        )
      }
    }

    const usage = await this.audit()
    if (usage.totalBytes + encoded.byteLength > this.maxTotalBytes)
      throw new RollbackArtifactError(
        "quota_exceeded",
        "Rollback artifact profile quota would be exceeded; remove unreferenced artifacts before retrying.",
      )

    const temporary = join(this.root, `.rollback-${randomUUID()}.tmp`)
    try {
      // wx prevents a symlink or another writer from replacing our staging file.
      await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 })
      await rename(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await this.read({
          version: 1,
          artifactID: artifactIDOf(digest),
          digest,
          byteLength: content.byteLength,
        })
        return existing.ref
      }
      throw new RollbackArtifactError(
        "io_error",
        `Unable to atomically store rollback artifact: ${String(error)}`,
        destination,
      )
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return { version: 1, artifactID: artifactIDOf(digest), digest, byteLength: content.byteLength }
  }

  async read(ref: RollbackArtifactRef): Promise<{ readonly ref: RollbackArtifactRef; readonly content: Uint8Array }> {
    validateRollbackArtifactRef(ref)
    const path = this.pathFor(ref.digest)
    await this.assertRegularFile(path)
    let content: Uint8Array
    try {
      content = await readFile(path)
    } catch (error) {
      throw new RollbackArtifactError("io_error", `Unable to read rollback artifact: ${String(error)}`, path)
    }
    const plaintext = await this.decode(content, path)
    if (plaintext.byteLength !== ref.byteLength)
      throw new RollbackArtifactError("length_mismatch", "Rollback artifact length does not match its reference.", path)
    if (digestOf(plaintext) !== ref.digest)
      throw new RollbackArtifactError("digest_mismatch", "Rollback artifact digest verification failed.", path)
    return { ref, content: plaintext }
  }

  async remove(ref: RollbackArtifactRef): Promise<void> {
    validateRollbackArtifactRef(ref)
    const path = this.pathFor(ref.digest)
    await rm(path, { force: true }).catch((error) => {
      throw new RollbackArtifactError("io_error", `Unable to remove rollback artifact: ${String(error)}`, path)
    })
  }

  async audit(options: RollbackArtifactAuditOptions = {}): Promise<RollbackArtifactAudit> {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const nowMs = options.nowMs ?? Date.now()
    const maxTotalBytes = options.maxTotalBytes ?? this.maxTotalBytes
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
      throw new RollbackArtifactError("invalid_reference", "Rollback artifact retention age is invalid.")
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0)
      throw new RollbackArtifactError("quota_exceeded", "Rollback artifact total quota must be positive.")
    const references = this.referenceDigests(options.referenced)
    await this.ensureRoot()
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      throw new RollbackArtifactError("io_error", `Unable to list rollback artifacts: ${String(error)}`, this.root)
    }

    let artifactCount = 0
    let totalBytes = 0
    let referencedCount = 0
    let orphanCount = 0
    let expiredOrphanCount = 0
    let invalidCount = 0
    let unsafeCount = 0
    let corruptCount = 0
    const presentDigests = new Set<string>()

    for (const name of names) {
      const match = ARTIFACT_NAME.exec(name)
      if (!match) {
        // Temporary staging files are intentionally ignored; malformed
        // rollback-looking names are surfaced for operator cleanup.
        if (name.startsWith("rollback-")) invalidCount += 1
        continue
      }
      const path = join(this.root, name)
      let entry
      try {
        entry = await lstat(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        unsafeCount += 1
        continue
      }
      presentDigests.add(match[1])
      if (!entry.isFile() || entry.isSymbolicLink()) {
        unsafeCount += 1
        continue
      }
      artifactCount += 1
      totalBytes += entry.size
      let valid = false
      try {
        const payload = await readFile(path)
        const plaintext = await this.decode(payload, path)
        valid = plaintext.byteLength <= this.maxArtifactBytes && digestOf(plaintext) === match[1]
      } catch {
        valid = false
      }
      if (!valid) {
        corruptCount += 1
        continue
      }
      if (references.has(match[1])) {
        referencedCount += 1
        continue
      }
      orphanCount += 1
      if (nowMs - entry.mtimeMs >= maxAgeMs) expiredOrphanCount += 1
    }

    return {
      scannedEntries: names.length,
      artifactCount,
      totalBytes,
      referencedCount,
      orphanCount,
      expiredOrphanCount,
      missingReferenceCount: [...references].filter((digest) => !presentDigests.has(digest)).length,
      invalidCount,
      unsafeCount,
      corruptCount,
      overQuota: totalBytes > maxTotalBytes,
    }
  }

  async sweepDetailed(options: RollbackArtifactSweepOptions = {}): Promise<RollbackArtifactSweepReport> {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const nowMs = options.nowMs ?? Date.now()
    const maxTotalBytes = options.maxTotalBytes ?? this.maxTotalBytes
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
      throw new RollbackArtifactError("invalid_reference", "Rollback artifact retention age is invalid.")
    if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0)
      throw new RollbackArtifactError("quota_exceeded", "Rollback artifact total quota must be positive.")
    const references = this.referenceDigests(options.referenced)
    const before = await this.audit({ ...options, maxAgeMs, nowMs, maxTotalBytes })
    await this.ensureRoot()
    const names = await readdir(this.root).catch((error) => {
      throw new RollbackArtifactError("io_error", `Unable to list rollback artifacts: ${String(error)}`, this.root)
    })
    const candidates: Array<{
      readonly path: string
      readonly size: number
      readonly mtimeMs: number
      readonly digest: string
    }> = []
    for (const name of names) {
      const match = ARTIFACT_NAME.exec(name)
      if (!match || references.has(match[1])) continue
      const path = join(this.root, name)
      try {
        const entry = await lstat(path)
        if (!entry.isFile() || entry.isSymbolicLink()) continue
        const plaintext = await this.decode(await readFile(path), path)
        if (plaintext.byteLength > this.maxArtifactBytes || digestOf(plaintext) !== match[1]) continue
        candidates.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, digest: match[1] })
      } catch {
        // Corrupt/unsafe artifacts remain for an explicit operator decision.
      }
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.digest.localeCompare(right.digest))
    let projectedBytes = before.totalBytes
    let removed = 0
    for (const candidate of candidates) {
      const expired = nowMs - candidate.mtimeMs >= maxAgeMs
      const quotaPressure = options.enforceQuota === true && projectedBytes > maxTotalBytes
      if (!expired && !quotaPressure) continue
      try {
        await rm(candidate.path)
        projectedBytes = Math.max(0, projectedBytes - candidate.size)
        removed += 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new RollbackArtifactError(
            "io_error",
            `Unable to remove rollback artifact: ${String(error)}`,
            candidate.path,
          )
      }
    }
    const after = await this.audit({ ...options, maxAgeMs, nowMs, maxTotalBytes })
    return { ...after, removed }
  }

  /** Backward-compatible count-only retention API. */
  async sweep(options: RollbackArtifactSweepOptions = {}): Promise<number> {
    return (await this.sweepDetailed(options)).removed
  }
}

export interface Interface {
  /** The profile-owned store used by mutation tools; callers never receive a workspace path. */
  readonly store: RollbackArtifactStore
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/RollbackArtifact") {}

const environmentProtector = (): RollbackArtifactProtector | undefined => {
  const encoded = process.env.ARFORGE_ROLLBACK_ARTIFACT_KEY?.trim()
  if (!encoded) return undefined
  const key = /^[a-f\d]{64}$/i.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64")
  if (key.byteLength !== 32)
    throw new RollbackArtifactError(
      "encryption_unavailable",
      "ARFORGE_ROLLBACK_ARTIFACT_KEY must contain a 32-byte key.",
    )
  return makeAes256GcmProtector(key)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const protector = environmentProtector()
    return Service.of({
      store: new RollbackArtifactStore({
        root: join(global.tmp, "rollback-artifacts"),
        ...(protector === undefined ? {} : { protector }),
        requireEncryption: process.env.ARFORGE_ROLLBACK_ARTIFACT_REQUIRE_ENCRYPTION === "1",
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

/** Test/isolated-runtime constructor; production uses the profile-owned node above. */
export const layerWith = (root: string, maxArtifactBytes?: number) =>
  Layer.succeed(Service, Service.of({ store: new RollbackArtifactStore({ root, maxArtifactBytes }) }))
