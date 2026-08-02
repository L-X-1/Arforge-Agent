import { app, dialog } from "electron"
import { createUpdaterController } from "./updater-controller"

export function setupAutoUpdater(stop: () => Promise<void>) {
  return createUpdaterController({
    enabled: false,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: async () => null,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
    },
    persistence: {
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
    },
    stop,
  })
}

export async function showUpdaterDialog(_controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  if (!alertOnFail) return
  await dialog.showMessageBox({
    type: "info",
    message: "本地版本不包含自动更新服务，请使用本地构建流程更新。",
    title: "自动更新已禁用",
  })
}
