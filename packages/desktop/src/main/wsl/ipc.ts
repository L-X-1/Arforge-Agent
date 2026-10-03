import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { NativeActionKind } from "@arforge-ai/core/runtime/native-action"
import type { WslServersController } from "./servers"
import { requireWslIpcString, requireWslIpcStrings } from "./policy"
import type { WslServersState } from "../../preload/types"
import { executeNative, type NativeActionRuntime } from "../native-action-bridge"

export function registerWslIpcHandlers(controller: WslServersController, nativeActions: NativeActionRuntime) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  ipcMain.handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipcMain.handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipcMain.handle("wsl-servers-get-state", () => controller.getState())
  ipcMain.handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  ipcMain.handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  ipcMain.handle("wsl-servers-install-wsl", (event: IpcMainInvokeEvent) =>
    executeNative(nativeActions, event, NativeActionKind.process, "wsl-install", {}, () => controller.installWsl()),
  )
  ipcMain.handle("wsl-servers-install-distro", (event: IpcMainInvokeEvent, name: string) => {
    const distro = requireWslIpcString("distro", name)
    return executeNative(nativeActions, event, NativeActionKind.process, "wsl-install-distro", { distro }, () =>
      controller.installDistro(distro),
    )
  })
  ipcMain.handle("wsl-servers-probe-addable", (_event: IpcMainInvokeEvent, distros: string[]) =>
    controller.probeAddable(requireWslIpcStrings("distro", distros)),
  )
  ipcMain.handle("wsl-servers-install-arforge", (event: IpcMainInvokeEvent, name: string) => {
    const distro = requireWslIpcString("distro", name)
    return executeNative(nativeActions, event, NativeActionKind.process, "wsl-install-arforge", { distro }, () =>
      controller.installArforge(distro),
    )
  })
  ipcMain.handle("wsl-servers-open-terminal", (event: IpcMainInvokeEvent, name: string) => {
    const distro = requireWslIpcString("distro", name)
    return executeNative(nativeActions, event, NativeActionKind.process, "wsl-open-terminal", { distro }, () =>
      controller.openTerminal(distro),
    )
  })
  ipcMain.handle("wsl-servers-add", (event: IpcMainInvokeEvent, distro: string) => {
    const checked = requireWslIpcString("distro", distro)
    return executeNative(nativeActions, event, NativeActionKind.filesystem, "wsl-add-server", { distro: checked }, () =>
      controller.addServer(checked),
    )
  })
  ipcMain.handle("wsl-servers-remove", (event: IpcMainInvokeEvent, id: string) => {
    const checked = requireWslIpcString("server id", id)
    return executeNative(nativeActions, event, NativeActionKind.filesystem, "wsl-remove-server", { id: checked }, () =>
      controller.removeServer(checked),
    )
  })
  ipcMain.handle("wsl-servers-start", (event: IpcMainInvokeEvent, id: string) => {
    const checked = requireWslIpcString("server id", id)
    return executeNative(nativeActions, event, NativeActionKind.process, "wsl-start-server", { id: checked }, () =>
      controller.startServer(checked),
    )
  })
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error("WSL is only available on Windows")
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: "WSL is only available on Windows",
    },
    installed: [],
    online: [],
    distroProbes: {},
    arforgeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  ipcMain.handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  ipcMain.handle("wsl-servers-unsubscribe", () => undefined)
  ipcMain.handle("wsl-servers-get-state", () => state())
  ipcMain.handle("wsl-servers-probe-runtime", unavailable)
  ipcMain.handle("wsl-servers-refresh-distros", unavailable)
  ipcMain.handle("wsl-servers-install-wsl", unavailable)
  ipcMain.handle("wsl-servers-install-distro", unavailable)
  ipcMain.handle("wsl-servers-probe-addable", unavailable)
  ipcMain.handle("wsl-servers-install-arforge", unavailable)
  ipcMain.handle("wsl-servers-open-terminal", unavailable)
  ipcMain.handle("wsl-servers-add", unavailable)
  ipcMain.handle("wsl-servers-remove", unavailable)
  ipcMain.handle("wsl-servers-start", unavailable)
}
