import { dirname, join, resolve } from "node:path"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { loadProductEnv } from "@arforge-ai/core/config/product-env"
import { checkHealth, waitForHealth } from "./health"
import { createOwnedProcessStop } from "./lifecycle"
export { checkHealth } from "./health"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "arforge server"
const SIDECAR_START_STALL_TIMEOUT = 60_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onListener?: (listener: SidecarListener) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string, options: { readonly isolated?: boolean } = {}) {
  const shell = options.isolated || process.platform === "win32" ? null : getUserShell()
  if (shell) Object.assign(process.env, loadShellEnv(shell, getLogger()))

  // The desktop launcher is an interactive product boundary. Its selected
  // private env file must replace stale variables inherited from terminals,
  // IDEs, or an earlier development session.
  const productEnv = options.isolated
    ? undefined
    : loadProductEnv({
        workspaceRoot: app.isPackaged ? undefined : resolve(app.getAppPath(), "../.."),
        override: true,
      })
  Object.assign(process.env, {
    ARFORGE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    ARFORGE_EXPERIMENTAL_FILEWATCHER: "true",
    ARFORGE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  return productEnv
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  username: string,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()
  const healthAbort = new AbortController()
  const stop = createOwnedProcessStop({
    exited: () => exited,
    exit: exit.promise,
    requestStop: () => {
      healthAbort.abort(new Error("Owned backend is stopping"))
      child.postMessage({ type: "stop" })
    },
    kill: () => {
      child.kill()
    },
  })
  const listener = { stop }

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
    healthAbort.abort(new Error(`Owned backend exited with code ${code}`))
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))
  // Register ownership before readiness: Quit during startup must also stop it.
  options.onListener?.(listener)

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        options.onStderr?.(
          ["sidecar initialization failed", message.error.stack ?? message.error.message].filter(Boolean).join("\n"),
        )
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      username,
      password,
      userDataPath: options.userDataPath,
    })
  }).catch(async (error) => {
    await stop()
    throw error
  })

  const wait = waitForHealth({
    check: (signal) => checkHealth(`http://${hostname}:${port}`, username, password, signal),
    signal: healthAbort.signal,
  })
  return {
    listener,
    health: { wait },
  }
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  const bundledSDK = app.isPackaged
    ? join(process.resourcesPath, "plugin-sdk")
    : join(dirname(fileURLToPath(import.meta.url)), "assets", "plugin-sdk")
  if (!existsSync(join(bundledSDK, "package.json"))) {
    throw new Error("Bundled plugin SDK is missing. Rebuild or reinstall Arforge; no registry fallback was attempted.")
  }
  env.ARFORGE_BUNDLED_PLUGIN_SDK = bundledSDK
  if (process.platform === "linux") delete env.LD_PRELOAD
  return env
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
