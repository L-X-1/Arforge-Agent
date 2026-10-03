import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as Fallback from "../../src/lsp/fallback"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-lsp-fallback-"))
  roots.push(root)
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative)
    await Bun.write(file, source)
  }
  return root
}

describe("LSP index fallback", () => {
  test("finds deterministic symbols, definitions, and references", async () => {
    const root = await fixture({
      "sample.py": "def target():\n    return 1\n\ntarget()\n",
      "other.ts": "export function target() {}\n",
    })
    const file = path.join(root, "sample.py")

    const symbols = await Fallback.query("documentSymbol", { file, line: 0, character: 4 }, root)
    const definition = await Fallback.query("goToDefinition", { file, line: 0, character: 4 }, root)
    const references = await Fallback.query("findReferences", { file, line: 0, character: 4 }, root)
    const workspace = await Fallback.query("workspaceSymbol", { file: root, line: 0, character: 0 }, root, "target")

    expect(symbols).toHaveLength(1)
    expect((symbols as any[])[0]).toMatchObject({ name: "target", kind: 12 })
    expect((definition as any[]).map((item) => item.file)).toEqual(["other.ts", "sample.py"])
    expect((references as any[]).map((item) => item.file)).toEqual(["other.ts", "sample.py", "sample.py"])
    expect((workspace as any[]).map((item) => item.name)).toEqual(["target", "target"])
  })

  test("returns bounded diagnostics and fails closed outside the workspace", async () => {
    const root = await fixture({ "broken.ts": "const value = (\n" })
    const file = path.join(root, "broken.ts")
    const outside = path.join(path.dirname(root), "outside.ts")
    await writeFile(outside, "export const outside = true\n", "utf8")
    roots.push(outside)

    const diagnostics = await Fallback.query("diagnostics", { file, line: 0, character: 0 }, root)
    const escaped = await Fallback.query("documentSymbol", { file: outside, line: 0, character: 0 }, root)

    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: "ts-index-fallback",
        message: "Unclosed (",
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } },
      }),
    ])
    expect(escaped).toEqual([])
    await expect(readFile(outside, "utf8")).resolves.toContain("outside")
  })

  test("does not read files larger than the fallback limit", async () => {
    const root = await fixture({ "large.ts": "" })
    const file = path.join(root, "large.ts")
    await writeFile(file, "x".repeat(Fallback.MAX_FILE_BYTES + 1), "utf8")

    await expect(Fallback.query("documentSymbol", { file, line: 0, character: 0 }, root)).resolves.toEqual([])
  })

  test("matches the Python compile-diagnostic contract without starting Python", async () => {
    const root = await fixture({
      "unclosed.py": "def target():\n    return (\n\ntarget()\n",
      "missing-colon.py": "if True\n    pass\n",
      "unterminated.py": 'value = "oops\n',
      "valid.py":
        '"""if this is a docstring\nnot a block header\n"""\nvalues = [\n    1,\n]\ndef target():\n    return 1\n',
    })

    const query = (name: string) =>
      Fallback.query("diagnostics", { file: path.join(root, name), line: 0, character: 0 }, root)
    const unclosed = (await query("unclosed.py")) as any[]
    const missingColon = (await query("missing-colon.py")) as any[]
    const unterminated = (await query("unterminated.py")) as any[]
    const valid = (await query("valid.py")) as any[]

    expect(unclosed).toEqual([
      expect.objectContaining({
        source: "python-compile",
        message: "'(' was never closed",
        range: { start: { line: 1, character: 11 }, end: { line: 1, character: 12 } },
      }),
    ])
    expect(missingColon).toEqual([
      expect.objectContaining({
        source: "python-compile",
        message: "expected ':'",
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 8 } },
      }),
    ])
    expect(unterminated).toEqual([
      expect.objectContaining({
        source: "python-compile",
        message: "unterminated string literal (detected at line 1)",
        range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } },
      }),
    ])
    expect(valid).toEqual([])
  })
})
