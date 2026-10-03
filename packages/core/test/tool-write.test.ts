import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { extractOfficeText } from "@arforge-ai/core/office-document"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { WriteTool } from "@arforge-ai/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  denyAction = undefined
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("fuses bounded XLSX creation into the canonical write permission and mutation path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settled = yield* settleTool(
              registry,
              call({
                path: "report.xlsx",
                content: JSON.stringify([
                  ["month", "income"],
                  ["July", 128],
                ]),
              }),
            )
            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: report.xlsx" })
            const bytes = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "report.xlsx")))
            expect(extractOfficeText(bytes, ".xlsx")).toEqual({
              ok: true,
              engine: "ooxml",
              text: "month\tincome\nJuly\t128",
            })
            expect(assertions.map((input) => input.action)).toEqual(["edit"])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "report.xlsx")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects malformed XLSX JSON before touching the target", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "broken.xlsx")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const result = yield* executeTool(
                  registry,
                  call({ path: "broken.xlsx", content: "not-json" }, "call-broken-xlsx"),
                )
                expect(result).toMatchObject({ type: "error", value: "XLSX content is not valid JSON" })
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fuses bounded DOCX creation into the canonical write permission and mutation path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settled = yield* settleTool(
              registry,
              call(
                {
                  path: "report.docx",
                  content: "# 月报\n\n收入 **已确认**\n- 一项",
                },
                "call-docx",
              ),
            )
            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: report.docx" })
            const bytes = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "report.docx")))
            expect(extractOfficeText(bytes, ".docx")).toEqual({
              ok: true,
              engine: "ooxml",
              text: "月报\n收入 已确认\n• 一项",
            })
            expect(assertions.map((input) => input.action)).toEqual(["edit"])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "report.docx")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects DOCX XML control characters before creating or overwriting the target", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "broken.docx")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const result = yield* executeTool(
                  registry,
                  call({ path: "broken.docx", content: "bad\u0001text" }, "call-broken-docx"),
                )
                expect(result).toMatchObject({ type: "error", value: expect.stringContaining("invalid XML character") })
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fuses bounded PPTX creation into the canonical write permission and mutation path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settled = yield* settleTool(
              registry,
              call(
                {
                  path: "report.pptx",
                  content: JSON.stringify([{ title: "路线图", body: "阶段一\n阶段二" }]),
                },
                "call-pptx",
              ),
            )
            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: report.pptx" })
            const bytes = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "report.pptx")))
            expect(extractOfficeText(bytes, ".pptx")).toEqual({
              ok: true,
              engine: "ooxml",
              text: "路线图\n阶段一\n阶段二",
            })
            expect(assertions.map((input) => input.action)).toEqual(["edit"])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "report.pptx")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fuses bounded PDF creation into the canonical write permission and mutation path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settled = yield* settleTool(
              registry,
              call({ path: "report.pdf", content: "# 月报\n收入 **已确认**\n<!-- pagebreak -->\n## 后续" }, "call-pdf"),
            )
            expect(settled.result).toEqual({ type: "text", value: "Created file successfully: report.pdf" })
            const bytes = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "report.pdf")))
            expect(bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4")
            expect(bytes.toString("latin1")).toContain("/Type /Pages /Count 2")
            expect(assertions.map((input) => input.action)).toEqual(["edit"])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "report.pdf")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects PDF control characters before creating or overwriting the target", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "broken.pdf")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const result = yield* executeTool(
                  registry,
                  call({ path: "broken.pdf", content: "bad\u0001text" }, "call-broken-pdf"),
                )
                expect(result).toMatchObject({ type: "error", value: expect.stringContaining("control character") })
                expect(writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("registers and creates a relative file through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["write"])
            const settled = yield* settleTool(registry, call({ path: "src/new.txt", content: "created" }))
            expect(settled).toEqual({
              result: { type: "text", value: "Created file successfully: src/new.txt" },
              output: {
                structured: {
                  operation: "write",
                  target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
                  resource: "src/new.txt",
                  existed: false,
                },
                content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
              },
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
              "created",
            )
            expect(assertions).toMatchObject([
              { sessionID, agent: "build", action: "edit", resources: ["src/new.txt"], save: ["src/new.txt"] },
            ])
            expect(assertions[0]?.resources).not.toContain("*")
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => settleTool(registry, call({ path: "existing.txt", content: "after" }))),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "text", value: "Wrote file successfully: existing.txt" })
              expect(settled.output?.structured).toMatchObject({ resource: "existing.txt", existed: true })
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("fails closed when the same action identity carries different write content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(registry, call({ path: "existing.txt", content: "after" }))
                const replay = yield* executeTool(
                  registry,
                  call({ path: "existing.txt", content: "different-content" }),
                )
                // Same tool/path/scope but different content: the durable
                // intent fingerprint differs, so the call fails closed before
                // any permission request, attempt, or file mutation, and the
                // first result is never replayed.
                expect(replay).toEqual({
                  type: "error",
                  value: expect.stringContaining("intent does not match"),
                })
                expect(assertions).toHaveLength(1)
                expect(writes).toHaveLength(1)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                  "after",
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const preserved = path.join(tmp.path, "preserved.txt")
        const deduplicated = path.join(tmp.path, "deduplicated.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(registry, call({ path: "preserved.txt", content: "after" }, "call-preserved"))
                yield* settleTool(
                  registry,
                  call({ path: "deduplicated.txt", content: "\uFEFFafter" }, "call-deduplicated"),
                )

                expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
                expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return withTool(tmp.path, (registry) => executeTool(registry, call({ path: target, content: "inside" }))).pipe(
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({ type: "text", value: "Created file successfully: absolute.txt" })
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return withTool(active.path, (registry) =>
          settleTool(registry, call({ path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalTarget = path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "external.txt")
              expect(assertions.map((input) => input.action)).toEqual(["edit", "external_directory"])
              expect(assertions[0]).toMatchObject({
                resources: [canonicalTarget.replaceAll("\\", "/")],
              })
              expect(assertions[0]?.resources).not.toContain("*")
              expect(assertions[1]).toMatchObject({
                resources: [
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ],
              })
              expect(settled.output?.structured).toMatchObject({
                target: canonicalTarget,
                resource: canonicalTarget.replaceAll("\\", "/"),
                existed: false,
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(writes).toEqual([canonicalTarget])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, content: "blocked" }, "call-deny-ext")),
            ),
          ).toEqual({
            type: "error",
            value: `Permission denied for edit: ${external.replaceAll("\\", "/")}; external_directory: ${path
              .join(path.dirname(external), "*")
              .replaceAll("\\", "/")}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit", "external_directory"])
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: "denied.txt", content: "blocked" }, "call-deny-edit")),
            ),
          ).toEqual({
            type: "error",
            value: "Permission denied for edit: denied.txt",
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})

test("keeps the locked write schema, semantics docstring, and deferred UX TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/write.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["content", "path"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.",
    "Add formatter integration after V2 formatter runtime exists.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
