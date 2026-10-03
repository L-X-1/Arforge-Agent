import { defineConfig, devices } from "@playwright/test"
import { resolveBrowserLaunchOptions } from "../../performance/playwright-browser"

const port = Number(process.env.PLAYWRIGHT_DIAGNOSTICS_PREVIEW_PORT ?? 4320)
const browserLaunchOptions = resolveBrowserLaunchOptions()

export default defineConfig({
  testDir: ".",
  testMatch: "diagnostics-preview.repro.ts",
  outputDir: "../../test-results/diagnostics-preview",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  webServer: {
    command: `bunx vite --config vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...browserLaunchOptions,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
