import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { PreviewResources } from "@arforge-ai/core/preview-resources"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { PreviewResource } from "@arforge-ai/schema/preview-resource"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7V0AAAAASUVORK5CYII=", "base64")

function provide(directory: string) {
  const replacements: LayerNode.Replacements = [
    [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) })))],
    [FSUtil.node, LayerNode.compile(FSUtil.node)],
  ]
  return Effect.provide(AppNodeBuilder.build(LayerNode.group([PreviewResources.node]), replacements))
}

function withTmp<A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => body(tmp.path)))
}

describe("preview resource filesystem boundary", () => {
  it.live("reads UTF-8 CSS and a raster below the document directory", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "site", "assets"), { recursive: true })
      await fs.writeFile(path.join(directory, "site", "page.html"), "<h1>Preview</h1>")
      await fs.writeFile(path.join(directory, "site", "assets", "main.css"), "h1 { color: red }")
      await fs.writeFile(path.join(directory, "site", "assets", "pixel.png"), png)
    })
    const service = yield* PreviewResources.Service
    const reader = yield* service.open("site/page.html")
    const css = yield* reader.read("assets/main.css")
    expect(css.mime).toBe("text/css")
    expect(new TextDecoder().decode(css.bytes)).toBe("h1 { color: red }")
    const image = yield* reader.read("assets/pixel.png")
    expect(image.mime).toBe("image/png")
    expect(Buffer.from(image.bytes).equals(png)).toBe(true)
  }).pipe(provide(directory))))

  it.live("rejects traversal, private files and unsupported types without exposing paths", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "site"))
      await fs.writeFile(path.join(directory, "site", "page.html"), "Preview")
      await fs.writeFile(path.join(directory, "outside.css"), "body { color: red }")
    })
    const service = yield* PreviewResources.Service
    const reader = yield* service.open("site/page.html")
    for (const resource of ["../outside.css", "/outside.css", "C:/outside.css", "..\\outside.css", "%2e%2e/outside.css", ".env.css", "node_modules/a.css", "page.html", "code.js", "icon.svg", "font.woff2", "absent.png"]) {
      const result = yield* reader.read(resource).pipe(Effect.catch((error) => Effect.succeed(error)))
      expect(result).toBeInstanceOf(PreviewResources.ResourceError)
      if (result instanceof PreviewResources.ResourceError) expect(result.message).not.toContain(directory)
    }
  }).pipe(provide(directory))))

  it.live("opens only existing internal HTML documents", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(() => fs.writeFile(path.join(directory, "notes.md"), "Notes"))
    const service = yield* PreviewResources.Service
    for (const document of ["notes.md", "absent.html", "../page.html", path.join(directory, "page.html"), "C:\\outside\\page.html", "https://example.com/page.html"]) {
      const result = yield* service.open(document).pipe(Effect.catch((error) => Effect.succeed(error)))
      expect(result).toBeInstanceOf(PreviewResources.ResourceError)
    }
  }).pipe(provide(directory))))

  it.live("rejects malformed text, fake images and oversized resources", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fs.writeFile(path.join(directory, "page.html"), "Preview")
      await fs.writeFile(path.join(directory, "invalid.css"), Buffer.from([0xff, 0xfe, 0x00]))
      await fs.writeFile(path.join(directory, "nul.css"), "body\0{}")
      await fs.writeFile(path.join(directory, "fake.png"), "<script>alert(1)</script>")
      await fs.writeFile(path.join(directory, "huge.css"), Buffer.alloc(PreviewResource.MAX_CSS_BYTES + 1, 32))
      await fs.writeFile(path.join(directory, "huge.png"), Buffer.concat([png, Buffer.alloc(PreviewResource.MAX_ASSET_BYTES)]))
    })
    const service = yield* PreviewResources.Service
    const reader = yield* service.open("page.html")
    for (const resource of ["invalid.css", "nul.css", "fake.png", "huge.css", "huge.png"]) {
      const result = yield* reader.read(resource).pipe(Effect.catch((error) => Effect.succeed(error)))
      expect(result).toBeInstanceOf(PreviewResources.ResourceError)
    }
  }).pipe(provide(directory))))

  it.live("does not follow junctions or symbolic directories", () => withTmp((directory) => Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(directory, "site"))
      await fs.mkdir(path.join(directory, "shared"))
      await fs.writeFile(path.join(directory, "site", "page.html"), "Preview")
      await fs.writeFile(path.join(directory, "shared", "main.css"), "body {}")
      await fs.symlink(path.join(directory, "shared"), path.join(directory, "site", "alias"), process.platform === "win32" ? "junction" : "dir")
    })
    const service = yield* PreviewResources.Service
    const reader = yield* service.open("site/page.html")
    const result = yield* reader.read("alias/main.css").pipe(Effect.catch((error) => Effect.succeed(error)))
    expect(result).toBeInstanceOf(PreviewResources.ResourceError)
  }).pipe(provide(directory))))
})
