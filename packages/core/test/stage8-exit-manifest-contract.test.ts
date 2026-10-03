import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

test("stage 8 exit manifest builder binds checkpoint and keeps missing evidence non-pass", async () => {
  const script = await readFile(resolve(root, "script/build-stage8-exit-evidence.ts"), "utf8")
  expect(script).toContain('"rev-parse", "HEAD"')
  expect(script).toContain('"rev-parse", "HEAD^{tree}"')
  expect(script).toContain('status: "missing"')
  expect(script).toContain("--require-complete")
  expect(script).toContain("DO_NOT_EXIT")
})
