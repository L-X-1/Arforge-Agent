export type BrowserBounds = { x: number; y: number; width: number; height: number }

// Fractional CSS viewport dimensions captured by the trusted preload, not
// supplied through the public layout API. Zoom is the owner's page zoom.
export type BrowserViewportSnapshot = { width: number; height: number; zoom: number }

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
  // Required by the native policy for showing a page; hides need no viewport.
  viewport?: BrowserViewportSnapshot
}

// Shared by address controls, the native IPC boundary and the isolated start
// page. Keep this function self-contained: the start page embeds this exact
// implementation in its nonce-protected script, without a host/preload bridge.
export function normalizeWorkbenchBrowserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Browser address must be a bounded HTTP(S) URL")
  }
  const address = value.trim()
  if (!address || /^[/?#\\]/.test(address)) throw new TypeError("Enter a website address")
  // A dotted host or localhost followed by a numeric port is an address,
  // rather than a URI scheme. Other explicit schemes still reach the policy
  // check below, so javascript:443 and custom:123 cannot become host names.
  const hostPort = /^(?:localhost\.?|[^/?#:@]+\.[^/?#:@]+):\d+(?:[/?#]|$)/i.test(address)
  const hasProtocol = /^[a-z][a-z\d+.-]*:/i.test(address) && !hostPort
  let url: URL
  try {
    url = new URL(hasProtocol ? address : `https://${address}`)
    // Localhost and IP literals commonly serve HTTP development interfaces.
    // Explicit HTTP(S) always wins; public domain names default to HTTPS.
    if (!hasProtocol && (
      /^(?:localhost\.?|.+\.localhost\.?)$/i.test(url.hostname) ||
      /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith("[")
    )) url = new URL(`http://${address}`)
  } catch {
    throw new TypeError("Enter a website address")
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new TypeError("Only HTTP(S) addresses are supported")
  }
  if (url.username || url.password) throw new TypeError("Browser addresses must not contain inline credentials")
  const credentialKeys = new Set([
    "api_key", "apikey", "access_token", "authorization", "auth_token", "cookie",
    "password", "passwd", "secret", "session", "token",
  ])
  for (const parameters of [url.searchParams, new URLSearchParams(url.hash.slice(1))]) {
    for (const key of parameters.keys()) {
      if (credentialKeys.has(key.toLowerCase())) throw new TypeError("Browser addresses must not carry credentials")
    }
  }
  // Prefixes, IDN hostnames and encoded paths may expand an accepted input.
  // Keep the canonical value valid when the native owner validates it again.
  if (url.href.length > 8192) throw new TypeError("Browser address must be a bounded HTTP(S) URL")
  return url.href
}

// Internal session state keys contain NUL separators. Preserve their complete
// identity on the IPC wire without admitting control characters to its policy.
// JSON quoting is reversible (including literal escapes and lone surrogates);
// DEL needs an explicit escape because JSON.stringify leaves it unchanged.
export function toWorkbenchBrowserScope(sessionKey: string): string {
  if (typeof sessionKey !== "string" || !sessionKey.trim()) throw new TypeError("Invalid browser session key")
  return "session:" + JSON.stringify(sessionKey).replace(/\u007f/g, "\\u007f")
}

export function shouldAcceptBrowserPageState(
  current: BrowserPageState | undefined,
  next: BrowserPageState,
  scope: string | undefined,
): boolean {
  return (
    !!current &&
    next.scope === scope &&
    current.scope === next.scope &&
    current.pageID === next.pageID &&
    next.revision >= current.revision
  )
}
