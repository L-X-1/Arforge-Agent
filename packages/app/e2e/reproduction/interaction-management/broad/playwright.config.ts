import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { suites } from "./suites"
const audit = fileURLToPath(new URL("../../../../../../docs/ui-redesign/interaction-audit-v3-20261029/", import.meta.url))
const run = process.env.MANAGEMENT_BROAD_RUN ?? "initial"
export default defineConfig({
  testDir: import.meta.dirname + "/generated-tests", testMatch: "*.repro.ts", workers: 1, fullyParallel: false, retries: 0,
  timeout: 30000, expect: { timeout: 7000 }, globalTimeout: 480000,
  outputDir: audit + "/management-broad-" + run,
  reporter: [["line"],["json",{outputFile:audit+"/management-broad-"+run+".json"}]],
  webServer: { command: "node static-host.cjs", cwd: import.meta.dirname, url:"http://127.0.0.1:4481/__ready", reuseExistingServer:false, timeout:15000 },
  use: { baseURL:"http://127.0.0.1:4481", serviceWorkers:"block", trace:"retain-on-failure", screenshot:"only-on-failure",
    channel: "chrome",
    launchOptions:{args:["--disable-background-networking","--disable-sync","--no-first-run","--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]} },
  projects:suites.map(suite=>({name:suite,testMatch:suite+"*.repro.ts",use:{...devices["Desktop Chrome"],extraHTTPHeaders:{"x-management-suite":suite}}})),
})
