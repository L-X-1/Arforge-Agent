import { describe, expect } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir as osTmpdir } from "node:os"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Global } from "@arforge-ai/core/global"
import { Config } from "@arforge-ai/core/config"
import { ConfigToolOutput } from "@arforge-ai/core/config/tool-output"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { OpaqueArtifact } from "@arforge-ai/core/runtime/artifact-ref"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

// Keep the cap-pressure fixture independent from the store's private
// canonicalizer while using the same canonical JSON contract as the persisted
// hash chain.  It lets the regression test seed one full catalog without
// performing ten thousand quadratic append-and-rewrite operations.
const canonicalCatalog = (value: unknown): string => {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalCatalog).join(",")}]`
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCatalog((value as Record<string, unknown>)[key])}`)
      .join(",")}}`
  throw new Error("unsupported catalog fixture value")
}

const catalogFixtureDigest = (value: unknown) => createHash("sha256").update(canonicalCatalog(value)).digest("hex")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty

      const store = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.node, FSUtil.node]), [
        [Global.node, global],
        [Config.node, configured],
      ])
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(store))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live("reuses one verified bounded receipt for concurrent and repeated identical calls", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const request = {
          sessionID,
          toolCallID: "call-stable-bound",
          output: { structured: {}, content: [{ type: "text" as const, text: "中".repeat(30_000) }] },
        }
        const first = yield* store.bound(request)
        const before = yield* store.listCatalog()
        const repeated = yield* Effect.all(
          Array.from({ length: 4 }, () => store.bound(request)),
          { concurrency: "unbounded" },
        )
        for (const result of repeated) expect(result).toEqual(first)
        expect((yield* store.listCatalog()).headSequence).toBe(before.headSequence)
        const otherCall = yield* store.bound({ ...request, toolCallID: "call-different-bound" })
        const otherOwner = yield* store.bound({
          ...request,
          owner: { scope: "profile", id: "profile-different-bound" },
        })
        expect(otherCall.artifactRefs?.[0]?.retrievalHint).not.toEqual(first.artifactRefs?.[0]?.retrievalHint)
        expect(otherOwner.artifactRefs?.[0]?.retrievalHint).not.toEqual(first.artifactRefs?.[0]?.retrievalHint)
      }),
    ),
  )

  for (const damage of ["bytes", "index", "expiry"] as const) {
    it.live(`never silently replaces an invalid bounded receipt during replay (${damage})`, () =>
      withStore(({ store, fs, root }) =>
        Effect.gen(function* () {
          const request = {
            sessionID,
            toolCallID: "call-bound-damage",
            output: { structured: {}, content: [{ type: "text" as const, text: "中".repeat(30_000) }] },
          }
          const first = yield* store.bound(request)
          const reference = first.artifactRefs?.[0]
          if (!reference) throw new Error("missing bounded receipt")
          const indexPath = path.join(
            root,
            ToolOutputStore.MANAGED_DIRECTORY,
            ToolOutputStore.INDEX_DIRECTORY,
            `${reference.retrievalHint.handle}.json`,
          )
          if (damage === "bytes") yield* fs.writeFileString(first.outputPaths[0], "tampered")
          if (damage === "index") yield* fs.remove(indexPath)
          if (damage === "expiry") {
            const indexed = (yield* fs.readJson(indexPath)) as Record<string, unknown>
            yield* fs.writeJson(indexPath, { ...indexed, retention: { mode: "session", expiresAt: 0 } })
          }
          const before = yield* store.listCatalog()
          expect(Exit.isFailure(yield* store.bound(request).pipe(Effect.exit))).toBe(true)
          expect((yield* store.listCatalog()).headSequence).toBe(before.headSequence)
        }),
      ),
    )
  }

  for (const sameOwner of [true, false]) {
    it.live(
      `retains identical bytes as distinct immutable receipts without catalog collisions (sameOwner=${sameOwner})`,
      () =>
        withStore(({ store }) =>
          Effect.gen(function* () {
            const firstOwner = { scope: "session" as const, id: "ses_receipt_a" }
            const secondOwner = sameOwner ? firstOwner : { scope: "session" as const, id: "ses_receipt_b" }
            const bytes = new TextEncoder().encode("identical artifact bytes")
            const first = yield* store.bindBytes({ bytes, owner: firstOwner, kind: "test", mime: "text/plain" })
            const second = yield* store.bindBytes({ bytes, owner: secondOwner, kind: "test", mime: "text/plain" })
            expect(first.artifactID).toBe(second.artifactID)
            expect(first.retrievalHint.handle).not.toBe(second.retrievalHint.handle)
            expect((yield* store.read({ reference: first, owner: firstOwner })).bytes).toEqual(bytes)
            expect((yield* store.read({ reference: second, owner: secondOwner })).bytes).toEqual(bytes)
            expect((yield* store.listCatalog()).entries).toHaveLength(2)
            expect((yield* store.listCatalog({ owner: firstOwner })).entries).toHaveLength(sameOwner ? 2 : 1)
            if (!sameOwner)
              expect(
                Exit.isFailure(yield* store.read({ reference: first, owner: secondOwner }).pipe(Effect.exit)),
              ).toBe(true)
          }),
        ),
    )
  }

  it.live("reads a v1 catalogue without rewriting it and preserves its audit prefix on the next receipt", () =>
    withStore(({ store, fs, root }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: "ses_old_catalog" }
        const bytes = new TextEncoder().encode("old catalogue bytes")
        const first = yield* store.bindBytes({ bytes, owner, kind: "test", mime: "text/plain" })
        const file = path.join(
          root,
          ToolOutputStore.MANAGED_DIRECTORY,
          ToolOutputStore.CATALOG_DIRECTORY,
          ToolOutputStore.CATALOG_STATE_FILE,
        )
        const saved = JSON.parse(yield* fs.readFileString(file)) as {
          schemaVersion: number
          entries: Record<string, unknown>
          audit: unknown[]
        }
        const legacy = { ...saved, schemaVersion: 1, entries: { [first.artifactID]: Object.values(saved.entries)[0] } }
        yield* fs.writeJson(file, legacy)
        const before = yield* fs.readFileString(file)
        expect((yield* store.listCatalog()).entries[0]?.reference).toEqual(first)
        expect((yield* store.read({ reference: first, owner })).bytes).toEqual(bytes)
        expect(yield* fs.readFileString(file)).toBe(before)
        const second = yield* store.bindBytes({ bytes, owner, kind: "test", mime: "text/plain" })
        const after = JSON.parse(yield* fs.readFileString(file)) as typeof saved
        expect(after.schemaVersion).toBe(2)
        expect(after.entries[first.artifactID]).toEqual(legacy.entries[first.artifactID])
        expect(after.entries[second.retrievalHint.handle]).toBeDefined()
        expect(after.audit.slice(0, legacy.audit.length)).toEqual(legacy.audit)
        expect((yield* store.listCatalog()).entries).toHaveLength(2)
      }),
    ),
  )

  it.live("cleanup targets an expired receipt without deleting live identical bytes and stays idempotent", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: "ses_same_bytes_cleanup" }
        const bytes = new TextEncoder().encode("same bytes with different retention")
        const expired = yield* store.bindBytes({
          bytes,
          owner,
          kind: "test",
          mime: "text/plain",
          retention: { mode: "ephemeral", expiresAt: DateTime.makeUnsafe(Date.now() - 1) },
        })
        const live = yield* store.bindBytes({
          bytes,
          owner,
          kind: "test",
          mime: "text/plain",
          retention: { mode: "durable" },
        })
        yield* store.cleanup()
        yield* store.cleanup()
        expect(Exit.isFailure(yield* store.read({ reference: expired, owner }).pipe(Effect.exit))).toBe(true)
        expect((yield* store.read({ reference: live, owner })).bytes).toEqual(bytes)
        expect((yield* store.listAudit({ owner })).filter((entry) => entry.action === "removed")).toHaveLength(1)
      }),
    ),
  )

  it.live("redacts secret-shaped text before returning or persisting output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const secret = "sk-" + "a".repeat(24)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-redacted",
          output: { structured: { token: secret }, content: [{ type: "text", text: `value=${secret}` }] },
        })
        expect(JSON.stringify(result.output)).not.toContain(secret)
        expect(JSON.stringify(result.output)).toContain("[REDACTED_SECRET]")
        expect(result.outputPaths).toEqual([])
        void fs
      }),
    ),
  )

  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        expect(result.artifactRefs).toHaveLength(1)
        const reference = result.artifactRefs?.[0]
        expect(reference).toBeDefined()
        if (!reference) throw new Error("expected opaque artifact reference")
        expect(reference?.kind).toBe("tool_output")
        expect(reference?.mime).toBe("text/plain")
        expect(reference?.sizeBytes).toBe(Buffer.byteLength(first + second, "utf8"))
        expect(reference?.owner).toEqual({ scope: "session", id: sessionID })
        expect(reference?.retrievalHint.handle).not.toContain("/")
        expect(reference?.retrievalHint.handle).not.toContain("\\")
        expect(JSON.stringify(reference)).not.toContain(result.outputPaths[0])
        expect(OpaqueArtifact.validate(reference)).toEqual(reference)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(result.output.content[0].text).not.toContain(result.outputPaths[0])
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("resolves opaque receipts through a durable index with owner, retention, and digest checks", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const text = "receipt-" + "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-resolve",
          output: { structured: {}, content: [{ type: "text", text }] },
        })
        const reference = result.artifactRefs?.[0]
        if (!reference) throw new Error("expected opaque artifact reference")

        const resolved = yield* store.read({ reference, owner: { scope: "session", id: sessionID } })
        expect(resolved.reference).toEqual(reference)
        expect(new TextDecoder().decode(resolved.bytes)).toBe(text)
        const indexPath = path.join(
          root,
          ToolOutputStore.MANAGED_DIRECTORY,
          ToolOutputStore.INDEX_DIRECTORY,
          `${reference.retrievalHint.handle}.json`,
        )
        expect(yield* fs.exists(indexPath)).toBe(true)
        expect(JSON.stringify(yield* fs.readJson(indexPath))).not.toContain(root)

        const denied = yield* store
          .read({ reference, owner: { scope: "session", id: "ses_other_owner" } })
          .pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)

        const indexed = yield* fs.readJson(indexPath)
        yield* fs.writeJson(indexPath, {
          ...(indexed as Record<string, unknown>),
          retention: { mode: "session", expiresAt: 0 },
        })
        const expired = yield* store.read({ reference, owner: { scope: "session", id: sessionID } }).pipe(Effect.exit)
        expect(Exit.isFailure(expired)).toBe(true)
      }),
    ),
  )

  it.live("uses the same receipt store for profile-owned output without widening session reads", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const profileOwner = { scope: "profile" as const, id: "usr_profile" }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-profile-owner",
          owner: profileOwner,
          output: {
            structured: {},
            content: [{ type: "text", text: "p".repeat(ToolOutputStore.MAX_BYTES + 1) }],
          },
        })
        const reference = result.artifactRefs?.[0]
        if (!reference) throw new Error("expected profile-owned opaque artifact reference")
        expect(reference.owner).toEqual(profileOwner)
        expect(reference.retention.mode).toBe("durable")
        expect(yield* store.read({ reference, owner: profileOwner })).toEqual(expect.objectContaining({ reference }))
        const denied = yield* store
          .read({ reference, owner: { scope: "session", id: String(sessionID) } })
          .pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
      }),
    ),
  )

  it.live("reads bounded resumable ranges only after complete receipt verification", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "0123456789".repeat(6_000)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-range",
          output: { structured: {}, content: [{ type: "text", text }] },
        })
        const reference = result.artifactRefs?.[0]
        if (!reference) throw new Error("expected opaque artifact reference")

        const range = yield* store.readRange({
          reference,
          owner: { scope: "session", id: sessionID },
          offset: 7,
          length: 11,
        })
        expect(new TextDecoder().decode(range.bytes)).toBe(text.slice(7, 18))
        expect(range.offset).toBe(7)
        expect(range.endExclusive).toBe(18)
        expect(range.totalBytes).toBe(Buffer.byteLength(text, "utf8"))

        const outside = yield* store
          .readRange({
            reference,
            owner: { scope: "session", id: sessionID },
            offset: reference.sizeBytes,
            length: 1,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(outside)).toBe(true)

        const oversized = yield* store
          .readRange({
            reference,
            owner: { scope: "session", id: sessionID },
            offset: 0,
            length: ToolOutputStore.MAX_RANGE_BYTES + 1,
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(oversized)).toBe(true)
      }),
    ),
  )

  it.live("persists a cross-process catalog and hash-chained audit sequence", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: sessionID }
        const first = yield* store.bound({
          sessionID,
          toolCallID: "call-catalog-first",
          output: { structured: {}, content: [{ type: "text", text: "a".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
        })
        const second = yield* store.bound({
          sessionID,
          toolCallID: "call-catalog-second",
          output: { structured: {}, content: [{ type: "text", text: "b".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
        })
        const firstReference = first.artifactRefs?.[0]
        const secondReference = second.artifactRefs?.[0]
        if (!firstReference || !secondReference) throw new Error("expected catalog artifact references")

        const initialAudit = yield* store.listAudit({ owner })
        expect(initialAudit.map((record) => record.sequence).sort((a, b) => a - b)).toEqual([1, 2])
        expect(
          initialAudit.every(
            (record) => record.previousHash === "genesis" || /^[a-f0-9]{64}$/.test(record.previousHash),
          ),
        ).toBe(true)

        const page = yield* store.listCatalog({ owner, limit: 1 })
        expect(page.entries).toHaveLength(1)
        expect(page.nextSequence).toBeDefined()
        expect(page.headSequence).toBe(2)
        expect(page.droppedAuditEntries).toBe(0)
        const older = yield* store.listCatalog({ owner, beforeSequence: page.nextSequence })
        expect(older.entries).toHaveLength(1)
        expect(older.entries[0]?.reference.artifactID).not.toBe(page.entries[0]?.reference.artifactID)

        const reads = yield* Effect.forEach(
          ["read", "range", "read", "range"] as const,
          (action) => store.recordAudit({ actor: "test-worker", action, reference: firstReference }),
          { concurrency: 4 },
        )
        expect(new Set(reads.map((record) => record.sequence)).size).toBe(4)
        const allAudit = yield* store.listAudit({ owner, limit: 100 })
        const ascending = allAudit.slice().sort((left, right) => left.sequence - right.sequence)
        expect(ascending.map((record) => record.sequence)).toEqual([1, 2, 3, 4, 5, 6])
        for (let index = 1; index < ascending.length; index++)
          expect(ascending[index]?.previousHash).toBe(ascending[index - 1]?.recordHash)
        const catalog = yield* store.listCatalog({ owner, limit: 100 })
        expect(
          catalog.entries.find((entry) => entry.reference.artifactID === firstReference.artifactID)?.readCount,
        ).toBe(4)
        expect(
          catalog.entries.find((entry) => entry.reference.artifactID === secondReference.artifactID)?.readCount,
        ).toBe(0)

        const drifted = { ...firstReference, digest: "0".repeat(64) } as ToolOutputStore.ArtifactAuditInput["reference"]
        const rejected = yield* store
          .recordAudit({ actor: "test-worker", action: "read", reference: drifted })
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
      }),
    ),
  )

  it.live("imports binary primary-delivery bytes through the same opaque receipt owner", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: sessionID }
        const bytes = new TextEncoder().encode("primary attachment")
        const reference = yield* store.bindBytes({
          bytes,
          owner,
          kind: "primary_delivery",
          mime: "text/plain",
          label: "attachment.txt",
        })
        expect(reference.kind).toBe("primary_delivery")
        expect(reference.owner).toEqual(owner)
        expect(reference.sizeBytes).toBe(bytes.byteLength)
        expect(reference.retrievalHint.handle).toMatch(/^artifact_/)
        expect(yield* store.read({ reference, owner, maxBytes: 1024 })).toMatchObject({ reference })
        expect(yield* store.listCatalog({ owner })).toMatchObject({
          entries: [expect.objectContaining({ reference, readCount: 0 })],
          headSequence: 1,
        })
      }),
    ),
  )

  for (const sameCall of [false, true]) {
    it.live(
      `serializes catalog registration across independent operating-system processes (sameCall=${sameCall})`,
      () =>
        Effect.promise(async () => {
          const root = mkdtempSync(join(osTmpdir(), "arforge-artifact-catalog-process-"))
          const state = join(root, "state")
          try {
            const workers = (sameCall ? ["shared", "shared", "shared", "shared"] : ["one", "two", "three", "four"]).map(
              (workerID) =>
                Bun.spawn([process.execPath, "test/fixture/artifact-catalog-worker.ts", root, state, workerID], {
                  cwd: join(import.meta.dir, ".."),
                  stdout: "pipe",
                  stderr: "pipe",
                }),
            )
            const results = await Promise.all(
              workers.map(async (worker) => {
                const [exitCode, stdout, stderr] = await Promise.all([
                  worker.exited,
                  new Response(worker.stdout).text(),
                  new Response(worker.stderr).text(),
                ])
                return { exitCode, stdout, stderr }
              }),
            )
            for (const result of results) expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)

            const statePath = join(
              root,
              ToolOutputStore.MANAGED_DIRECTORY,
              ToolOutputStore.CATALOG_DIRECTORY,
              "state.json",
            )
            const catalog = JSON.parse(readFileSync(statePath, "utf8")) as {
              readonly nextSequence: number
              readonly headHash: string
              readonly entries: Record<string, unknown>
              readonly audit: ReadonlyArray<{
                readonly sequence: number
                readonly previousHash: string
                readonly recordHash: string
                readonly action: string
              }>
            }
            expect(Object.keys(catalog.entries)).toHaveLength(sameCall ? 1 : 4)
            expect(catalog.audit.map((record) => record.sequence)).toEqual(sameCall ? [1] : [1, 2, 3, 4])
            expect(catalog.nextSequence).toBe(sameCall ? 2 : 5)
            expect(catalog.audit.every((record) => record.action === "registered")).toBe(true)
            expect(catalog.audit[0]?.previousHash).toBe("genesis")
            for (let index = 1; index < catalog.audit.length; index++)
              expect(catalog.audit[index]?.previousHash).toBe(catalog.audit[index - 1]?.recordHash)
            const tail = catalog.audit.at(-1)
            if (!tail) throw new Error("expected a registered receipt")
            expect(catalog.headHash).toBe(tail.recordHash)
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }),
      90_000,
    )
  }

  it.live("fails closed when the persistent catalog hash chain is corrupted", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-catalog-corrupt",
          output: { structured: {}, content: [{ type: "text", text: "c".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
        })
        expect(result.artifactRefs).toHaveLength(1)
        const statePath = path.join(
          root,
          ToolOutputStore.MANAGED_DIRECTORY,
          ToolOutputStore.CATALOG_DIRECTORY,
          ToolOutputStore.CATALOG_STATE_FILE,
        )
        const state = yield* fs.readJson(statePath)
        yield* fs.writeJson(statePath, { ...(state as Record<string, unknown>), headHash: "genesis" })
        const exit = yield* store.listAudit().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("records idempotent removed events when catalog artifacts expire", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: sessionID }
        const reference = yield* store.bindBytes({
          bytes: new TextEncoder().encode("expired attachment"),
          owner,
          kind: "primary_delivery",
          mime: "text/plain",
          retention: { mode: "session", expiresAt: DateTime.makeUnsafe(Date.now() - 1) },
        })
        const file = path.join(root, ToolOutputStore.MANAGED_DIRECTORY, reference.retrievalHint.handle)
        const index = path.join(
          root,
          ToolOutputStore.MANAGED_DIRECTORY,
          ToolOutputStore.INDEX_DIRECTORY,
          `${reference.retrievalHint.handle}.json`,
        )
        expect(yield* fs.exists(file)).toBe(true)
        expect(yield* fs.exists(index)).toBe(true)

        yield* store.cleanup()
        expect(yield* fs.exists(file)).toBe(false)
        expect(yield* fs.exists(index)).toBe(false)
        const firstAudit = yield* store.listAudit({ owner, limit: 20 })
        expect(firstAudit.filter((record) => record.action === "removed")).toMatchObject([
          { artifactID: reference.artifactID, reason: "retention_expired" },
        ])

        // A repeated hourly tick must not append a second removal for the
        // same immutable receipt.
        yield* store.cleanup()
        const secondAudit = yield* store.listAudit({ owner, limit: 20 })
        expect(secondAudit.filter((record) => record.action === "removed")).toHaveLength(1)
        expect(yield* store.listCatalog({ owner })).toMatchObject({ entries: [expect.objectContaining({ reference })] })
      }),
    ),
  )

  it.live("evicts the oldest removed catalog tombstone before a new receipt hits the entry cap", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const owner = { scope: "profile" as const, id: "profile-catalog-cap" }
        const entries: Record<string, unknown> = {}
        const audit: Array<Record<string, unknown>> = []
        let previousHash = "genesis"
        for (let index = 0; index < ToolOutputStore.CATALOG_MAX_ENTRIES; index++) {
          const digest = (index + 1).toString(16).padStart(64, "0")
          const handle = `artifact_catalog_seed_${index}`
          const reference = OpaqueArtifact.make({
            version: 1,
            kind: "fixture",
            digest,
            mime: "text/plain",
            sizeBytes: 0,
            owner,
            retention: { mode: "durable" },
            retrievalHint: { kind: "managed", handle },
            createdAt: DateTime.makeUnsafe(index + 1),
          })
          const sequence = index + 1
          const event = {
            sequence,
            recordedAt: index + 1,
            actor: "fixture",
            action: index === 0 ? "removed" : "registered",
            artifactID: String(reference.artifactID),
            digest,
            owner,
            previousHash,
          }
          const recordHash = catalogFixtureDigest(event)
          audit.push({ ...event, recordHash })
          entries[handle] = {
            reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
            firstSeenAt: index + 1,
            lastSeenAt: index + 1,
            lastSequence: sequence,
            readCount: 0,
            ...(index === 0 ? { removed: true } : {}),
          }
          previousHash = recordHash
        }

        const statePath = path.join(
          root,
          ToolOutputStore.MANAGED_DIRECTORY,
          ToolOutputStore.CATALOG_DIRECTORY,
          ToolOutputStore.CATALOG_STATE_FILE,
        )
        yield* fs.ensureDir(path.dirname(statePath))
        yield* fs.writeJson(statePath, {
          schemaVersion: 2,
          revision: ToolOutputStore.CATALOG_MAX_ENTRIES,
          nextSequence: ToolOutputStore.CATALOG_MAX_ENTRIES + 1,
          headHash: previousHash,
          chainAnchor: "genesis",
          droppedAuditEntries: 0,
          entries,
          audit,
        })

        const fresh = yield* store.bindBytes({
          bytes: new TextEncoder().encode("new artifact after tombstone pressure"),
          owner,
          kind: "test",
          mime: "text/plain",
        })
        const saved = (yield* fs.readJson(statePath)) as {
          entries: Record<string, unknown>
          droppedAuditEntries: number
        }
        expect(Object.keys(saved.entries)).toHaveLength(ToolOutputStore.CATALOG_MAX_ENTRIES)
        expect(saved.entries["artifact_catalog_seed_0"]).toBeUndefined()
        expect(saved.entries[fresh.retrievalHint.handle]).toBeDefined()
        expect(saved.droppedAuditEntries).toBe(1)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("preserves native media and structured metadata without applying a settlement media limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.artifactRefs).toBeUndefined()
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          uri: `data:image/png;base64,${data}`,
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("retains MCP rich media through one stable opaque Artifact receipt", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: String(sessionID) }
        const output = {
          structured: {
            title: "MCP resource",
            output: "A remote image",
            metadata: {
              source: "mcp-capability-registry",
              kind: "resource",
              server: "docs",
              uri: "docs://readme",
            },
          },
          content: [
            { type: "text" as const, text: "A remote image" },
            { type: "file" as const, uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "readme.png" },
          ],
        }
        const request = { sessionID, toolCallID: "call-mcp-rich", output }
        const first = yield* store.bound(request)
        const reference = first.artifactRefs?.[0]
        if (!reference) throw new Error("MCP rich result did not produce an artifact receipt")
        expect(first.outputPaths).toEqual([])
        expect(reference.kind).toBe("mcp_resource")
        expect(reference.mime).toBe("image/png")
        expect(reference.sizeBytes).toBe(5)
        expect(reference.label).toBe("mcp:docs:resource:0")
        expect((yield* store.read({ reference, owner })).bytes).toEqual(new TextEncoder().encode("hello"))

        const repeated = yield* store.bound(request)
        expect(repeated).toEqual(first)
        expect((yield* store.listAudit()).filter((record) => record.action === "registered")).toHaveLength(1)
      }),
    ),
  )

  it.live("fails closed when an MCP rich attachment is not a valid inline data URL", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-mcp-invalid-rich",
            output: {
              structured: {
                metadata: { source: "mcp-capability-registry", kind: "resource", server: "docs", uri: "docs://bad" },
              },
              content: [{ type: "file" as const, uri: "file:///outside.png", mime: "image/png" }],
            },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* store.listCatalog()).entries).toHaveLength(0)
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const store = AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig, [
        [Global.node, Global.layerWith({ data: root.path })],
        [FSUtil.node, blockedFilesystem],
      ])
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("enforces the profile-wide managed-artifact quota and reports physical usage", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          const owner = { scope: "profile" as const, id: "profile-quota" }
          const bytes = new TextEncoder().encode("1234")
          yield* store.bindBytes({ bytes, owner, kind: "quota", mime: "text/plain" })
          yield* store.bindBytes({ bytes, owner, kind: "quota", mime: "text/plain" })

          expect(yield* store.usage()).toEqual({ totalBytes: 8, maxTotalBytes: 8 })
          const rejected = yield* store.bindBytes({ bytes, owner, kind: "quota", mime: "text/plain" }).pipe(Effect.exit)
          expect(Exit.isFailure(rejected)).toBe(true)
          if (Exit.isFailure(rejected)) expect(String(Cause.squash(rejected.cause))).toContain("quota exceeded")
          expect((yield* store.listCatalog({ owner })).entries).toHaveLength(2)
          expect(yield* store.usage()).toEqual({ totalBytes: 8, maxTotalBytes: 8 })
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_total_bytes: 8 }) }),
    ),
  )

  it.live("serializes concurrent artifact imports against one aggregate quota", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          const owner = { scope: "profile" as const, id: "profile-concurrent-quota" }
          const bytes = new TextEncoder().encode("1234")
          const outcomes = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              store.bindBytes({ bytes, owner, kind: "quota", mime: "text/plain" }).pipe(Effect.exit),
            ),
            { concurrency: "unbounded" },
          )
          expect(outcomes.filter(Exit.isSuccess)).toHaveLength(2)
          const usage = yield* store.usage()
          expect(usage.maxTotalBytes).toBe(8)
          expect(usage.totalBytes).toBeLessThanOrEqual(usage.maxTotalBytes)
          expect((yield* store.listCatalog({ owner })).entries).toHaveLength(2)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_total_bytes: 8 }) }),
    ),
  )

  it.live("reclaims only aged unindexed artifact orphans", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const oldOrphan = path.join(directory, "artifact_orphan_old")
        const recentOrphan = path.join(directory, "artifact_orphan_recent")
        yield* fs.ensureDir(directory)
        yield* fs.writeFileString(oldOrphan, "old orphan")
        yield* fs.writeFileString(recentOrphan, "recent orphan")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(oldOrphan, expired, expired)

        expect((yield* store.usage()).totalBytes).toBe("old orphan".length + "recent orphan".length)
        yield* store.cleanup()
        expect(yield* fs.exists(oldOrphan)).toBe(false)
        expect(yield* fs.exists(recentOrphan)).toBe(true)
        expect((yield* store.listCatalog()).entries).toHaveLength(0)
        expect((yield* store.usage()).totalBytes).toBe("recent orphan".length)
      }),
    ),
  )

  it.live("reconciles an interrupted artifact write before it consumes quota", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: "ses_pending_recovery" }
        const bytes = new TextEncoder().encode("payload left between write and catalog commit")
        const handle = "artifact_pending_recovery"
        const reference = OpaqueArtifact.make({
          version: 1,
          kind: "pending-fixture",
          digest: createHash("sha256").update(bytes).digest("hex"),
          mime: "text/plain",
          sizeBytes: bytes.byteLength,
          owner,
          retention: { mode: "durable" },
          retrievalHint: { kind: "managed", handle },
          createdAt: DateTime.makeUnsafe(Date.now()),
        })
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const indexPath = path.join(directory, ToolOutputStore.INDEX_DIRECTORY, `${handle}.json`)
        const markerPath = path.join(
          directory,
          ToolOutputStore.PENDING_DIRECTORY,
          `${ToolOutputStore.PENDING_PREFIX}${handle}.json`,
        )
        yield* fs.ensureDir(path.dirname(indexPath))
        yield* fs.ensureDir(path.dirname(markerPath))
        yield* fs.writeFile(path.join(directory, handle), bytes)
        yield* fs.writeJson(indexPath, Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference))
        yield* fs.writeJson(markerPath, {
          schemaVersion: 1,
          handle,
          reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
        })

        expect((yield* store.usage()).totalBytes).toBe(0)
        expect(yield* fs.exists(path.join(directory, handle))).toBe(false)
        expect(yield* fs.exists(indexPath)).toBe(false)
        expect(yield* fs.exists(markerPath)).toBe(false)
        expect((yield* store.listCatalog()).entries).toHaveLength(0)
      }),
    ),
  )

  it.live("drops a stale marker after the catalog commit without deleting the receipt", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const owner = { scope: "session" as const, id: "ses_committed_marker" }
        const reference = yield* store.bindBytes({
          bytes: new TextEncoder().encode("committed payload"),
          owner,
          kind: "committed-fixture",
          mime: "text/plain",
        })
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const markerPath = path.join(
          directory,
          ToolOutputStore.PENDING_DIRECTORY,
          `${ToolOutputStore.PENDING_PREFIX}${reference.retrievalHint.handle}.json`,
        )
        expect(yield* fs.exists(markerPath)).toBe(false)
        yield* fs.ensureDir(path.dirname(markerPath))
        yield* fs.writeJson(markerPath, {
          schemaVersion: 1,
          handle: reference.retrievalHint.handle,
          reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
        })

        expect((yield* store.usage()).totalBytes).toBe(reference.sizeBytes)
        expect(yield* fs.exists(markerPath)).toBe(false)
        expect((yield* store.read({ reference, owner })).bytes).toEqual(new TextEncoder().encode("committed payload"))
      }),
    ),
  )

  it.live("fails closed on a corrupt pending marker and leaves its payload for inspection", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const handle = "artifact_pending_corrupt"
        const payload = path.join(directory, handle)
        const marker = path.join(
          directory,
          ToolOutputStore.PENDING_DIRECTORY,
          `${ToolOutputStore.PENDING_PREFIX}${handle}.json`,
        )
        yield* fs.ensureDir(path.dirname(marker))
        yield* fs.writeFileString(payload, "retain for diagnosis")
        yield* fs.writeFileString(marker, "{not-json")

        const exit = yield* store.usage().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* fs.exists(payload)).toBe(true)
        expect(yield* fs.exists(marker)).toBe(true)
      }),
    ),
  )

  it.live(
    "recovers real SIGKILLs at every artifact commit boundary in a fresh process",
    () =>
      Effect.promise(async () => {
        const boundaries = ["after-marker", "after-payload", "after-index", "after-catalog"] as const
        const bytes = new TextEncoder().encode("artifact transaction crash payload")
        const root = mkdtempSync(join(osTmpdir(), "arforge-artifact-transaction-sigkill-"))
        try {
          for (const boundary of boundaries) {
            const boundaryRoot = join(root, boundary)
            const state = join(boundaryRoot, "state")
            const worker = Bun.spawn(
              [process.execPath, "test/fixture/artifact-transaction-crash-worker.ts", boundaryRoot, state],
              {
                cwd: join(import.meta.dir, ".."),
                env: {
                  ...process.env,
                  ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
                  ARFORGE_TEST_ARTIFACT_CRASH_BOUNDARY: boundary,
                  ARFORGE_TEST_FLOCK_STALE_MS: "250",
                },
                stdout: "pipe",
                stderr: "pipe",
              },
            )
            const [exitCode, stdout, stderr] = await Promise.all([
              worker.exited,
              new Response(worker.stdout).text(),
              new Response(worker.stderr).text(),
            ])
            expect(exitCode, `${boundary}\n${stdout}\n${stderr}`).not.toBe(0)

            const layer = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.nodeWithoutConfig, FSUtil.node]), [
              [Global.node, Global.layerWith({ data: boundaryRoot, state })],
            ])
            const previousStale = process.env.ARFORGE_TEST_FLOCK_STALE_MS
            process.env.ARFORGE_TEST_FLOCK_STALE_MS = "250"
            let recovered: {
              readonly usage: ToolOutputStore.ArtifactStoreUsage
              readonly catalog: ToolOutputStore.ArtifactCatalogPage
              readonly read?: ToolOutputStore.ArtifactReadResult
            }
            try {
              recovered = await Effect.runPromise(
                Effect.gen(function* () {
                  const store = yield* ToolOutputStore.Service
                  const usage = yield* store.usage()
                  const catalog = yield* store.listCatalog()
                  const receipt = catalog.entries[0]?.reference
                  const read = receipt
                    ? yield* store.read({
                        reference: receipt,
                        owner: { scope: "session", id: "ses_artifact_crash" },
                      })
                    : undefined
                  return { usage, catalog, read }
                }).pipe(Effect.scoped, Effect.provide(layer)),
              )
            } finally {
              if (previousStale === undefined) delete process.env.ARFORGE_TEST_FLOCK_STALE_MS
              else process.env.ARFORGE_TEST_FLOCK_STALE_MS = previousStale
            }
            if (boundary === "after-catalog") {
              expect(recovered.usage.totalBytes).toBe(bytes.byteLength)
              expect(recovered.catalog.entries).toHaveLength(1)
              expect(recovered.read?.bytes).toEqual(bytes)
            } else {
              expect(recovered.usage.totalBytes).toBe(0)
              expect(recovered.catalog.entries).toHaveLength(0)
              expect(recovered.read).toBeUndefined()
            }
          }
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      }),
    90_000,
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
