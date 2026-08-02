#!/usr/bin/env bun

import { fileURLToPath } from "node:url"
import { loadProductEnv } from "@arforge-ai/core/config/product-env"

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url))
// Bun loads a workspace `.env` before this entrypoint. The interactive Arforge
// CLI must use the same selected private profile as Desktop, otherwise a stale
// development database password can silently override ~/.arforge/.env.
loadProductEnv({ workspaceRoot, override: true })

await import("./cli-main")
