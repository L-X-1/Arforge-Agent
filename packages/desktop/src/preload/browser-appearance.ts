import type { TitlebarTheme } from "./types"

export function observeBrowserAppearance(notify: (theme: TitlebarTheme) => Promise<unknown>) {
  let disposed = false
  let syncing = false
  let last = ""
  const synchronize = async () => {
    if (disposed || syncing) return
    syncing = true
    try {
      while (!disposed) {
        const root = document.documentElement
        if (!root) return
        const mode = root.dataset.colorScheme === "dark" ? "dark" : "light"
        const locale = root.lang || "en"
        const signature = mode + ":" + locale
        if (signature === last) return
        try {
          await notify({ mode, locale })
        } catch {
          // Do not record a rejected update as applied. A later DOM change can retry.
          return
        }
        last = signature
      }
    } finally {
      syncing = false
    }
  }
  const observer = new MutationObserver(() => { void synchronize() })
  const start = () => {
    if (disposed || !document.documentElement) return
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "data-color-scheme"] })
    void synchronize()
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
  else start()
  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener("DOMContentLoaded", start)
  }
}
