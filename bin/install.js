#!/usr/bin/env node

/** Validate and hydrate the private unified Bun workspace. */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOCAL_BUN = path.join(
  PACKAGE_ROOT,
  ".tools",
  "bun-1.3.14",
  process.platform === "win32" ? "bun.exe" : "bun",
)

function fail(message) {
  console.error(`[Arforge install error] ${message}`)
  process.exit(1)
}

const bun = process.env.ARFORGE_BUN || (fs.existsSync(LOCAL_BUN) ? LOCAL_BUN : "bun")
const probe = spawnSync(bun, ["--version"], {
  cwd: PACKAGE_ROOT,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
})
if (probe.error || probe.status !== 0) fail("Bun 1.3.14 or newer is required.")

const installed = spawnSync(bun, ["install", "--frozen-lockfile"], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
})
if (installed.error || installed.status !== 0) fail("Unified workspace dependency installation failed.")

console.log("Arforge unified workspace ready.")
