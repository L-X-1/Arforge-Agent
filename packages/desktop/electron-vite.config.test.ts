import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import config, { bundledMainProcessAssets, bundledMainProcessDependencies } from "./electron.vite.config"

test("bundles TypeScript workspace dependencies into the Electron main process", () => {
  expect(bundledMainProcessDependencies).toContain("@arforge-ai/core")
  expect(config.main?.build?.externalizeDeps).toMatchObject({
    exclude: bundledMainProcessDependencies,
  })
})

test("copies runtime assets referenced by the bundled Core package", () => {
  expect(bundledMainProcessAssets).toHaveLength(1)
  expect(existsSync(bundledMainProcessAssets[0]!.source)).toBe(true)
  expect(bundledMainProcessAssets[0]!.output.replaceAll("\\", "/")).toEndWith(
    "/packages/desktop/out/main/assets/models.json",
  )
})
