import { afterAll, describe, expect, test } from "bun:test"
import { addDefaultParsers, destroyTreeSitterClient, getTreeSitterClient } from "@opentui/core"
import { isAbsolute, relative, resolve } from "node:path"
import parsers from "../src/parsers-config"
import manifest from "../src/tree-sitter-assets/manifest.json" with { type: "json" }

const assetRoot = resolve(import.meta.dir, "../src/tree-sitter-assets")
const selected = parsers.parsers.filter((parser) => parser.filetype === "vue" || parser.filetype === "clojure")
const expectedFiles = Object.keys(manifest.assets).sort()

afterAll(async () => {
  await destroyTreeSitterClient()
})

describe("private bundled Tree-sitter parsers", () => {
  test("resolves every Vue and Clojure runtime asset locally with the audited digest", async () => {
    const paths = selected.flatMap((parser) => [parser.wasm, ...parser.queries.highlights])
    expect(selected.map((parser) => parser.filetype).sort()).toEqual(["clojure", "vue"])
    expect(paths.every((path) => isAbsolute(path) && !path.startsWith("http"))).toBe(true)

    const actualFiles = paths.map((path) => relative(assetRoot, path).replaceAll("\\", "/")).sort()
    expect(actualFiles).toEqual(expectedFiles)

    for (const path of paths) {
      const key = relative(assetRoot, path).replaceAll("\\", "/") as keyof typeof manifest.assets
      const bytes = await Bun.file(path).bytes()
      expect(bytes.byteLength).toBe(manifest.assets[key].bytes)
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(manifest.assets[key].sha256)
      if (path.endsWith(".wasm")) expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d])
    }
  })

  test(
    "loads and highlights Vue and Clojure without network access",
    async () => {
      addDefaultParsers(selected)
      const client = getTreeSitterClient()
      await client.initialize()

      expect(await client.preloadParser("vue")).toBe(true)
      expect(await client.preloadParser("clojure")).toBe(true)

      const vue = await client.highlightOnce("<template><div>{{ message }}</div></template>", "vue")
      const clojure = await client.highlightOnce("(defn greet [name] (println name))", "clojure")
      expect(vue.error).toBeUndefined()
      expect(vue.highlights?.length).toBeGreaterThan(0)
      expect(clojure.error).toBeUndefined()
      expect(clojure.highlights?.length).toBeGreaterThan(0)
    },
    30_000,
  )
})
