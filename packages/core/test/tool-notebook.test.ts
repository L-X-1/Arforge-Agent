import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { NotebookV2 } from "@arforge-ai/core/notebook"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { NotebookTools } from "@arforge-ai/core/tool/notebook"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_notebook_tool_test")
const assertions: PermissionV2.AssertInput[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const lock = Layer.succeed(
  EffectFlock.Service,
  EffectFlock.Service.of({
    acquire: () => Effect.void,
    withLock: ((...args: unknown[]) => {
      if (Effect.isEffect(args[0])) return args[0]
      return <A, E, R>(body: Effect.Effect<A, E, R>) => body
    }) as EffectFlock.Interface["withLock"],
  }),
)

const withNotebook = <A, E, R>(
  directory: string,
  body: (services: {
    readonly mutation: LocationMutation.Interface
    readonly notebook: NotebookV2.Interface
    readonly registry: ToolRegistry.Interface
  }) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body({
      mutation: yield* LocationMutation.Service,
      notebook: yield* NotebookV2.Service,
      registry: yield* ToolRegistry.Service,
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          LocationMutation.node,
          NotebookV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          NotebookTools.node,
        ]),
        [
          [Location.node, activeLocation],
          [EffectFlock.node, lock],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const baseNotebook = (minor = 5) => ({
  cells: [
    {
      cell_type: "code",
      execution_count: 7,
      ...(minor >= 5 ? { id: "code-a" } : {}),
      metadata: { tag: "keep" },
      outputs: [{ name: "stdout", output_type: "stream", text: ["old\n"] }],
      source: ["value = 1\n"],
    },
    {
      cell_type: "markdown",
      ...(minor >= 5 ? { id: "notes" } : {}),
      metadata: { custom: { keep: true } },
      source: ["# Notes\n"],
    },
  ],
  metadata: { custom: { project: "keep" }, language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: minor,
})

const writeNotebook = async (target: string, value: unknown) => {
  const raw = JSON.stringify(value, null, 2)
  await fs.writeFile(target, raw)
  return createHash("sha256").update(raw).digest("hex")
}

const targetFor = (mutation: LocationMutation.Interface, notebookPath: string) =>
  mutation.resolve({ path: notebookPath, kind: "file" }).pipe(Effect.orDie)

const call = (name: "notebook_read" | "notebook_edit", input: unknown, id?: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: id ?? `call-${name}`, name, input },
})

const it = testEffect(Layer.empty)

describe("NotebookTools", () => {
  it.live("reads bounded structured cells, exact hashes, metadata, and opt-in outputs", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "sample.ipynb")
          const expected = yield* Effect.promise(() => writeNotebook(target, baseNotebook()))
          yield* withNotebook(tmp.path, ({ mutation, notebook }) =>
            Effect.gen(function* () {
              const resolved = yield* targetFor(mutation, "sample.ipynb")
              const summary = yield* notebook.read({ target: resolved })
              expect(summary.sha256).toBe(expected)
              expect(summary).toMatchObject({
                language: "python",
                cell_count: 2,
                range: { start: 0, count: 2 },
                cells: [
                  { cell_id: "code-a", output_count: 1, metadata: { tag: "keep" } },
                  { cell_id: "notes", metadata: { custom: { keep: true } } },
                ],
              })
              expect(summary.cells[0]).not.toHaveProperty("outputs")
              expect((yield* notebook.read({ target: resolved, includeOutputs: true })).cells[0]).toHaveProperty(
                "outputs",
              )
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces and converts cells atomically while preserving metadata and backing up the exact original", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "sample.ipynb")
          const expected = yield* Effect.promise(() => writeNotebook(target, baseNotebook()))
          yield* withNotebook(tmp.path, ({ mutation, notebook }) =>
            Effect.gen(function* () {
              const resolved = yield* targetFor(mutation, "sample.ipynb")
              const first = yield* notebook.edit({
                target: resolved,
                expectedSha256: expected,
                cellID: "code-a",
                newSource: "# converted\n",
                cellType: "markdown",
              })
              expect(first.backup_path).toBeString()
              expect(
                createHash("sha256").update(yield* Effect.promise(() => fs.readFile(first.backup_path!))).digest("hex"),
              ).toBe(expected)
              const converted = JSON.parse(yield* Effect.promise(() => fs.readFile(target, "utf8")))
              expect(converted.metadata.custom).toEqual({ project: "keep" })
              expect(converted.cells[0]).toMatchObject({
                cell_type: "markdown",
                source: ["# converted\n"],
                metadata: { tag: "keep" },
              })
              expect(converted.cells[0]).not.toHaveProperty("outputs")
              expect(converted.cells[0]).not.toHaveProperty("execution_count")

              const second = yield* notebook.edit({
                target: resolved,
                expectedSha256: first.after_sha256,
                cellID: "notes",
                newSource: "print('ready')\n",
                cellType: "code",
              })
              const updated = JSON.parse(yield* Effect.promise(() => fs.readFile(target, "utf8")))
              expect(updated.cells[1]).toMatchObject({ execution_count: null, outputs: [] })
              expect(second.after_sha256).toBe(
                createHash("sha256").update(yield* Effect.promise(() => fs.readFile(target))).digest("hex"),
              )
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("generates 4.5 IDs, preserves legacy ID shape, supports deletion, and makes dry-run side-effect free", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const modernPath = path.join(tmp.path, "modern.ipynb")
          const legacyPath = path.join(tmp.path, "legacy.ipynb")
          const modernHash = yield* Effect.promise(() => writeNotebook(modernPath, baseNotebook()))
          const legacyHash = yield* Effect.promise(() => writeNotebook(legacyPath, baseNotebook(4)))
          yield* withNotebook(tmp.path, ({ mutation, notebook }) =>
            Effect.gen(function* () {
              const modern = yield* targetFor(mutation, "modern.ipynb")
              const preview = yield* notebook.edit({
                target: modern,
                expectedSha256: modernHash,
                editMode: "insert",
                newSource: "Intro\n",
                cellType: "markdown",
                dryRun: true,
              })
              expect(preview).toMatchObject({ dry_run: true, cell_count_before: 2, cell_count_after: 3 })
              expect(
                createHash("sha256").update(yield* Effect.promise(() => fs.readFile(modernPath))).digest("hex"),
              ).toBe(modernHash)

              const inserted = yield* notebook.edit({
                target: modern,
                expectedSha256: modernHash,
                editMode: "insert",
                cellID: "code-a",
                newSource: "print(value)\n",
                cellType: "code",
              })
              const modernCells = JSON.parse(yield* Effect.promise(() => fs.readFile(modernPath, "utf8"))).cells
              expect(modernCells[1].id).toMatch(/^[0-9a-f]{12}$/)
              expect(modernCells[1]).toMatchObject({ execution_count: null, outputs: [] })

              const deleted = yield* notebook.edit({
                target: modern,
                expectedSha256: inserted.after_sha256,
                editMode: "delete",
                cellID: modernCells[1].id,
              })
              expect(deleted.cell_count_after).toBe(2)

              const legacy = yield* targetFor(mutation, "legacy.ipynb")
              yield* notebook.edit({
                target: legacy,
                expectedSha256: legacyHash,
                editMode: "insert",
                cellID: "cell-0",
                newSource: "legacy\n",
                cellType: "raw",
              })
              expect(JSON.parse(yield* Effect.promise(() => fs.readFile(legacyPath, "utf8"))).cells[1]).not.toHaveProperty(
                "id",
              )
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails closed on stale hashes, duplicate IDs, malformed UTF-8, path escapes, and invalid selectors", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([tmp, outside]) =>
        Effect.gen(function* () {
          const validPath = path.join(tmp.path, "sample.ipynb")
          yield* Effect.promise(() => writeNotebook(validPath, baseNotebook()))
          yield* Effect.promise(() =>
            writeNotebook(path.join(tmp.path, "duplicate.ipynb"), {
              ...baseNotebook(),
              cells: [
                { ...baseNotebook().cells[0], id: "same" },
                { ...baseNotebook().cells[1], id: "same" },
              ],
            }),
          )
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "invalid.ipynb"), new Uint8Array([0xff, 0xfe])))
          yield* withNotebook(tmp.path, ({ mutation, notebook }) =>
            Effect.gen(function* () {
              const valid = yield* targetFor(mutation, "sample.ipynb")
              expect(
                yield* notebook
                  .edit({
                    target: valid,
                    expectedSha256: "0".repeat(64),
                    cellID: "code-a",
                    newSource: "value = 2\n",
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ message: expect.stringContaining("changed since") })
              expect(
                yield* notebook
                  .edit({
                    target: valid,
                    expectedSha256: (yield* notebook.read({ target: valid })).sha256,
                    cellID: "missing",
                    newSource: "value = 2\n",
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ message: "cell id not found: missing" })
              const duplicate = yield* targetFor(mutation, "duplicate.ipynb")
              expect(yield* notebook.read({ target: duplicate }).pipe(Effect.flip)).toMatchObject({
                message: "duplicate cell id: same",
              })
              const invalid = yield* targetFor(mutation, "invalid.ipynb")
              expect(yield* notebook.read({ target: invalid }).pipe(Effect.flip)).toMatchObject({
                message: "notebook must use UTF-8 encoding",
              })
              expect(yield* mutation.resolve({ path: "../escape.ipynb" }).pipe(Effect.flip)).toMatchObject({
                reason: "relative_escape",
              })
            }),
          )
        }),
      ([tmp, outside]) =>
        Effect.promise(() =>
          Promise.all([tmp[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("registers exact source tool names and applies read/edit plus external-directory permissions", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          assertions.length = 0
          const internal = path.join(active.path, "inside.ipynb")
          const external = path.join(outside.path, "outside.ipynb")
          yield* Effect.promise(() => Promise.all([writeNotebook(internal, baseNotebook()), writeNotebook(external, baseNotebook())]))
          yield* withNotebook(active.path, ({ registry }) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([
                "notebook_read",
                "notebook_edit",
              ])
              expect(
                (yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).map(
                  (tool) => tool.name,
                ),
              ).toEqual(["notebook_read"])

              const read = yield* settleTool(registry, call("notebook_read", { notebook_path: "inside.ipynb" }))
              expect(read.output?.structured).toMatchObject({ language: "python", cell_count: 2 })
              const sha = (read.output!.structured as { sha256: string }).sha256
              expect(
                yield* executeTool(
                  registry,
                  call("notebook_edit", {
                    notebook_path: "inside.ipynb",
                    expected_sha256: sha,
                    cell_id: "code-a",
                    new_source: "value = 4\n",
                  }),
                ),
              ).toMatchObject({ type: "text", value: expect.stringContaining('"edit_mode": "replace"') })
              expect(
                yield* executeTool(
                  registry,
                  call("notebook_read", { notebook_path: external, limit: 1 }, "call-external-read"),
                ),
              ).toMatchObject({ type: "text" })
              // notebook_read is undeclared (fresh L3 human preflight); the
              // L2 edit and the elevated external read assert the canonical
              // preflight in sorted order.
              expect(assertions.map((item) => item.action)).toEqual([
                "notebook_read",
                "edit",
                "external_directory",
                "notebook_read",
              ])
            }),
          )
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})
