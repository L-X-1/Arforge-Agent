import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { basename, resolve, sep } from "node:path"

const loopbackHost = "127.0.0.1"
const temporaryPortOwnerKey = "ARFORGE_PLAYWRIGHT_TEMP_PORT_OWNER"

export function parsePlaywrightPort(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PLAYWRIGHT_PORT must be an integer between 1 and 65535; received "${value}"`)
  }
  return port
}

export function parsePlaywrightListenPort(value: string | undefined) {
  if (value === undefined || value.trim() === "") return 0

  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`ARFORGE_PLAYWRIGHT_TEMP_PORT must be an integer between 0 and 65535; received "${value}"`)
  }
  return port
}

function probePort(port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ host: loopbackHost, port, exclusive: true }, () => {
      const address = server.address()
      const detected = typeof address === "object" && address ? address.port : port
      server.close((error) => {
        if (error) reject(error)
        else resolve(detected)
      })
    })
  })
}

export async function resolvePlaywrightPort(value: string | undefined) {
  const requested = parsePlaywrightPort(value)
  if (requested === undefined) return probePort(0)

  try {
    return await probePort(requested)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`PLAYWRIGHT_PORT ${requested} is unavailable on ${loopbackHost}: ${reason}`, {
      cause: error,
    })
  }
}

export function playwrightBaseURL(port: number) {
  return `http://${loopbackHost}:${port}`
}

export function resolveInheritedPlaywrightPort(
  env: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
  parentPID = process.ppid,
) {
  const owner = env[temporaryPortOwnerKey]
  // Playwright evaluates the config in both the coordinator and its direct
  // worker. The worker must keep the coordinator's port, while a new shell
  // invocation must not trust a stale value left by an unrelated process.
  if (owner !== String(pid) && owner !== String(parentPID)) return undefined
  return parsePlaywrightPort(env.ARFORGE_PLAYWRIGHT_TEMP_PORT)
}

export function setPlaywrightPortEnvironment(port: number, runID: string, env: NodeJS.ProcessEnv = process.env) {
  env.ARFORGE_PLAYWRIGHT_TEMP_PORT = String(port)
  env[temporaryPortOwnerKey] = String(process.pid)
  env.ARFORGE_PERFORMANCE_RUN_ID = runID
}

export function playwrightReadinessPath(runID: string) {
  return `/__arforge_playwright_ready__/${encodeURIComponent(runID)}`
}

export function playwrightTemporaryOutputDir(appDir: string, runID: string) {
  const temporaryRoot = resolve(appDir, "e2e/.playwright-temp")
  const safeRunID = runID.replaceAll(/[^a-zA-Z0-9._-]/g, "_")
  const outDir = resolve(temporaryRoot, safeRunID)
  if (outDir === temporaryRoot || !outDir.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error(`Refusing to use an unsafe Playwright output directory: ${outDir}`)
  }
  return { temporaryRoot, outDir }
}

export function playwrightReadinessFile(appDir: string, runID: string) {
  const { temporaryRoot, outDir } = playwrightTemporaryOutputDir(appDir, runID)
  const readyFile = resolve(temporaryRoot, `${basename(outDir)}.ready.json`)
  if (!readyFile.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error(`Refusing to use an unsafe Playwright readiness file: ${readyFile}`)
  }
  return readyFile
}

export type PlaywrightServerManifest = {
  ready: true
  runID: string
  pid: number
  port: number
  baseURL: string
  readinessURL: string
  outDir: string
  startedAt: string
}

export function parsePlaywrightServerManifest(value: unknown, expectedRunID: string): PlaywrightServerManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Playwright temporary server manifest must be an object")
  }

  const manifest = value as Partial<PlaywrightServerManifest>
  if (
    manifest.ready !== true ||
    manifest.runID !== expectedRunID ||
    !Number.isInteger(manifest.pid) ||
    !Number.isInteger(manifest.port) ||
    (manifest.port ?? 0) < 1 ||
    (manifest.port ?? 0) > 65_535 ||
    typeof manifest.baseURL !== "string" ||
    typeof manifest.readinessURL !== "string" ||
    typeof manifest.outDir !== "string" ||
    typeof manifest.startedAt !== "string"
  ) {
    throw new Error(
      `Playwright temporary server manifest identity mismatch for ${expectedRunID}: ${JSON.stringify(value)}`,
    )
  }

  const expectedBaseURL = playwrightBaseURL(manifest.port!)
  const expectedReadinessURL = `${expectedBaseURL}${playwrightReadinessPath(expectedRunID)}`
  if (manifest.baseURL !== expectedBaseURL || manifest.readinessURL !== expectedReadinessURL) {
    throw new Error(
      `Playwright temporary server manifest endpoint mismatch: expected ${expectedReadinessURL}, received ${manifest.readinessURL}`,
    )
  }

  return manifest as PlaywrightServerManifest
}

export function resolvePlaywrightBunExecutable(
  performanceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
  exists: (path: string) => boolean = existsSync,
) {
  const override = env.PLAYWRIGHT_BUN_EXECUTABLE
  if (override) {
    if (!exists(override)) throw new Error(`PLAYWRIGHT_BUN_EXECUTABLE does not exist: ${override}`)
    return override
  }

  if (/^bun(?:\.exe)?$/i.test(basename(execPath)) && exists(execPath)) return execPath

  const bundled = resolve(performanceDir, "../../../../.tools/bun-1.3.14/bun.exe")
  if (exists(bundled)) return bundled

  return "bun"
}

export function resolvePlaywrightCLIExecutable(
  appDir: string,
  platform = process.platform,
  exists: (path: string) => boolean = existsSync,
) {
  const executable = resolve(appDir, `node_modules/.bin/playwright${platform === "win32" ? ".exe" : ""}`)
  if (!exists(executable)) {
    throw new Error(`Playwright CLI executable does not exist: ${executable}`)
  }
  return executable
}

export function quotePlaywrightCommandArgument(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`
}

export function playwrightScenarioServer(env: NodeJS.ProcessEnv = process.env) {
  const isolatedAppPort = parsePlaywrightPort(env.ARFORGE_PLAYWRIGHT_TEMP_PORT)
  if (isolatedAppPort) return playwrightBaseURL(isolatedAppPort)
  return `http://${env.PLAYWRIGHT_SERVER_HOST ?? loopbackHost}:${env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
}

export const playwrightServerHost = loopbackHost
