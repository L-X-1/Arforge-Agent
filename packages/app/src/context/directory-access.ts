import { createStore } from "solid-js/store"
import { pathKey } from "@/utils/path-key"
import { retryBootstrapRead } from "./global-sync/bootstrap-read"

export type DirectoryAccessState = { status: "checking" | "ready" | "unavailable"; error?: unknown }

/** One cache per server owner. Only a real directory read can mark it ready. */
export function createDirectoryAccess(
  read: (directory: string) => Promise<{ directory: string }>,
  capture: () => () => boolean = () => () => true,
) {
  const [data, setData] = createStore<Record<string, DirectoryAccessState | undefined>>({})
  const pending = new Map<string, { promise: Promise<void>; active: () => boolean }>()
  let disposed = false
  const check = (directory: string, options?: { force?: boolean }): Promise<void> => {
    const key = pathKey(directory)
    if (disposed || !key) return Promise.resolve()
    const current = pending.get(key)
    if (current?.active()) return current.promise
    if (!options?.force && data[key] && data[key]?.status !== "checking") return Promise.resolve()
    const active = capture()
    setData(key, { status: "checking" })
    const request = Promise.resolve()
      .then(() =>
        retryBootstrapRead(
          () => read(directory),
          () => !disposed && active(),
        ),
      )
      .then((result) => {
        if (pathKey(result.directory) !== key) throw new Error("Directory response belongs to a different source")
        if (!disposed && active()) setData(key, { status: "ready" })
      })
      .catch((error: unknown) => {
        if (!disposed && active()) setData(key, { status: "unavailable", error })
      })
      .finally(() => {
        if (pending.get(key)?.promise === request) pending.delete(key)
      })
    pending.set(key, { promise: request, active })
    return request
  }
  return {
    data,
    get: (directory: string) => data[pathKey(directory)],
    check,
    dispose() {
      disposed = true
    },
  }
}

export function directoryAccessReason(state: DirectoryAccessState | undefined, directory: string, locale: string) {
  if (state?.status === "ready") return
  const checking = !state || state.status === "checking"
  if (locale === "zh")
    return checking
      ? `正在检查目录：${directory}`
      : `目录不可用：${directory}。请检查路径或连接，重新打开此菜单可重试。`
  if (locale === "zht")
    return checking
      ? `正在檢查目錄：${directory}`
      : `目錄無法使用：${directory}。請檢查路徑或連線，重新開啟此選單可重試。`
  return checking
    ? `Checking directory: ${directory}`
    : `Directory unavailable: ${directory}. Check the path or connection; reopen this menu to retry.`
}
