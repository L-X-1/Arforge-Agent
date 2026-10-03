export type BrowserBounds = { x: number; y: number; width: number; height: number }

export type BrowserPageState = {
  scope: string
  pageID: string
  revision: number
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  notice: string
}

export type BrowserPageCommand =
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" | "stop" }

export type BrowserWorkbenchPlatform = {
  open(scope: string): Promise<BrowserPageState>
  command(scope: string, pageID: string, command: BrowserPageCommand): Promise<BrowserPageState>
  layout(scope: string, pageID: string, bounds: BrowserBounds | null): Promise<void>
  close(scope: string, pageID: string): Promise<void>
  subscribe(callback: (state: BrowserPageState) => void): () => void
}

export type BrowserWorkbenchRequest =
  | { action: "open"; scope: string }
  | ({ scope: string; pageID: string } & BrowserPageCommand)
  | { action: "close"; scope: string; pageID: string }

export type BrowserLayoutRequest = {
  scope: string
  pageID: string
  sequence: number
  bounds: BrowserBounds | null
}

// Internal session state keys contain NUL separators. Preserve their complete
// identity on the IPC wire without admitting control characters to its policy.
// JSON quoting is reversible (including literal escapes and lone surrogates);
// DEL needs an explicit escape because JSON.stringify leaves it unchanged.
export function toWorkbenchBrowserScope(sessionKey: string): string {
  if (typeof sessionKey !== "string" || !sessionKey.trim()) throw new TypeError("Invalid browser session key")
  return "session:" + JSON.stringify(sessionKey).replace(/\u007f/g, "\\u007f")
}

export function shouldAcceptBrowserPageState(current: BrowserPageState | undefined, next: BrowserPageState, scope: string | undefined): boolean {
  return !!current && next.scope === scope && current.scope === next.scope && current.pageID === next.pageID && next.revision >= current.revision
}
