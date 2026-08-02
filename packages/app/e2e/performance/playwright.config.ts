import { chromium, type PlaywrightTestConfig } from "@playwright/test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import config from "../../playwright.config"
import { resolveBrowserExecutable } from "./playwright-browser"
import {
  playwrightBaseURL,
  playwrightReadinessPath,
  parsePlaywrightPort,
  quotePlaywrightCommandArgument,
  resolveInheritedPlaywrightPort,
  resolvePlaywrightBunExecutable,
  resolvePlaywrightPort,
  setPlaywrightPortEnvironment,
} from "./playwright-server"

const performanceDir = dirname(fileURLToPath(import.meta.url))
const externallyManagedServer = process.env.ARFORGE_PLAYWRIGHT_EXTERNAL_SERVER === "1"
const inheritedPort = externallyManagedServer
  ? parsePlaywrightPort(process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT)
  : resolveInheritedPlaywrightPort()
if (externallyManagedServer && inheritedPort === undefined) {
  throw new Error("Externally managed Playwright server is missing its owned port")
}
const port = inheritedPort ?? (await resolvePlaywrightPort(process.env.PLAYWRIGHT_PORT))
const baseURL = playwrightBaseURL(port)
const browser = resolveBrowserExecutable(chromium.executablePath(), process.env.PLAYWRIGHT_BROWSER_EXECUTABLE)
const runID = process.env.ARFORGE_PERFORMANCE_RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
const bun = resolvePlaywrightBunExecutable(performanceDir)
const temporaryServer = join(performanceDir, "playwright-temp-server.ts")
const inheritedWebServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer
setPlaywrightPortEnvironment(port, runID)

if (browser.source === "system") {
  console.warn(`[Arforge Playwright] managed Chromium is unavailable; using system browser ${browser.executablePath}`)
}

const performanceConfig: PlaywrightTestConfig = {
  ...config,
  testDir: join(performanceDir, "timeline"),
  testIgnore: [],
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  globalSetup: join(performanceDir, "playwright-global-setup.ts"),
  use: {
    ...config.use,
    baseURL,
    launchOptions: browser.executablePath ? { executablePath: browser.executablePath } : undefined,
  },
  webServer: externallyManagedServer
    ? undefined
    : {
        ...config.webServer,
        command: `${quotePlaywrightCommandArgument(bun)} ${quotePlaywrightCommandArgument(temporaryServer)}`,
        cwd: join(performanceDir, "../.."),
        url: `${baseURL}${playwrightReadinessPath(runID)}`,
        reuseExistingServer: false,
        timeout: Number(process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT ?? 180_000),
        env: {
          ...inheritedWebServer?.env,
          ARFORGE_PLAYWRIGHT_TEMP_PORT: String(port),
          ARFORGE_PLAYWRIGHT_TEMP_PORT_OWNER: String(process.pid),
          ARFORGE_PERFORMANCE_RUN_ID: runID,
        },
      },
}

export default performanceConfig
