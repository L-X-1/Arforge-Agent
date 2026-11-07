import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import config, { bundledMainProcessAssets, bundledMainProcessDependencies } from "./electron.vite.config"

test("packages the PostgreSQL utility as its own entry, without a source/Bun command", () => {
  expect(config.main?.build?.rollupOptions?.input).toMatchObject({
    index: "src/main/index.ts",
    "postgres-maintenance-worker": "src/main/postgres-maintenance-worker.ts",
  })
})

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

test("prod main, preload and renderer compile the same normal version/channel without TEST branding", async () => {
  const previous = process.env.ARFORGE_CHANNEL
  process.env.ARFORGE_CHANNEL = "prod"
  try {
    const prod = (await import("./electron.vite.config.ts?usage=prod")).default
    for (const target of [prod.main, prod.preload, prod.renderer]) {
      expect(target?.define?.ARFORGE_CHANNEL).toBe('"prod"')
      expect(target?.define?.ARFORGE_VERSION).toBe('"1.0.0"')
      const compiled = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../core/src/installation/version.ts", import.meta.url))],
        target: "node",
        format: "esm",
        define: {
          ARFORGE_CHANNEL: String(target?.define?.ARFORGE_CHANNEL),
          ARFORGE_VERSION: String(target?.define?.ARFORGE_VERSION),
        },
      })
      expect(compiled.success).toBe(true)
      const source = await compiled.outputs[0]!.text()
      const version = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
      expect(version.InstallationChannel).toBe("prod")
      expect(version.InstallationVersion).toBe("1.0.0")
      expect(version.ProductDisplayVersion).toBe("Arforge 1.0.0")
    }
  } finally {
    if (previous === undefined) delete process.env.ARFORGE_CHANNEL
    else process.env.ARFORGE_CHANNEL = previous
  }
})
