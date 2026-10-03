import type { PlaywrightTestConfig } from "@playwright/test"
import performanceConfig from "../playwright.config"

const config: PlaywrightTestConfig = {
  ...performanceConfig,
  testDir: import.meta.dirname,
  testMatch: "conversation-review.spec.ts",
  outputDir: "../../test-results/conversation-review",
  reporter: [["line"]],
}

export default config
