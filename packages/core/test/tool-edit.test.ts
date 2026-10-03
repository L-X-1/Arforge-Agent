import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { EventV2 } from "@arforge-ai/core/event"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { EditTool } from "@arforge-ai/core/tool/edit"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_edit_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let reads = 0
let denyAction: string | undefined
let afterRead = (_target: string, _content: Uint8Array): Effect.Effect<void> => Effect.void

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
  reads = 0
  denyAction = undefined
  afterRead = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        fs
          .readFile(target)
          .pipe(
            Effect.tap((content) =>
              Effect.sync(() => reads++).pipe(Effect.andThen(Effect.suspend(() => afterRead(target, content)))),
            ),
          ),
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
      ...(fs.writeIfUnchanged
        ? {
            writeIfUnchanged: (target: string, expected: Uint8Array, content: string | Uint8Array, mode?: number) =>
              Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeIfUnchanged!(target, expected, content, mode))),
          }
        : {}),
      writeFile: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFile(target, content, options))),
      writeFileString: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFileString(target, content, options))),
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
          EditTool.node,
          EventV2.node,
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

const call = (input: typeof EditTool.Input.Type, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "edit", input },
})

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("registers and replaces relative exact text through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "hello.txt")
        return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["edit"])
                expect(yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(
                  [],
                )
                const settled = yield* settleTool(
                  registry,
                  call({ path: "hello.txt", oldString: "before", newString: "after" }),
                )
                expect(settled.result).toEqual({
                  type: "text",
                  value: "Edited file successfully: hello.txt\nReplacements: 1\n```diff\n-before\n+after\n```",
                })
                expect(settled.output?.structured).toEqual({
                  replacements: 1,
                  files: [
                    {
                      file: "hello.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                  ],
                })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\nrest\n")
                // One trusted preflight assert with the exact canonical scope;
                // the leaf assert is suppressed by the grant — no wildcard.
                expect(assertions).toMatchObject([
                  {
                    sessionID,
                    agent: "build",
                    action: "edit",
                    resources: ["hello.txt"],
                    save: ["hello.txt"],
                    metadata: { riskTier: "L2", authority: "scoped_grant", filesystemScope: ["hello.txt"] },
                  },
                ])
                expect(assertions[0]?.resources).not.toContain("*")
                expect(writes).toEqual([yield* Effect.promise(() => fs.realpath(target))])
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
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(assertions[0]?.resources).not.toContain("*")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
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
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["edit", "external_directory"])
              expect(assertions[0]?.resources).not.toContain("*")
              expect(assertions[1]?.resources).not.toContain("*")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
              expect(writes).toHaveLength(1)
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
          yield* Effect.promise(() => fs.writeFile(external, "before"))
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" }, "call-deny-ext")),
            ),
          ).toEqual({
            type: "error",
            value: `Permission denied for edit: ${external.replaceAll("\\", "/")}; external_directory: ${path.join(
              path.dirname(external),
              "*",
            ).replaceAll("\\", "/")}`,
          })
          // The canonical preflight asserts edit before external_directory;
          // the denial reason is model-visible and no file was touched.
          expect(assertions.map((input) => input.action)).toEqual(["edit", "external_directory"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" }, "call-deny-edit")),
            ),
          ).toEqual({
            type: "error",
            value: `Permission denied for edit: ${external.replaceAll("\\", "/")}; external_directory: ${path.join(
              path.dirname(external),
              "*",
            ).replaceAll("\\", "/")}`,
          })
          // denyAction = "edit" blocks the first canonical request, so the
          // external_directory request is never evaluated.
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("denied edit reads no target content and does not disclose whether oldString matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "secret.txt")
        return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const matching = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }, "call-matching"),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "not present", newString: "replacement" }, "call-missing"),
                )

                // The preflight denial exposes the model-visible reason and
                // never reads the target or discloses whether oldString matched.
                expect(matching).toEqual({ type: "error", value: "Permission denied for edit: secret.txt" })
                expect(missing).toEqual(matching)
                expect(assertions.map((input) => input.action)).toEqual(["edit", "edit"])
                expect(assertions[0]?.resources).not.toContain("*")
                expect(reads).toBe(0)
                expect(writes).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects no-op, empty, missing, and ambiguous exact replacements", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "matches.txt")
        return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call({ path: "matches.txt", oldString: "same", newString: "same" }, "call-noop"),
                  ),
                ).toEqual({
                  type: "error",
                  value: "No changes to apply: oldString and newString are identical.",
                })
                expect(
                  yield* executeTool(
                    registry,
                    call({ path: "matches.txt", oldString: "", newString: "after" }, "call-empty"),
                  ),
                ).toEqual({
                  type: "error",
                  value: "oldString must not be empty. Use write to create or overwrite a file.",
                })
                expect(
                  yield* executeTool(
                    registry,
                    call({ path: "matches.txt", oldString: "missing", newString: "after" }, "call-missing"),
                  ),
                ).toEqual({
                  type: "error",
                  value:
                    "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                })
                expect(
                  yield* executeTool(
                    registry,
                    call({ path: "matches.txt", oldString: "same", newString: "after" }, "call-ambiguous"),
                  ),
                ).toEqual({
                  type: "error",
                  value:
                    "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                })
                expect(writes).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces every exact occurrence when replaceAll is true", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "all.txt")
        return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "all.txt", oldString: "same", newString: "after", replaceAll: true })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.output?.structured).toMatchObject({ replacements: 3 })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after after")
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves BOM and CRLF line endings", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "windows.txt")
        return Effect.promise(() => fs.writeFile(target, "\uFEFFbefore\r\nrest\r\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "windows.txt", oldString: "before\nrest", newString: "after\nrest" })),
            ),
          ),
          Effect.andThen(() => Effect.promise(() => fs.readFile(target, "utf8"))),
          Effect.tap((content) => Effect.sync(() => expect(content).toBe("\uFEFFafter\r\nrest\r\n"))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an in-place content change after matching but before conditional commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "concurrent.txt")
        afterRead = () => (reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "concurrent.txt", oldString: "before", newString: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({
                type: "error",
                value: "File changed after permission approval. Read it again before editing.",
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
              expect(writes).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps the locked edit schema, semantics docstring, and deferred TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/edit.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["htmlSelection", "newString", "oldString", "path", "replaceAll"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.",
    "Add formatter integration after V2 formatter runtime exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})

const htmlSource = '<h1 id="title">Before</h1>\r\n<p>Retained</p>'
const htmlElement = '<h1 id="title">Before</h1>'
const guardedCall = (directory: string, id = "call-html-guarded") => call({
  path: "page.html",
  oldString: htmlElement,
  newString: '<h1 id="title" style="font-size:32px">After</h1>',
  htmlSelection: {
    path: "page.html", directory, mode: "file-preview",
    revision: createHash("sha256").update(htmlSource).digest("hex"),
    start: 0, end: htmlElement.length,
  },
}, id)

describe("HTML selection edit integration", () => {
  it.live("uses human-authority approval, persists the exact change and publishes a scoped refresh after settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "page.html")
        return Effect.promise(() => fs.writeFile(target, `\uFEFF${htmlSource}`)).pipe(
          Effect.andThen(withTool(tmp.path, (registry) => Effect.gen(function* () {
            const events = yield* EventV2.Service
            const updates: EventV2.Payload[] = []
            const unlisten = yield* events.listen((event) => Effect.sync(() => {
              if (event.type === "file.watcher.updated") updates.push(event)
            }))
            yield* Effect.addFinalizer(() => unlisten)
            const result = yield* settleTool(registry, guardedCall(tmp.path))
            expect(result.result.type).toBe("text")
            expect(result.output?.structured).toMatchObject({ replacements: 1, files: [{ file: "page.html", status: "modified" }] })
            expect(assertions).toMatchObject([{
              action: "edit", resources: ["page.html"],
              metadata: { riskTier: "L3", authority: "human" },
            }])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8")))
              .toBe('\uFEFF<h1 id="title" style="font-size:32px">After</h1>\r\n<p>Retained</p>')
            expect(writes).toHaveLength(1)
            expect(updates).toMatchObject([{
              type: "file.watcher.updated",
              location: { directory: tmp.path },
              data: { file: target, event: "change" },
            }])
          }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("refuses stale snapshot content before a write or refresh notification", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "page.html")
        const newer = `${htmlSource}\r\n<p>External change</p>`
        return Effect.promise(() => fs.writeFile(target, newer)).pipe(
          Effect.andThen(withTool(tmp.path, (registry) => Effect.gen(function* () {
            const events = yield* EventV2.Service
            const updates: EventV2.Payload[] = []
            const unlisten = yield* events.listen((event) => Effect.sync(() => {
              if (event.type === "file.watcher.updated") updates.push(event)
            }))
            yield* Effect.addFinalizer(() => unlisten)
            expect(yield* executeTool(registry, guardedCall(tmp.path, "call-html-stale"))).toMatchObject({
              type: "error", value: expect.stringContaining("changed after this selection"),
            })
            expect(writes).toEqual([])
            expect(updates).toEqual([])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(newer)
          }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not read or write a guarded selection after approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "page.html")
        return Effect.promise(() => fs.writeFile(target, htmlSource)).pipe(
          Effect.andThen(withTool(tmp.path, (registry) => Effect.gen(function* () {
            expect(yield* executeTool(registry, guardedCall(tmp.path, "call-html-denied"))).toMatchObject({ type: "error" })
            expect(reads).toBe(0)
            expect(writes).toEqual([])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(htmlSource)
          }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps CAS protection if the approved snapshot changes immediately before commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "page.html")
        afterRead = () => reads === 1 ? Effect.promise(() => fs.writeFile(target, "<h1>Newer writer</h1>")) : Effect.void
        return Effect.promise(() => fs.writeFile(target, htmlSource)).pipe(
          Effect.andThen(withTool(tmp.path, (registry) => Effect.gen(function* () {
            expect(yield* executeTool(registry, guardedCall(tmp.path, "call-html-concurrent"))).toMatchObject({
              type: "error", value: expect.stringContaining("File changed after permission approval"),
            })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("<h1>Newer writer</h1>")
            expect(writes).toEqual([])
          }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("does not report a committed edit as failed if its preview notification fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "page.html")
        return Effect.promise(() => fs.writeFile(target, htmlSource)).pipe(
          Effect.andThen(withTool(tmp.path, (registry) => Effect.gen(function* () {
            const events = yield* EventV2.Service
            const unlisten = yield* events.listen((event) => event.type === "file.watcher.updated"
              ? Effect.die(new Error("Preview notification fixture failure"))
              : Effect.void)
            yield* Effect.addFinalizer(() => unlisten)
            const result = yield* executeTool(registry, guardedCall(tmp.path, "call-html-notification"))
            expect(result).toMatchObject({
              type: "content",
              value: [
                { type: "text", text: expect.stringContaining("Edited file successfully: page.html") },
                { type: "text", text: expect.stringContaining("do not repeat the edit") },
              ],
            })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toContain("font-size:32px")
            expect(writes).toHaveLength(1)
          }))),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
