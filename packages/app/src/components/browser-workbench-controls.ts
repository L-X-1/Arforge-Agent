import type { BrowserPageCommand } from "@/browser-workbench"

export function canRunBrowserCommand(busy: boolean, action: BrowserPageCommand) {
  return !busy || action.action === "stop"
}
