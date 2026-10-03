import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validateTsBoot } from "./arforge-ts-boot-gate"

test("workspace user-facing boot paths converge on the TypeScript CLI", async () => {
  const report = await validateTsBoot(path.resolve(import.meta.dir, ".."))

  expect(report.valid).toBe(true)
  expect(report.findings).toEqual([])
  expect(report.canonical_entrypoint).toBe("packages/arforge/src/index.ts")
  expect(report.checks.filter((check) => check.status === "fail")).toEqual([])
  expect(report.legacy_utility_scripts).toEqual([
    "audit:python-consumers",
    "brand:assets",
    "python:lint",
    "python:test",
  ])
})

test("boot gate fails closed when the root CLI script points at Python", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-ts-boot-"))
  await mkdir(path.join(root, "packages/arforge/src"), { recursive: true })
  await mkdir(path.join(root, "packages/desktop/src/main"), { recursive: true })
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "python -m arforge", cli: "python -m arforge" } }),
  )
  await writeFile(
    path.join(root, "packages/arforge/package.json"),
    JSON.stringify({ scripts: { dev: "bun run --conditions=browser ./src/index.ts" } }),
  )
  await writeFile(path.join(root, "packages/desktop/package.json"), JSON.stringify({ main: "./out/main/index.js" }))
  await writeFile(path.join(root, "packages/arforge/src/index.ts"), "await import('./cli-main')\n")
  await writeFile(
    path.join(root, "bin/arforge.js"),
    'const CLI_ENTRY = "packages/arforge/src/index.ts"\nspawn("bun", [CLI_ENTRY])\n',
  )
  await writeFile(path.join(root, "packages/desktop/src/main/index.ts"), "export {}\n")
  await writeFile(
    path.join(root, "packages/desktop/electron-builder.config.ts"),
    "export default { extraResources: [] }\n",
  )

  const report = await validateTsBoot(root)

  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "TSBOOT-003-dev")).toBe(true)
  expect(report.findings.some((finding) => finding.code === "TSBOOT-003-cli")).toBe(true)
})

test("boot gate rejects a duplicate arforge bin owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-ts-boot-bin-owner-"))
  await mkdir(path.join(root, "packages/arforge/src"), { recursive: true })
  await mkdir(path.join(root, "packages/core"), { recursive: true })
  await mkdir(path.join(root, "packages/desktop/src/main"), { recursive: true })
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "bun packages/arforge/src/index.ts", cli: "bun packages/arforge/src/index.ts" } }),
  )
  await writeFile(
    path.join(root, "packages/arforge/package.json"),
    JSON.stringify({
      name: "arforge",
      scripts: { dev: "bun run --conditions=browser ./src/index.ts" },
      bin: { arforge: "./bin/arforge" },
    }),
  )
  await writeFile(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({ name: "@arforge-ai/core", bin: { arforge: "./bin/arforge" } }),
  )
  await writeFile(path.join(root, "packages/desktop/package.json"), JSON.stringify({ main: "./out/main/index.js" }))
  await writeFile(path.join(root, "packages/arforge/src/index.ts"), "await import('./cli-main')\n")
  await writeFile(
    path.join(root, "bin/arforge.js"),
    'const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")\nconst CLI_ENTRY = path.join(PACKAGE_ROOT, "packages", "arforge", "src", "index.ts")\nspawn(bun, ["--conditions=browser", CLI_ENTRY])\n',
  )
  await writeFile(path.join(root, "packages/desktop/src/main/index.ts"), "export {}\n")
  await writeFile(
    path.join(root, "packages/desktop/electron-builder.config.ts"),
    "export default { extraResources: [] }\n",
  )

  const report = await validateTsBoot(root)

  expect(report.valid).toBe(false)
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      code: "TSBOOT-011-arforge-bin-owner",
      path: "packages/core/package.json",
    }),
  )
})

test("boot gate fails closed when a product process boundary launches Python", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-ts-boot-process-"))
  await mkdir(path.join(root, "packages/arforge/src"), { recursive: true })
  await mkdir(path.join(root, "packages/desktop/src/main"), { recursive: true })
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "bun packages/arforge/src/index.ts", cli: "bun packages/arforge/src/index.ts" } }),
  )
  await writeFile(
    path.join(root, "packages/arforge/package.json"),
    JSON.stringify({ scripts: { dev: "bun run --conditions=browser ./src/index.ts" } }),
  )
  await writeFile(path.join(root, "packages/desktop/package.json"), JSON.stringify({ main: "./out/main/index.js" }))
  await writeFile(path.join(root, "packages/arforge/src/index.ts"), 'spawn("python", ["-m", "arforge"]);\n')
  await writeFile(
    path.join(root, "bin/arforge.js"),
    'const CLI_ENTRY = "packages/arforge/src/index.ts"\nspawn("bun", [CLI_ENTRY])\n',
  )
  await writeFile(path.join(root, "packages/desktop/src/main/index.ts"), "export {}\n")
  await writeFile(
    path.join(root, "packages/desktop/electron-builder.config.ts"),
    "export default { extraResources: [] }\n",
  )

  const report = await validateTsBoot(root)

  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "TSBOOT-010-product-runtime-no-python-process")).toBe(true)
})
