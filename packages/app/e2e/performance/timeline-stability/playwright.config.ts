import type { PlaywrightTestConfig } from "@playwright/test"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import config from "../playwright.config"

const stabilityConfig: PlaywrightTestConfig = {
  ...config,
  testDir: dirname(fileURLToPath(import.meta.url)),
  testMatch: "**/*.spec.ts",
  testIgnore: [],
  outputDir: "../../test-results/timeline-stability",
  reporter: [["html", { outputFolder: "../../playwright-report/timeline-stability", open: "never" }], ["line"]],
  retries: 0,
  workers: 1,
  use: {
    ...config.use,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
}

export default stabilityConfig
