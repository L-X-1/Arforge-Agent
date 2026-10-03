import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { TextDocument } from "@arforge-ai/core/text-document"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function provide(directory: string) {
  const replacements: LayerNode.Replacements = [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) })))],
    [FSUtil.node, LayerNode.compile(FSUtil.node)],
    [RollbackArtifact.node, RollbackArtifact.layerWith(path.join(directory, "rollback"))],
  ]
  return Effect.provide(AppNodeBuilder.build(
    LayerNode.group([TextDocument.node]), replacements,
  ))
}

function withTmp<A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(tmp.path)))
}

describe("workspace text documents", () => {
  it.live("reads UTF-8 and saves with a new exact-byte version", () => withTmp((directory) => Effect.gen(function* () {
    const file = path.join(directory, "notes.md")
    yield* Effect.promise(() => fs.writeFile(file, "# Before\n"))
    const before = yield* TextDocument.read("notes.md")
    expect(before.text).toBe("# Before\n")
    expect(before.version).toMatch(/^[a-f0-9]{64}$/)
    const after = yield* TextDocument.save({ path: "notes.md", baseVersion: before.version, text: "# After\n" })
    expect(after.version).not.toBe(before.version)
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("# After\n")
    expect(yield* TextDocument.read("notes.md")).toEqual(after)
  }).pipe(provide(directory))))

  it.live("preserves the UTF-8 BOM and CRLF bytes including the final newline", () => withTmp((directory) => Effect.gen(function* () {
    const file = path.join(directory, "windows.txt")
    yield* Effect.promise(() => fs.writeFile(file, "\uFEFFfirst\r\nsecond\r\n"))
    const before = yield* TextDocument.read("windows.txt")
    expect(before).toMatchObject({ text: "first\nsecond\n", bom: true, lineEnding: "crlf" })
    yield* TextDocument.save({ path: "windows.txt", baseVersion: before.version, text: "\u4f60\u597d\nlast\n" })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("\uFEFF\u4f60\u597d\r\nlast\r\n")
  }).pipe(provide(directory))))

  it.live("retains an external edit when the submitted base version is stale", () => withTmp((directory) => Effect.gen(function* () {
    const file = path.join(directory, "notes.txt")
    yield* Effect.promise(() => fs.writeFile(file, "base"))
    const before = yield* TextDocument.read("notes.txt")
    yield* Effect.promise(() => fs.writeFile(file, "external"))
    const result = yield* TextDocument.save({ path: "notes.txt", baseVersion: before.version, text: "my draft" }).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    )
    expect(result).toMatchObject({ reason: "conflict" })
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("external")
  }).pipe(provide(directory))))

  it.live("rejects missing files, directories and escaping paths", () => withTmp((directory) => Effect.gen(function* () {
    for (const filePath of ["missing.txt", ".", "../outside.txt", "C:/outside.txt", "notes.txt:stream", "bad\0path"])
      expect(yield* TextDocument.read(filePath).pipe(Effect.catch((error) => Effect.succeed(error))))
        .toBeInstanceOf(TextDocument.DocumentError)
    expect(yield* TextDocument.save({ path: "missing.txt", baseVersion: "a".repeat(64), text: "no create" }).pipe(
      Effect.catch((error) => Effect.succeed(error)),
    )).toBeInstanceOf(TextDocument.DocumentError)
    expect(yield* Effect.promise(() => fs.access(path.join(directory, "missing.txt")).then(() => true, () => false))).toBe(false)
  }).pipe(provide(directory))))

  it.live("rejects symlink or junction ancestors", () => withTmp((directory) => Effect.gen(function* () {
    const original = path.join(directory, "original")
    yield* Effect.promise(() => fs.mkdir(original))
    yield* Effect.promise(() => fs.writeFile(path.join(original, "notes.txt"), "protected"))
    yield* Effect.promise(() => fs.symlink(original, path.join(directory, "alias"), process.platform === "win32" ? "junction" : "dir"))
    expect(yield* TextDocument.read("alias/notes.txt").pipe(Effect.catch((error) => Effect.succeed(error))))
      .toBeInstanceOf(TextDocument.DocumentError)
  }).pipe(provide(directory))))

  it.live("refuses invalid encodings, binary content and ambiguous newlines without writing", () => withTmp((directory) => Effect.gen(function* () {
    const values = [Buffer.from([0xff, 0xfe, 0x41, 0]), Buffer.from([0xc3, 0x28]), Buffer.from("a\0b"), Buffer.from("a\r\nb\n"), Buffer.from("a\rb")]
    for (const [index, content] of values.entries()) {
      const name = `unsupported-${index}.txt`
      const file = path.join(directory, name)
      yield* Effect.promise(() => fs.writeFile(file, content))
      expect(yield* TextDocument.read(name).pipe(Effect.catch((error) => Effect.succeed(error))))
        .toMatchObject({ reason: "unsupported" })
      expect(yield* Effect.promise(() => fs.readFile(file))).toEqual(content)
    }
  }).pipe(provide(directory))))

  it.live("bounds input size and rejects invalid Unicode edits", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(() => fs.writeFile(path.join(directory, "large.txt"), "x".repeat(500_001)))
    expect(yield* TextDocument.read("large.txt").pipe(Effect.catch((error) => Effect.succeed(error))))
      .toMatchObject({ reason: "unsupported" })
    const file = path.join(directory, "small.txt")
    yield* Effect.promise(() => fs.writeFile(file, "safe"))
    const before = yield* TextDocument.read("small.txt")
    for (const text of ["x".repeat(500_001), "\ud800", "a\r\nb", "a\0b"]) {
      expect(yield* TextDocument.save({ path: "small.txt", baseVersion: before.version, text }).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      )).toMatchObject({ reason: "unsupported" })
    }
    expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("safe")
  }).pipe(provide(directory))))
})
