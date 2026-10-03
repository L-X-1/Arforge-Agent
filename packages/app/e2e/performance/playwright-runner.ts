import { spawn, type ChildProcess } from "node:child_process"
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  parsePlaywrightServerManifest,
  playwrightReadinessFile,
  playwrightTemporaryOutputDir,
  resolvePlaywrightBunExecutable,
  resolvePlaywrightCLIExecutable,
  setPlaywrightPortEnvironment,
  type PlaywrightServerManifest,
} from "./playwright-server"

const performanceDir = import.meta.dirname
const appDir = resolve(performanceDir, "../..")
const runID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`
const readyFile = playwrightReadinessFile(appDir, runID)
const { outDir } = playwrightTemporaryOutputDir(appDir, runID)
const profileArchiveDir = process.env.TIMELINE_CPU_PROFILE === "1"
  ? resolve(appDir, "../../artifacts/timeline-cpu", runID)
  : undefined
const bun = resolvePlaywrightBunExecutable(performanceDir)
const temporaryServer = join(performanceDir, "playwright-temp-server.ts")
const playwrightCLI = resolvePlaywrightCLIExecutable(appDir)
const startupTimeout = Number(process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT ?? 180_000)

let serverProcess: ChildProcess | undefined
let testProcess: ChildProcess | undefined
let interrupted = false

function mirrorOutput(child: ChildProcess) {
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
}

function waitForExit(child: ChildProcess) {
  return new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("exit", (code, signal) => {
      if (typeof code === "number") resolveExit(code)
      else resolveExit(signal ? 128 : 1)
    })
  })
}

async function retainProfileAssets() {
  if (!profileArchiveDir) return
  const source = join(outDir, "assets")
  const destination = join(profileArchiveDir, "assets")
  const entries = await readdir(source, { withFileTypes: true })
  await mkdir(destination, { recursive: true })
  const retained: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.js(?:\.map)?$/.test(entry.name)) continue
    await copyFile(join(source, entry.name), join(destination, entry.name))
    retained.push(entry.name)
  }
  await writeFile(join(profileArchiveDir, "manifest.json"), JSON.stringify({
    runID,
    capturedAt: new Date().toISOString(),
    testExitCode: exitCode,
    sourceBuildDir: outDir,
    assets: retained,
  }, null, 2), "utf8")
  console.log("TIMELINE_PROFILE_ASSETS_SAVED", JSON.stringify({
    directory: profileArchiveDir,
    files: retained.length,
    sourceMaps: retained.filter((name) => name.endsWith(".map")).length,
  }))
}

async function waitForServerManifest(child: ChildProcess): Promise<PlaywrightServerManifest> {
  const deadline = Date.now() + startupTimeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Playwright temporary server exited before readiness with code ${child.exitCode}`)
    }

    try {
      const manifest = parsePlaywrightServerManifest(JSON.parse(await readFile(readyFile, "utf8")), runID)
      const response = await fetch(manifest.readinessURL, {
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) {
        const identity = (await response.json()) as { ready?: boolean; runID?: string; port?: number }
        if (identity.ready === true && identity.runID === runID && identity.port === manifest.port) return manifest
      }
    } catch {
      // The build and atomic readiness manifest may not exist yet.
    }

    await Bun.sleep(100)
  }
  throw new Error(`Playwright temporary server was not ready after ${startupTimeout}ms`)
}

async function stopServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([waitForExit(child), Bun.sleep(5_000)])
  if (child.exitCode === null) {
    child.kill("SIGKILL")
    await Promise.race([waitForExit(child), Bun.sleep(5_000)])
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interrupted = true
    testProcess?.kill(signal)
    void stopServer(serverProcess)
  })
}

let exitCode = 1
try {
  await rm(readyFile, { force: true })
  await rm(outDir, { recursive: true, force: true })

  serverProcess = spawn(bun, [temporaryServer], {
    cwd: appDir,
    env: {
      ...process.env,
      ARFORGE_PLAYWRIGHT_TEMP_PORT: "0",
      ARFORGE_PERFORMANCE_RUN_ID: runID,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  mirrorOutput(serverProcess)

  const manifest = await waitForServerManifest(serverProcess)
  console.log(`[Arforge Playwright] runner verified atomic port ${manifest.port} for ${runID}`)

  const playwrightArgs = process.argv.slice(2)
  if (!playwrightArgs.some((argument) => argument === "--config" || argument.startsWith("--config="))) {
    playwrightArgs.unshift("--config", "e2e/performance/playwright.config.ts")
  }

  const testEnvironment = { ...process.env }
  setPlaywrightPortEnvironment(manifest.port, runID, testEnvironment)
  testEnvironment.ARFORGE_PLAYWRIGHT_EXTERNAL_SERVER = "1"
  testEnvironment.ARFORGE_TIMELINE_PROFILE_DIR = profileArchiveDir ?? ""

  testProcess = spawn(playwrightCLI, ["test", ...playwrightArgs], {
    cwd: appDir,
    env: testEnvironment,
    stdio: "inherit",
    windowsHide: true,
  })
  exitCode = await waitForExit(testProcess)
} catch (error) {
  console.error("[Arforge Playwright] isolated runner failed", error)
  exitCode = 1
} finally {
  // The temporary server also removes its build during shutdown. Archive first.
  await retainProfileAssets().catch((error) => {
    console.warn("TIMELINE_PROFILE_ASSETS_ERROR", error instanceof Error ? error.message : String(error))
  })
  await stopServer(serverProcess)
  await rm(readyFile, { force: true }).catch(() => undefined)
  await rm(outDir, { recursive: true, force: true }).catch(() => undefined)
  console.log(`[Arforge Playwright] runner cleanup complete for ${runID}`)
}

process.exitCode = interrupted && exitCode === 0 ? 130 : exitCode
