import { readFile } from "node:fs/promises"
import { describe, expect, it } from "bun:test"

const readSource = (relativePath: string) => readFile(new URL(relativePath, import.meta.url), "utf8")

const handlerBlock = (source: string, channel: string) => {
  const marker = `"${channel}"`
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) return ""
  const handlerStart = source.lastIndexOf("ipcMain.", markerIndex)
  const nextHandler = source.indexOf("\n  ipcMain.", markerIndex + marker.length)
  return source.slice(handlerStart, nextHandler < 0 ? source.length : nextHandler)
}

describe("native action boundary", () => {
  it("routes Desktop write-capable IPC handlers through the Core action runtime", async () => {
    const [ipc, wsl] = await Promise.all([readSource("ipc.ts"), readSource("wsl/ipc.ts")])
    const desktopChannels = [
      "workbench-browser",
      "workbench-browser-layout",
      "set-default-server-url",
      "finish-first-launch-onboarding",
      "set-display-backend",
      "updater-install",
      "set-background-color",
      "set-force-focus",
      "store-set",
      "store-delete",
      "store-clear",
      "open-directory-picker",
      "open-link",
      "open-path",
      "show-notification",
      "set-window-focus",
      "show-window",
      "relaunch",
      "set-zoom-factor",
      "set-pinch-zoom-enabled",
      "set-titlebar",
      "run-desktop-menu-action",
    ]
    for (const channel of desktopChannels) expect(handlerBlock(ipc, channel), channel).toContain("executeNative")

    for (const channel of [
      "wsl-servers-install-wsl",
      "wsl-servers-install-distro",
      "wsl-servers-install-arforge",
      "wsl-servers-open-terminal",
      "wsl-servers-add",
      "wsl-servers-remove",
      "wsl-servers-start",
    ])
      expect(handlerBlock(wsl, channel), channel).toContain("executeNative")
  })

  it("keeps capability issuance in main/Core and exposes receipts only", async () => {
    const [bridge, ipc, preload, preloadTypes] = await Promise.all([
      readSource("native-action-bridge.ts"),
      readSource("ipc.ts"),
      readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../preload/types.ts", import.meta.url), "utf8"),
    ])
    expect(bridge).toContain("createNativeActionRequest")
    expect(ipc).toContain("NativeActionKind.clipboard")
    expect(bridge).toContain('sender.send("native-action-receipt"')
    expect(preload).toContain('ipcRenderer.on("native-action-receipt"')
    expect(preloadTypes).toContain("NativeActionReceipt")
    expect(preloadTypes).not.toContain("NativeActionCapability")
    expect(preload).not.toContain("NativeActionCapability")
    expect(ipc).toContain("event.senderFrame !== event.sender.mainFrame")
    expect(ipc).toContain("owner.webContents !== event.sender")
    expect(ipc).toContain("addressDigest: browserInputDigest(checked.url)")
  })
})
