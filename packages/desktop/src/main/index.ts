import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"
import { createFileNativeActionJournal, createNativeActionRuntime } from "@arforge-ai/core/runtime/native-action"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { APP_IDS, APP_NAMES, CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { isolatedRuntimeEnv, shouldRunLegacyProfileMigration } from "./isolation-env"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { shouldDisableHardwareAcceleration } from "./rendering"
import { resolveRelaunchOptions } from "./relaunch"
import { cleanupStoreFiles } from "./store-cleanup"

const TEST_ONBOARDING = process.env.ARFORGE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"
const hardwareAccelerationDisabled = shouldDisableHardwareAcceleration()

// This must run before Electron's ready event. Hardware composition is the
// default; affected GPU/driver combinations can use
// ARFORGE_DISABLE_HARDWARE_ACCELERATION=1 for the conservative fallback.
if (hardwareAccelerationDisabled) app.disableHardwareAcceleration()

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  const acceptanceUserData = app.commandLine.getSwitchValue("user-data-dir")
  const isolatedAcceptanceInstance =
    process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" &&
    isAbsolute(acceptanceUserData) &&
    resolve(acceptanceUserData) === acceptanceUserData

  // on macOS apps run in `/` which can cause issues with ripgrep
  // A validated isolated acceptance instance must retain its explicitly scoped
  // workspace instead of silently switching back to the real user's home.
  if (!isolatedAcceptanceInstance) {
    try {
      process.chdir(homedir())
    } catch {}
  }

  process.env.ARFORGE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.arforge.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `arforge-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.ARFORGE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Arforge Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    isolatedAcceptanceInstance
      ? acceptanceUserData
      : onboardingTestRoot
        ? join(onboardingTestRoot, "desktop")
        : join(app.getPath("appData"), appId),
  )
  if (isolatedAcceptanceInstance) app.setPath("sessionData", join(acceptanceUserData, "session"))
  else if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  if (isolatedAcceptanceInstance) {
    app.setPath("documents", join(acceptanceUserData, "documents"))
    const isolatedEnv = isolatedRuntimeEnv(acceptanceUserData)
    for (const directory of Object.values(isolatedEnv)) mkdirSync(directory, { recursive: true })
    Object.assign(process.env, isolatedEnv)
  }
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch(
        resolveRelaunchOptions({
          isPackaged: app.isPackaged,
          execPath: process.execPath,
          appPath: app.getAppPath(),
          argv: process.argv,
          devHostExecPath: process.env.ARFORGE_DESKTOP_DEV_HOST_EXEC_PATH,
        }),
      )
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
    renderer: hardwareAccelerationDisabled ? "software" : "hardware",
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged && !app.commandLine.hasSwitch("remote-debugging-port"))
    app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!isolatedAcceptanceInstance && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"), { isolated: isolatedAcceptanceInstance })

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("arforge://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  if (
    shouldRunLegacyProfileMigration({
      isolatedAcceptance: isolatedAcceptanceInstance,
      onboardingTest: TEST_ONBOARDING,
    })
  )
    migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  app.setAsDefaultProtocolClient("arforge")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const nativeActions = createNativeActionRuntime({
    journal: createFileNativeActionJournal(join(app.getPath("userData"), "native-actions.jsonl")),
  })
  const recoveredNativeActions = yield* Effect.promise(() => nativeActions.recover())
  if (recoveredNativeActions.length > 0)
    logger.warn("native actions require recovery after the previous main-process lifecycle", {
      count: recoveredNativeActions.length,
      actionIDs: recoveredNativeActions.map((receipt) => receipt.actionID),
    })
  registerIpcHandlers({
    nativeActions,
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending: () => (isolatedAcceptanceInstance ? false : isFirstLaunchOnboardingPending()),
    finishFirstLaunchOnboarding: (createDefaultProject) =>
      isolatedAcceptanceInstance ? null : finishFirstLaunchOnboarding(createDefaultProject),
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    getRenderingMode: () => (hardwareAccelerationDisabled ? "software" : "hardware"),
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })
  registerWslIpcHandlers(wslServers, nativeActions)
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.ARFORGE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  // Fixed credentials from the environment take precedence over the default
  // random per-launch password, so the local server can be accessed with a
  // stable account (e.g. ARFORGE_SERVER_USERNAME / ARFORGE_SERVER_PASSWORD).
  const username = process.env.ARFORGE_SERVER_USERNAME ?? "arforge"
  const password = process.env.ARFORGE_SERVER_PASSWORD ?? randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, username, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username,
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  const windows = restoreMainWindows()
  if (windows.length) {
    createMenu({
      trigger: (id) => {
        const win = getLastFocusedWindow()
        if (win) sendMenuCommand(win, id)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
