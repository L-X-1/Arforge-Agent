import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { PlaywrightTestConfig } from "@playwright/test"
import baseConfig from "../playwright.config"

const config: PlaywrightTestConfig = {
  ...baseConfig,
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: "workbench-preview.spec.ts",
  outputDir: `../../../test-results/workbench-v2-${process.pid}`,
}

export default config
