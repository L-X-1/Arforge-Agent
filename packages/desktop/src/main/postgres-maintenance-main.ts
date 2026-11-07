import { app, dialog, utilityProcess } from "electron"
import { APP_IDS, APP_NAMES, CHANNEL } from "./constants"
import { desktopProfile } from "./profile"
import { createQuitCoordinator, createStartupGate } from "./lifecycle"
import { ownPostgresMaintenance, postgresMaintenanceMessage, type PostgresMaintenanceResult } from "./postgres-maintenance"
import { postgresMaintenanceCopy } from "./postgres-maintenance-copy"

/** Explicit maintenance owns one utility; it never runs the normal main effect. */
export async function runPostgresMaintenance(mode: "migrate" | "invalid", workerPath: string) {
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Arforge Dev")
  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.arforge.desktop.dev"
  app.setAppUserModelId(appId)
  const profile = desktopProfile({
    appData: app.getPath("appData"), appId,
    commandLineUserData: app.commandLine.getSwitchValue("user-data-dir"),
    environmentUserData: process.env.ARFORGE_DESKTOP_USER_DATA_DIR,
  })
  app.setPath("userData", profile.userData)
  if (profile.sessionData) app.setPath("sessionData", profile.sessionData)
  const exclusive = app.requestSingleInstanceLock()
  await app.whenReady()
  const copy = postgresMaintenanceCopy(app.getLocale())
  if (!exclusive || mode === "invalid") {
    dialog.showErrorBox(copy.title, !exclusive ? copy.busy : copy.invalid)
    app.exit(1)
    return
  }
  const controller = new AbortController()
  const startup = createStartupGate()
  let owner: ReturnType<typeof ownPostgresMaintenance> | undefined
  const shutdown = createQuitCoordinator({
    stop: async () => { startup.close(); controller.abort(); await owner?.stop() },
    quit: () => app.quit(),
    onError: () => dialog.showErrorBox(copy.title, copy.cleanupPending),
  })
  const beforeQuit = (event: { preventDefault(): void }) => shutdown.beforeQuit(event)
  app.on("before-quit", beforeQuit)
  const confirmation = await dialog.showMessageBox({
    type: "warning", title: copy.title, message: copy.confirm, detail: copy.detail,
    buttons: [copy.cancel, copy.apply], defaultId: 0, cancelId: 0, noLink: true,
  })
  if (shutdown.requested || controller.signal.aborted) return
  if (confirmation.response !== 1) { app.off("before-quit", beforeQuit); app.exit(2); return }

  const env = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]))
  delete env.DEBUG
  const operation = await startup.start(() => {}, async () => {
    const child = utilityProcess.fork(workerPath, [], {
      env, stdio: "ignore", serviceName: "arforge postgres maintenance",
    })
    // Captured synchronously, before any await or shutdown can interleave.
    owner = ownPostgresMaintenance(child, { signal: controller.signal })
    return owner
  })
  const closeProgress = new AbortController()
  let finished = false
  void Promise.resolve().then(() => {
    if (finished || shutdown.requested || controller.signal.aborted) return undefined
    return dialog.showMessageBox({
    type: "info", title: copy.title, message: copy.progress, detail: copy.progressDetail,
    buttons: [copy.cancelRepair], cancelId: 0, signal: closeProgress.signal,
    })
  }).then(() => { if (!finished) controller.abort() }, () => { if (!finished) controller.abort() })
  let result: PostgresMaintenanceResult
  try {
    result = await operation.result
  } catch {
    finished = true
    closeProgress.abort()
    // Preserve the same no-exit-with-live-child rule as normal Desktop Quit.
    if (!shutdown.requested) dialog.showErrorBox(copy.title, copy.cleanupHeld)
    return
  }
  finished = true
  closeProgress.abort()
  if (shutdown.requested) return
  app.off("before-quit", beforeQuit)
  await dialog.showMessageBox({
    type: result.ok ? "info" : "error", title: copy.title,
    message: postgresMaintenanceMessage(result, app.getLocale()), buttons: [copy.close], noLink: true,
  })
  app.exit(result.ok ? 0 : result.code === "cancelled" ? 2 : 1)
}
