#!/usr/bin/env bun

import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { loadProductEnv } from "@arforge-ai/core/config/product-env"

const windowsSandboxHelperFlag = "--arforge-windows-sandbox-helper"
const windowsSandboxCleanupFlag = "--arforge-windows-sandbox-cleanup"
const windowsSandboxMode =
  process.argv[1] === windowsSandboxHelperFlag || process.argv[1] === windowsSandboxCleanupFlag
    ? process.argv[1]
    : process.argv[2] === windowsSandboxHelperFlag || process.argv[2] === windowsSandboxCleanupFlag
      ? process.argv[2]
      : undefined
const windowsSandboxPayloadIndex = windowsSandboxMode ? (process.argv[1] === windowsSandboxMode ? 2 : 3) : undefined

if (process.platform === "win32" && windowsSandboxPayloadIndex !== undefined) {
  const { runWindowsSandboxCleanup, runWindowsSandboxLauncher } = await import("./sandbox/windows-launcher")
  process.exitCode =
    windowsSandboxMode === windowsSandboxCleanupFlag
      ? runWindowsSandboxCleanup(process.argv[windowsSandboxPayloadIndex])
      : runWindowsSandboxLauncher(process.argv[windowsSandboxPayloadIndex])
} else {
  const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url))
  // Bun loads a workspace `.env` before this entrypoint. The interactive Arforge
  // CLI must use the same selected private profile as Desktop, otherwise a stale
  // development database password can silently override ~/.arforge/.env.
  // When ARFORGE_HOME is explicit (tests, isolated profiles and embedded
  // users), resolve the env file from that profile instead of accidentally
  // importing the host user's ~/.arforge/.env. The default path remains the
  // normal user profile when ARFORGE_HOME is absent.
  const configuredHome = process.env.ARFORGE_HOME?.trim()
  const disableProjectConfig = ["1", "true"].includes(
    process.env.ARFORGE_DISABLE_PROJECT_CONFIG?.trim().toLowerCase() ?? "",
  )
  loadProductEnv({
    // `ARFORGE_DISABLE_PROJECT_CONFIG` is also the explicit test/embedded
    // boundary: do not let the repository .env reintroduce credentials when a
    // caller intentionally supplied an isolated profile.
    workspaceRoot: disableProjectConfig ? undefined : workspaceRoot,
    home: configuredHome ? resolve(configuredHome) : undefined,
    override: true,
  })

  await import("./cli-main")
}
