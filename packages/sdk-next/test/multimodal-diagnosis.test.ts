import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

test(
  "embedded diagnostics API is local, structured, workspace-confined, and model-free",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "arforge-diagnostics-"))
    try {
      await writeFile(
        join(directory, "error.md"),
        `Traceback (most recent call last):
  File "app.py", line 3, in <module>
NameError: name 'process_order' is not defined
`,
      )
      await writeFile(join(directory, "orders.ts"), "export const process_order = (payload: unknown) => payload\n")
      await writeFile(join(directory, "error.png"), "not an actual image")
      await writeFile(
        join(directory, "index.html"),
        '<!doctype html><html><body><script src="https://cdn.example.test/app.js?token=secret&v=1"></script></body></html>',
      )
      const { Arforge } = await import("../src")
      const program = Effect.gen(function* () {
        const arforge = yield* Arforge.create()
        const diagnosed = yield* arforge.diagnostics.diagnose({
          location: { directory },
          filename: "error.md",
          limit: 4,
        })
        const override = yield* arforge.diagnostics.diagnose({
          location: { directory },
          filename: "error.png",
          extractedText: "AttributeError: object has no attribute 'process_order'",
          limit: 4,
        })
        const frontend = yield* arforge.diagnostics.diagnose({
          location: { directory },
          filename: "index.html",
          limit: 4,
          mode: "frontend",
        })
        const escaped = yield* Effect.flip(
          arforge.diagnostics.diagnose({
            location: { directory },
            filename: "../outside.txt",
          }),
        )

        expect(diagnosed).toMatchObject({
          schemaVersion: 1,
          localOnly: true,
          modelCalls: 0,
          success: true,
          source: { type: "document" },
        })
        expect(diagnosed.matches).toEqual(expect.arrayContaining([expect.objectContaining({ file: "orders.ts" })]))
        expect(diagnosed.suggestions.some((suggestion) => suggestion.includes("missing symbol"))).toBe(true)
        expect(override.source.type).toBe("provided_text")
        expect(override.matches).toEqual(expect.arrayContaining([expect.objectContaining({ file: "orders.ts" })]))
        expect(frontend.frontend?.assetLocalizationPreview).toMatchObject({
          status: "ready",
          execution: "preview_only",
          assetRoot: "vendor",
          networkScopeCount: 1,
          references: [{ kind: "script" }],
        })
        const previewURL = frontend.frontend?.assetLocalizationPreview?.references[0]?.url ?? ""
        expect(previewURL).toContain("token=%5BREDACTED%5D")
        expect(previewURL).not.toContain("secret")
        expect(frontend.frontend?.externalAssets[0]?.url).not.toContain("secret")
        expect(String(escaped)).toContain("Invalid diagnostic path")
      })
      await Effect.runPromise(Effect.scoped(program))
    } finally {
      await cleanup(directory)
    }
  },
  { timeout: 15_000 },
)

async function cleanup(directory: string) {
  Bun.gc(true)
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const transient =
        process.platform === "win32" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
      if (!transient || attempt >= 5) throw error
      Bun.gc(true)
      await Bun.sleep(100 * (attempt + 1))
    }
  }
}
