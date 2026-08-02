import type { PlaywrightTestConfig } from "@playwright/test"
import config from "./playwright.config"

const uncappedConfig: PlaywrightTestConfig = {
  ...config,
  outputDir: "../test-results/performance-uncapped",
  reporter: [["html", { outputFolder: "../playwright-report/performance-uncapped", open: "never" }], ["line"]],
  use: {
    ...config.use,
    launchOptions: {
      args: ["--disable-frame-rate-limit", "--disable-gpu-vsync"],
    },
  },
}

export default uncappedConfig
