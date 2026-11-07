import { createHash } from "node:crypto"
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { NativeActionKind } from "@arforge-ai/core/runtime/native-action"
import { executeNative, type NativeActionRuntime } from "./native-action-bridge"
import { requireNativeStorePart, requireNativeStoreValue } from "./native-input"
import { STORE_CHUNK_LENGTH } from "../shared/store-transfer"
import { StoreTransfers } from "./store-transfer"

export function registerStoreTransferIpc(
  ipcMain: Pick<IpcMain, "handle">,
  options: {
    nativeActions: NativeActionRuntime
    write(name: string, key: string, value: string): Promise<void>
    transfers?: StoreTransfers
  },
) {
  const transfers = options.transfers ?? new StoreTransfers()
  const owners = new WeakSet<WebContents>()
  const live = (event: IpcMainInvokeEvent) => {
    if (event.sender.isDestroyed()) throw new TypeError("Desktop store sender was destroyed")
  }
  ipcMain.handle("store-write-begin", (event: IpcMainInvokeEvent, name: unknown, key: unknown, length: unknown) => {
    live(event)
    const checkedName = requireNativeStorePart("store name", name)
    const checkedKey = requireNativeStorePart("store key", key)
    if (!Number.isSafeInteger(length)) throw new TypeError("Invalid desktop store transfer length")
    if (!owners.has(event.sender)) {
      owners.add(event.sender)
      const senderID = event.sender.id
      event.sender.once("destroyed", () => transfers.close(senderID))
    }
    return executeNative(
      options.nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-write-begin",
      { name: checkedName, key: checkedKey, length },
      () => {
        live(event)
        return transfers.begin(event.sender.id, checkedName, checkedKey, length)
      },
    )
  })
  ipcMain.handle("store-write-chunk", (event: IpcMainInvokeEvent, id: unknown, index: unknown, value: unknown) => {
    live(event)
    if (typeof id !== "string" || id.length > 36 || !Number.isSafeInteger(index))
      throw new TypeError("Invalid desktop store chunk")
    const checked = requireNativeStoreValue(value, STORE_CHUNK_LENGTH)
    return executeNative(
      options.nativeActions,
      event,
      NativeActionKind.filesystem,
      "store-write-chunk",
      { id, index, length: checked.length, digest: createHash("sha256").update(checked).digest("hex") },
      () => {
        live(event)
        transfers.append(event.sender.id, id, index, checked)
      },
    )
  })
  ipcMain.handle("store-write-commit", async (event: IpcMainInvokeEvent, id: unknown) => {
    live(event)
    const prepared = transfers.prepare(event.sender.id, id)
    try {
      return await executeNative(
        options.nativeActions,
        event,
        NativeActionKind.filesystem,
        "store-write-commit",
        { name: prepared.name, key: prepared.key, length: prepared.length, digest: prepared.digest },
        () => options.write(prepared.name, prepared.key, prepared.value),
      )
    } finally {
      prepared.release()
    }
  })
  ipcMain.handle("store-write-abort", (event: IpcMainInvokeEvent, id: unknown) => {
    live(event)
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new TypeError("Invalid desktop store transfer")
    return executeNative(options.nativeActions, event, NativeActionKind.filesystem, "store-write-abort", { id }, () =>
      transfers.abort(event.sender.id, id),
    )
  })
}
