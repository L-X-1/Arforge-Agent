import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  collectReferencedArtifacts,
  makeAes256GcmProtector,
  RollbackArtifactError,
  RollbackArtifactStore,
  type RollbackArtifactStoreOptions,
} from "@arforge-ai/core/runtime/rollback-artifact"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const store = async (options: number | Omit<RollbackArtifactStoreOptions, "root"> = {}) => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "arforge-rollback-artifact-"))
  roots.push(root)
  return new RollbackArtifactStore({
    root,
    ...(typeof options === "number" ? { maxArtifactBytes: options } : options),
  })
}

describe("RollbackArtifactStore", () => {
  test("collects live durable references deterministically and rejects conflicting metadata", async () => {
    const artifacts = await store()
    const first = await artifacts.put(new TextEncoder().encode("first"))
    const second = await artifacts.put(new TextEncoder().encode("second"))
    const sources = [
      { mutationIntent: { entries: [{ rollbackArtifact: second }, { rollbackArtifact: first }] } },
      { mutationIntent: { entries: [{ rollbackArtifact: second }] } },
    ]

    expect(collectReferencedArtifacts(sources)).toEqual(
      [first, second].sort((left, right) => left.digest.localeCompare(right.digest)),
    )
    expect(() =>
      collectReferencedArtifacts([
        {
          mutationIntent: {
            entries: [
              {
                rollbackArtifact: { ...first, byteLength: first.byteLength + 1 },
              },
            ],
          },
        },
        { mutationIntent: { entries: [{ rollbackArtifact: first }] } },
      ]),
    ).toThrow(RollbackArtifactError)
  })

  test("stores content-addressed bytes atomically and reads an integrity-checked reference", async () => {
    const artifacts = await store()
    const content = new TextEncoder().encode("secret preimage\n")
    const first = await artifacts.put(content)
    const second = await artifacts.put(content)

    expect(second).toEqual(first)
    expect(await artifacts.read(first)).toMatchObject({ ref: first, content })
    expect((await readdir(artifacts.root)).filter((name) => name.endsWith(".bin"))).toHaveLength(1)
  })

  test("rejects oversized or digest-mismatched bytes before persistence", async () => {
    const artifacts = await store(4)
    await expect(artifacts.put(new TextEncoder().encode("12345"))).rejects.toMatchObject({ code: "too_large" })
    await expect(artifacts.put(new TextEncoder().encode("1234"), "0".repeat(64))).rejects.toMatchObject({
      code: "digest_mismatch",
    })
    expect(await readdir(artifacts.root).catch(() => [])).toEqual([])
  })

  test("detects tampering and rejects path-like references", async () => {
    const artifacts = await store()
    const ref = await artifacts.put(new TextEncoder().encode("original"))
    await writeFile(join(artifacts.root, `${ref.artifactID}.bin`), "tampered")
    await expect(artifacts.read(ref)).rejects.toMatchObject({ code: "digest_mismatch" })

    const traversal = {
      version: 1 as const,
      artifactID: "rollback-../escape" as `rollback-${string}`,
      digest: "a".repeat(64),
      byteLength: 1,
    }
    await expect(artifacts.read(traversal)).rejects.toBeInstanceOf(RollbackArtifactError)
  })

  test("sweeps only expired regular artifact entries and leaves temporary files alone", async () => {
    const artifacts = await store()
    const ref = await artifacts.put(new TextEncoder().encode("old"))
    await writeFile(join(artifacts.root, ".rollback-orphan.tmp"), "orphan")
    const now = Date.now()
    expect(await artifacts.sweep({ maxAgeMs: 0, nowMs: now + 1_000 })).toBe(1)
    expect(await readdir(artifacts.root)).toEqual([".rollback-orphan.tmp"])
  })

  test("audits orphans and never evicts a durable reference during retention", async () => {
    const artifacts = await store()
    const referenced = await artifacts.put(new TextEncoder().encode("keep"))
    const orphan = await artifacts.put(new TextEncoder().encode("orphan"))
    const old = new Date(Date.now() - 60_000)
    await Promise.all([
      utimes(join(artifacts.root, `${referenced.artifactID}.bin`), old, old),
      utimes(join(artifacts.root, `${orphan.artifactID}.bin`), old, old),
    ])

    const audit = await artifacts.audit({ referenced: [referenced], maxAgeMs: 1, nowMs: Date.now() })
    expect(audit).toMatchObject({
      artifactCount: 2,
      referencedCount: 1,
      orphanCount: 1,
      expiredOrphanCount: 1,
      missingReferenceCount: 0,
      corruptCount: 0,
    })
    const swept = await artifacts.sweepDetailed({ referenced: [referenced], maxAgeMs: 1, nowMs: Date.now() })
    expect(swept.removed).toBe(1)
    expect(await artifacts.read(referenced)).toMatchObject({ ref: referenced })
    await expect(artifacts.read(orphan)).rejects.toMatchObject({ code: "not_found" })
  })

  test("enforces the profile quota before writing and can report quota pressure", async () => {
    const artifacts = await store({ maxTotalBytes: 8 })
    await artifacts.put(new TextEncoder().encode("1234"))
    await artifacts.put(new TextEncoder().encode("5678"))
    await expect(artifacts.put(new TextEncoder().encode("9"))).rejects.toMatchObject({ code: "quota_exceeded" })
    expect((await artifacts.audit()).overQuota).toBe(false)
  })

  test("supports an explicit encrypted-at-rest profile without exposing plaintext to the store file", async () => {
    const protector = makeAes256GcmProtector(new Uint8Array(32).fill(0x5a))
    const artifacts = await store({ protector, requireEncryption: true })
    const ref = await artifacts.put(new TextEncoder().encode("sensitive preimage"))
    const raw = await readFile(join(artifacts.root, `${ref.artifactID}.bin`))
    expect(new TextDecoder().decode(raw)).not.toContain("sensitive preimage")
    expect(new TextDecoder().decode((await artifacts.read(ref)).content)).toBe("sensitive preimage")

    const unprotected = new RollbackArtifactStore({ root: artifacts.root })
    await expect(unprotected.read(ref)).rejects.toMatchObject({ code: "encryption_unavailable" })
  })
})
