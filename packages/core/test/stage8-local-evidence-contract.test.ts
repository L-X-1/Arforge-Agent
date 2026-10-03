import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

test("stage 8 local evidence runner is bounded to reviewed integration suites", async () => {
  const script = await readFile(resolve(root, "script/run-stage8-local-evidence.ts"), "utf8")
  expect(script).toContain("capability_revocation")
  expect(script).toContain("background_visibility_stop_audit")
  expect(script).toContain("local-integration")
  expect(script).toContain("external_network: false")
  expect(script).toContain("production_data_changed: false")
  expect(script).toContain("release-owner review")
})
