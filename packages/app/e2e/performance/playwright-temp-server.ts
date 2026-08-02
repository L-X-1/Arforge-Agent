import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build, preview, type Plugin, type PreviewServer } from "vite"
import {
  parsePlaywrightListenPort,
  playwrightBaseURL,
  playwrightReadinessFile,
  playwrightReadinessPath,
  playwrightServerHost,
  playwrightTemporaryOutputDir,
} from "./playwright-server"

const requestedPort = parsePlaywrightListenPort(process.env.ARFORGE_PLAYWRIGHT_TEMP_PORT)
const runID = process.env.ARFORGE_PERFORMANCE_RUN_ID

if (!runID) throw new Error("ARFORGE_PERFORMANCE_RUN_ID is required")

const appDir = resolve(import.meta.dirname, "../..")
const { temporaryRoot, outDir } = playwrightTemporaryOutputDir(appDir, runID)
const readyFile = playwrightReadinessFile(appDir, runID)
const readyFileDraft = `${readyFile}.${process.pid}.tmp`

const readinessPath = playwrightReadinessPath(runID)
let listeningPort = 0
const readinessPlugin: Plugin = {
  name: "arforge-playwright-readiness",
  configurePreviewServer(server) {
    server.middlewares.use(readinessPath, (_request, response) => {
      response.statusCode = 200
      response.setHeader("content-type", "application/json; charset=utf-8")
      response.setHeader("cache-control", "no-store")
      response.end(JSON.stringify({ ready: true, runID, port: listeningPort }))
    })
  },
}

let server: PreviewServer | undefined
let stopping = false

async function cleanup() {
  if (stopping) return
  stopping = true

  if (server) {
    await new Promise<void>((resolveClose, rejectClose) => {
      server!.httpServer.close((error) => {
        if (error) rejectClose(error)
        else resolveClose()
      })
    }).catch(() => undefined)
  }
  await rm(readyFileDraft, { force: true }).catch(() => undefined)
  await rm(readyFile, { force: true }).catch(() => undefined)
  await rm(outDir, { recursive: true, force: true }).catch(() => undefined)
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(0))
  })
}

process.once("uncaughtException", (error) => {
  console.error("[Arforge Playwright] temporary server crashed", error)
  void cleanup().finally(() => process.exit(1))
})

process.once("unhandledRejection", (error) => {
  console.error("[Arforge Playwright] temporary server rejected a promise", error)
  void cleanup().finally(() => process.exit(1))
})

await mkdir(temporaryRoot, { recursive: true })
await rm(outDir, { recursive: true, force: true })
await rm(readyFileDraft, { force: true })
await rm(readyFile, { force: true })

console.log(`[Arforge Playwright] building isolated application into ${outDir}`)
await build({
  root: appDir,
  configFile: join(appDir, "vite.config.ts"),
  logLevel: "warn",
  build: {
    outDir,
    emptyOutDir: true,
  },
})

server = await preview({
  root: appDir,
  configFile: join(appDir, "vite.config.ts"),
  logLevel: "warn",
  plugins: [readinessPlugin],
  build: {
    outDir,
  },
  preview: {
    host: playwrightServerHost,
    port: requestedPort,
    strictPort: true,
  },
})

const address = server.httpServer.address()
if (!address || typeof address === "string") {
  throw new Error("Playwright temporary server did not expose a TCP listening address")
}
listeningPort = address.port
const baseURL = playwrightBaseURL(listeningPort)
const readinessURL = `${baseURL}${readinessPath}`
const manifest = {
  ready: true as const,
  runID,
  pid: process.pid,
  port: listeningPort,
  baseURL,
  readinessURL,
  outDir,
  startedAt: new Date().toISOString(),
}
await writeFile(readyFileDraft, JSON.stringify(manifest, undefined, 2), "utf8")
await rename(readyFileDraft, readyFile)

console.log(`[Arforge Playwright] temporary server ready: ${readinessURL}`)
await new Promise<never>(() => undefined)
