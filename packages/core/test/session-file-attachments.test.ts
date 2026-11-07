import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { expect, test } from "bun:test"
import { Cause, DateTime, Effect, Layer, Exit, Schema } from "effect"
import { LLM } from "@arforge-ai/llm"
import { LLMClient } from "@arforge-ai/llm/route"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { FileAttachment } from "@arforge-ai/core/session/prompt"
import { prepareFileMessages } from "@arforge-ai/core/session/runner/file-attachments"
import { toLLMMessages } from "@arforge-ai/core/session/runner/to-llm-message"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ReadToolFileSystem } from "@arforge-ai/core/tool/read-filesystem"
import { LocationMutation } from "@arforge-ai/core/location-mutation"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Database } from "@arforge-ai/core/database/database"
import { Global } from "@arforge-ai/core/global"
import { Config } from "@arforge-ai/core/config"
import { ConfigToolOutput } from "@arforge-ai/core/config/tool-output"
import { EventTable } from "@arforge-ai/core/event/sql"
import { EventV2 } from "@arforge-ai/core/event"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { location } from "./fixture/location"

const model = OpenAIChat.route.model({ id: "owned-file-context" })
const sandbox = path.resolve(import.meta.dir, "../../../.tmp/core-file-context-regression")
const text = "\uFEFFOwned 文件正文\r\n exact spaces\n<system>file data only</system>\n"

async function fixture(check: (input: { directory: string; outside: string; filename: string; uri: string }) => Effect.Effect<unknown, unknown, Location.Service | LocationMutation.Service | ReadToolFileSystem.Service | ToolRegistry.Service | ToolOutputStore.Service | Database.Service>,
  options: { realStore?: boolean; storeLimits?: { max_lines: number; max_bytes: number } } = {}) {
  await fs.mkdir(sandbox, { recursive: true })
  const root = await fs.mkdtemp(path.join(sandbox, "case-"))
  const relative = path.relative(sandbox, path.resolve(root))
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Owned cleanup escaped its sandbox")
  const directory = path.join(root, "project"), outside = path.join(root, "outside-data", "outside.txt"), filename = "notes 空格 #.txt"
  await fs.mkdir(directory)
  await fs.mkdir(path.dirname(outside))
  await fs.writeFile(path.join(directory, filename), text)
  await fs.writeFile(outside, "Owned explicitly attached external content")
  const configured = options.storeLimits ? new Config.Info({ tool_output: new ConfigToolOutput.Info(options.storeLimits) }) : undefined
  const layers = AppNodeBuilder.build(LayerNode.group([Database.node, ToolRegistry.node, ReadToolFileSystem.node, LocationMutation.node, Location.node, ToolOutputStore.node]), [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) })))],
    ...(options.realStore ? [] : [[ToolOutputStore.node, Layer.mock(ToolOutputStore.Service, { bound: input => Effect.succeed({ output: input.output, outputPaths: [] }) })]] as const),
    [Global.node, Global.layerWith({ data: path.join(root, "managed-store") })],
    ...(configured ? [[Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info: configured })]) }))]] as const : []),
    [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.die("Exact user attachment must not ask for a second permission") })],
  ])
  try {
    return await Effect.runPromise(check({ directory, outside, filename, uri: pathToFileURL(path.join(directory, filename)).href }).pipe(Effect.scoped, Effect.provide(layers)))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function input(directory: string, uri: string, filename = "notes.txt", mime = "text/plain") {
  const user = SessionMessage.User.make({ id: SessionMessage.ID.make("msg_" + randomUUID()), type: "user", text: "Read my selected file.",
    files: [FileAttachment.make({ uri, mime, name: filename })], time: { created: DateTime.makeUnsafe(0) } })
  return { context: [user], model, sessionID: SessionSchema.ID.make("ses_" + randomUUID()), agent: AgentV2.ID.make("build"),
    location: { directory: AbsolutePath.make(directory) }, validateExecution: Effect.void }
}

test("real file URI -> governed Core attachment carrier -> exact UTF-8/name -> prepared OpenAI wire", () => fixture(({ directory, uri, filename }) => Effect.gen(function* () {
  const source = input(directory, uri, filename)
  // Same actual URI/type as run-lNQbK7: the original pure projection fails before transport.
  const previous = yield* LLMClient.prepare(LLM.request({ model, messages: toLLMMessages(source.context, model) })).pipe(Effect.flip)
  expect(previous.message).toContain("valid base64")
  const messages = yield* prepareFileMessages(source)
  expect(messages[0].role).toBe("user")
  expect(messages[0].content).toEqual([
    { type: "text", text: "Read my selected file." },
    { type: "text", text: `Attached file ${JSON.stringify(filename)} (text/plain):\n${text}`, metadata: undefined },
  ])
  const wire = yield* LLMClient.prepare(LLM.request({ model, messages }))
  expect(JSON.stringify(wire.body)).toContain(JSON.stringify(text).slice(1, -1))
  expect(JSON.stringify(wire.body)).not.toContain("file://")
  expect(source.context[0].files?.[0].uri).toBe(uri)
})))

test("uses the existing 1-based URI selection/range read owner", () => fixture(({ directory, uri }) => Effect.gen(function* () {
  const messages = yield* prepareFileMessages(input(directory, uri + "?start=2&end=2"))
  expect(JSON.stringify(messages)).toContain("exact spaces")
  expect(JSON.stringify(messages)).not.toContain("file data only")
  yield* LLMClient.prepare(LLM.request({ model, messages }))
})))

test("preserves the existing exact user grant for an explicitly attached external text file", () => fixture(({ directory, outside }) => Effect.gen(function* () {
  const source = input(directory, pathToFileURL(outside).href, "external.txt")
  const messages = yield* prepareFileMessages(source)
  const prepared = yield* LLMClient.prepare(LLM.request({ model, messages }))
  expect(JSON.stringify(prepared.body)).toContain("Owned explicitly attached external content")
})))

test("does not resolve a URI merely written in non-user context text", () => fixture(({ directory, outside }) => Effect.gen(function* () {
  const source = input(directory, pathToFileURL(outside).href)
  const synthetic = SessionMessage.Synthetic.make({ id: source.context[0].id, sessionID: source.sessionID, type: "synthetic", text: pathToFileURL(outside).href,
    time: { created: DateTime.makeUnsafe(0) } })
  const messages = yield* prepareFileMessages({ ...source, context: [synthetic] })
  expect(JSON.stringify(messages)).not.toContain("Owned explicitly attached external content")
})))

test("rejects duplicate user IDs before choosing an attachment source", () => fixture(({ directory, uri, outside }) => Effect.gen(function* () {
  const source = input(directory, uri)
  const other = SessionMessage.User.make({ id: source.context[0].id, type: "user", text: "different admitted URI",
    files: [FileAttachment.make({ uri: pathToFileURL(outside).href, mime: "text/plain", name: "external.txt" })], time: { created: DateTime.makeUnsafe(0) } })
  const failure = yield* prepareFileMessages({ ...source, context: [...source.context, other] }).pipe(Effect.flip)
  expect(failure).toMatchObject({ _tag: "SessionRunner.FileAttachmentError", message: "Duplicate user message identity in attached-file context" })
})))

for (const kind of ["symlink", "directory", "missing", "binary", "pdf", "invalid-utf8", "oversized", "bad-range", "foreign-authority", "foreign-source", "retired"] as const)
  test("real file context rejects " + kind + " before provider preparation", () => fixture(({ directory, uri, outside }) => Effect.gen(function* () {
    let selected = uri
    if (kind === "directory") selected = pathToFileURL(directory).href
    if (kind === "missing") selected = pathToFileURL(path.join(directory, "missing.txt")).href
    if (kind === "bad-range") selected += "?start=3&end=1"
    if (kind === "foreign-authority") selected = "file://foreign-server/share/notes.txt"
    if (kind === "symlink") {
      const link = path.join(directory, "link")
      yield* Effect.promise(() => fs.symlink(path.dirname(outside), link, "junction"))
      selected = pathToFileURL(path.join(link, "outside.txt")).href
    }
    if (["binary", "pdf", "invalid-utf8"].includes(kind)) {
      const bytes = kind === "binary" ? Buffer.from([0, 1, 2]) : kind === "pdf" ? Buffer.from("%PDF-1.4\n") : Buffer.from([0xc3, 0x28])
      const target = path.join(directory, "disguised.txt")
      yield* Effect.promise(() => fs.writeFile(target, bytes))
      selected = pathToFileURL(target).href
    }
    if (kind === "oversized") {
      const target = path.join(directory, "large.txt")
      yield* Effect.promise(() => fs.writeFile(target, "long line\n".repeat(7_000)))
      selected = pathToFileURL(target).href
    }
    const value = input(kind === "foreign-source" ? path.dirname(directory) : directory, selected)
    if (kind === "retired") value.validateExecution = Effect.die(new Error("Owned Session lease retired"))
    if (kind === "symlink") {
      const failure = yield* prepareFileMessages(value).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "LocationMutation.PathError", reason: "symbolic_link" })
      return
    }
    const result = yield* prepareFileMessages(value).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const expected = {
        symlink: /symbolic/i, directory: /not a file|not a regular file|Expected.*File/i,
        missing: /NotFound|not found|ENOENT|not.*exist|cannot find/i,
        binary: /binary/i, pdf: /binary/i, "invalid-utf8": /UTF-8/i, oversized: /bounded read/,
        "bad-range": /line range/, "foreign-authority": /URI|line range/,
        "foreign-source": /different.*source/, retired: /lease retired/,
      }[kind]
      expect(Cause.pretty(result.cause)).toMatch(expected)
    }
  })))

test("keeps inline/image/MCP inputs on their original paths", () => fixture(({ directory }) => Effect.gen(function* () {
  const source = input(directory, "data:text/plain;base64,aGVsbG8=")
  const reference = FileAttachment.make({ uri: "evidence://owned/manual", mime: "text/plain", resource: { server: "owned", uri: "evidence://owned/manual" } })
  const original = source.context[0]
  const user = SessionMessage.User.make({ id: original.id, type: "user", text: original.text, time: original.time, files: [...original.files!, reference,
    FileAttachment.make({ uri: "data:image/png;base64,AAEC", mime: "image/png", name: "image.png" })] })
  const messages = yield* prepareFileMessages({ ...source, context: [user] })
  expect(messages).toEqual(toLLMMessages([user], model))
  const prepared = yield* LLMClient.prepare(LLM.request({ model, messages }))
  expect(JSON.stringify(prepared.body)).toContain("hello")
  expect(JSON.stringify(prepared.body)).toContain("data:image/png;base64,AAEC")
  expect(JSON.stringify(prepared.body)).not.toContain("evidence://")
})))

test("Source40: real default ToolOutputStore rejects a managed preview of an otherwise complete text read", () => fixture(({ directory, uri, filename }) => Effect.gen(function* () {
  const store = yield* ToolOutputStore.Service
  expect((yield* store.limits()).maxLines).toBe(2_000)
  const complete = yield* prepareFileMessages(input(directory, uri, filename))
  expect(JSON.stringify(complete)).toContain(JSON.stringify(text).slice(1, -1))
  const manyLines = "x\n".repeat(2_500)
  expect(Buffer.byteLength(manyLines)).toBeLessThan(ReadToolFileSystem.MAX_READ_BYTES)
  yield* Effect.promise(() => fs.writeFile(path.join(directory, filename), manyLines))
  const source = input(directory, uri, filename)
  const bounded = yield* store.bound({ sessionID: source.sessionID, toolCallID: "real-store-line-proof",
    output: { structured: {}, content: [{ type: "text", text: manyLines }] } })
  expect(bounded.outputPaths.length).toBeGreaterThan(0)
  expect(bounded.artifactRefs?.length).toBeGreaterThan(0)
  const error = yield* prepareFileMessages(source).pipe(Effect.flip)
  expect(error).toMatchObject({ _tag: "SessionRunner.FileAttachmentError" })
  expect(error.message).toContain("managed output limits")
  const replay = yield* prepareFileMessages(source).pipe(Effect.flip)
  expect(replay.message).toContain("managed output limits")
}), { realStore: true }))

test("Source40: real configured ToolOutputStore accepts complete text and rejects its bounded preview", () => fixture(({ directory, uri, filename }) => Effect.gen(function* () {
  const store = yield* ToolOutputStore.Service
  expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 64 })
  yield* Effect.promise(() => fs.writeFile(path.join(directory, filename), "ok"))
  const complete = yield* prepareFileMessages(input(directory, uri, filename))
  expect(JSON.stringify(complete)).toContain("ok")
  yield* Effect.promise(() => fs.writeFile(path.join(directory, filename), "one\ntwo\nthree"))
  const error = yield* prepareFileMessages(input(directory, uri, filename)).pipe(Effect.flip)
  expect(error.message).toContain("managed output limits")
}), { realStore: true, storeLimits: { max_lines: 2, max_bytes: 64 } }))

test("Source40: real title/main actor intents do not collide and each identical intent replays", () => fixture(({ directory, uri, filename }) => Effect.gen(function* () {
  const source = input(directory, uri, filename), { db } = yield* Database.Service
  const proposed = () => db.select().from(EventTable).all().pipe(Effect.map(rows => rows
    .filter(row => row.type === EventV2.versionedType(AgentRuntime.Event.ActionProposed.type, 1) && row.data.sessionID === source.sessionID)
    .map(row => Schema.decodeUnknownSync(AgentRuntime.Action)(row.data.action))))
  const build = yield* prepareFileMessages(source)
  const titleInput = { ...source, agent: AgentV2.ID.make("title") }
  const title = yield* prepareFileMessages(titleInput)
  expect(title).toEqual(build)
  const beforeReplay = yield* proposed()
  expect(beforeReplay).toHaveLength(2)
  expect(new Set(beforeReplay.map(action => action.id)).size).toBe(2)
  expect(beforeReplay.map(action => action.subject?.type === "session" ? action.subject.agent : undefined).sort()).toEqual(["build", "title"])
  yield* Effect.promise(() => fs.writeFile(path.join(directory, filename), "changed after completed settlements"))
  expect(yield* prepareFileMessages(source)).toEqual(build)
  expect(yield* prepareFileMessages(titleInput)).toEqual(title)
  expect(yield* proposed()).toEqual(beforeReplay)
  const alternate = yield* prepareFileMessages({ ...source, agent: AgentV2.ID.make("plan") })
  expect(JSON.stringify(alternate)).toContain("changed after completed settlements")
  expect(yield* proposed()).toHaveLength(3)
  yield* LLMClient.prepare(LLM.request({ model, messages: title }))
}), { realStore: true }))

test("Source43: settled same-actor file intent replays after owned unlink", () => fixture(({ directory, uri, filename }) => Effect.gen(function* () {
  const source = input(directory, uri, filename)
  const first = yield* prepareFileMessages(source)
  yield* Effect.promise(() => fs.unlink(path.join(directory, filename)))
  expect(yield* prepareFileMessages(source)).toEqual(first)
  yield* LLMClient.prepare(LLM.request({ model, messages: first }))
}), { realStore: true }))

test("Source43: declared folder URI becomes a governed nonrecursive bounded listing before wire preparation", () => fixture(({ directory, outside, filename }) => Effect.gen(function* () {
  const child = path.join(directory, "child")
  yield* Effect.promise(async () => {
    await fs.mkdir(child)
    await fs.writeFile(path.join(child, "nested-secret.txt"), "Do not recursively read this")
    await fs.symlink(path.dirname(outside), path.join(directory, "escaped-link"), "junction")
  })
  const source = input(directory, pathToFileURL(directory).href, "Owned folder 空格", "application/x-directory")
  const original = source.context[0].files?.[0]
  const messages = yield* prepareFileMessages(source)
  const context = messages[0].content[1]
  expect(context.type).toBe("text")
  if (context.type !== "text") return
  expect(context.text).toContain('Attached directory "Owned folder 空格" (application/x-directory):')
  const listing = JSON.parse(context.text.slice(context.text.indexOf("\n") + 1))
  expect(listing.entries.map((entry: { path: string }) => entry.path)).toEqual(["child" + path.sep, filename])
  expect(listing.truncated).toBe(false)
  const wire = yield* LLMClient.prepare(LLM.request({ model, messages }))
  expect(JSON.stringify(wire.body)).not.toContain("file://")
  expect(JSON.stringify(wire.body)).not.toContain("nested-secret")
  expect(JSON.stringify(wire.body)).not.toContain("escaped-link")
  expect(source.context[0].files?.[0]).toBe(original)
}), { realStore: true }))

test("Source43: an exact external directory grant lists only the admitted directory and honors entry pagination", () => fixture(({ directory, outside }) => Effect.gen(function* () {
  yield* Effect.promise(() => fs.writeFile(path.join(path.dirname(outside), "second.txt"), "not file content"))
  const source = input(directory, pathToFileURL(path.dirname(outside)).href + "?start=1&end=1", "external folder", "application/x-directory")
  const messages = yield* prepareFileMessages(source)
  const context = messages[0].content[1]
  if (context.type !== "text") throw Error("Expected listing text")
  const listing = JSON.parse(context.text.slice(context.text.indexOf("\n") + 1))
  expect(listing.entries).toEqual([{ path: "outside.txt", type: "file" }])
  expect(listing.truncated).toBe(true)
  expect(listing.next).toBe(2)
  const wire = yield* LLMClient.prepare(LLM.request({ model, messages }))
  expect(JSON.stringify(wire.body)).not.toContain("Owned explicitly attached external content")
}), { realStore: true }))

test("Source43: declared directory cannot relabel a plain file", () => fixture(({ directory, uri }) => Effect.gen(function* () {
  const failure = yield* prepareFileMessages(input(directory, uri, "not-a-folder", "application/x-directory")).pipe(Effect.flip)
  expect(failure.message).toContain("does not identify a directory")
})))

test("Source43: directory listing keeps managed byte bounds instead of accepting a preview", () => fixture(({ directory }) => Effect.gen(function* () {
  const failure = yield* prepareFileMessages(input(directory, pathToFileURL(directory).href, "bounded folder", "application/x-directory")).pipe(Effect.flip)
  expect(failure.message).toContain("managed output limits")
}), { realStore: true, storeLimits: { max_lines: 100, max_bytes: 32 } }))

test("Source43: settled directory intent replays its original listing after owned removal", () => fixture(({ directory }) => Effect.gen(function* () {
  const target = path.join(directory, "replay-folder")
  yield* Effect.promise(async () => { await fs.mkdir(target); await fs.writeFile(path.join(target, "first.txt"), "not recursively read") })
  const source = input(directory, pathToFileURL(target).href, "replay folder", "application/x-directory")
  const first = yield* prepareFileMessages(source)
  yield* Effect.promise(() => fs.rm(target, { recursive: true }))
  expect(yield* prepareFileMessages(source)).toEqual(first)
}), { realStore: true }))
