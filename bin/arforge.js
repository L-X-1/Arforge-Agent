#!/usr/bin/env node

/**
 * Development compatibility launcher for the unified TypeScript CLI.
 * The Python runtime remains an internal capability service and is never a
 * second user-facing session owner.
 */

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CLI_ENTRY = path.join(PACKAGE_ROOT, "packages", "arforge", "src", "index.ts")

function isBun(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  })
  return !result.error && result.status === 0 && /^\d+\.\d+\.\d+/.test(String(result.stdout).trim())
}

function findBun() {
  const explicit = process.env.ARFORGE_BUN
  const local = path.join(PACKAGE_ROOT, ".tools", "bun-1.3.14", process.platform === "win32" ? "bun.exe" : "bun")
  for (const candidate of [explicit, local, "bun"].filter(Boolean)) {
    if ((path.isAbsolute(candidate) && !fs.existsSync(candidate)) || !isBun(candidate)) continue
    return candidate
  }
  return null
}

function main() {
  if (!fs.existsSync(CLI_ENTRY)) {
    console.error(`[Arforge] Unified CLI source was not found: ${CLI_ENTRY}`)
    process.exitCode = 1
    return
  }
  const bun = findBun()
  if (!bun) {
    console.error("[Arforge] Bun 1.3.14 or newer was not found.")
    process.exitCode = 1
    return
  }

  const child = spawn(bun, ["--conditions=browser", CLI_ENTRY, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: path.isAbsolute(bun)
        ? `${path.dirname(bun)}${path.delimiter}${process.env.PATH || ""}`
        : process.env.PATH,
    },
  })

  child.on("error", (error) => {
    console.error(`[Arforge] Unable to start the unified CLI: ${error.message}`)
    process.exitCode = 1
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exitCode = code === null ? 1 : code
  })
}

main()
