import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
const audit = fileURLToPath(new URL("../../../../../docs/ui-redesign/interaction-audit-v3-20261029/", import.meta.url))
const run = process.env.MANAGEMENT_AUDIT_RUN ?? "before"
export default defineConfig({
  testDir: import.meta.dirname, testMatch: "management.repro.ts", workers: 1, retries: 0, fullyParallel: false,
  timeout: 25000, expect: { timeout: 5000 },
  outputDir: audit + "/management-browser-" + run,
  reporter: [["line"], ["json", { outputFile: audit + "/management-browser-" + run + ".json" }]],
  webServer: {
    command: 'bun "../../../node_modules/vite/bin/vite.js" --config vite.config.ts --host 127.0.0.1 --port 4479 --strictPort',
    cwd: import.meta.dirname, url: "http://127.0.0.1:4479", reuseExistingServer: false, timeout: 120000,
  },
  use: { baseURL: "http://127.0.0.1:4479", serviceWorkers: "block", screenshot: "only-on-failure", trace: "retain-on-failure",
    channel: "chrome",
    launchOptions: { args: ["--disable-background-networking", "--disable-sync", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] } },
  projects: [{ name: "local-chrome", use: { ...devices["Desktop Chrome"] } }],
})
