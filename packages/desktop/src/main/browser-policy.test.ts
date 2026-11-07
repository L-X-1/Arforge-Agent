import { describe, expect, test } from "bun:test"
import { normalizeWorkbenchBrowserUrl, requireWorkbenchBrowserOrigin, workbenchBrowserPreferences } from "./browser-policy"
import { workbenchBrowserStartPage } from "./browser-start-page"

describe("isolated workbench browser", () => {
  test("normalizes complete HTTP(S) addresses without making a request", () => {
    expect(normalizeWorkbenchBrowserUrl(" https://EXAMPLE.com:443/path?q=hello#part ")).toBe("https://example.com/path?q=hello#part")
    expect(normalizeWorkbenchBrowserUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/")
  })

  test.each([
    ["example.com/path?q=hello#part", "https://example.com/path?q=hello#part"],
    [" EXAMPLE.com:8443/a?next=b#c ", "https://example.com:8443/a?next=b#c"],
    ["localhost:5173/path?q=x#y", "http://localhost:5173/path?q=x#y"],
    ["localhost:443/path", "http://localhost:443/path"],
    ["localhost.:5173/path?q=x#y", "http://localhost.:5173/path?q=x#y"],
    ["LOCALHOST.:443/path", "http://localhost.:443/path"],
    ["example.com:80/path", "https://example.com:80/path"],
    ["127.0.0.1:5173/path", "http://127.0.0.1:5173/path"],
    ["192.168.1.2:8080/path", "http://192.168.1.2:8080/path"],
    ["[::1]:5173/path?q=x#y", "http://[::1]:5173/path?q=x#y"],
    ["[2001:db8::1]:8443/path", "http://[2001:db8::1]:8443/path"],
    ["https://localhost:5173/path", "https://localhost:5173/path"],
    ["http://example.com/path", "http://example.com/path"],
  ])("opens address %s with one canonical protocol", (input, expected) => {
    expect(normalizeWorkbenchBrowserUrl(input)).toBe(expected)
    expect(normalizeWorkbenchBrowserUrl(expected)).toBe(expected)
  })

  test("keeps an exactly8192 canonical address valid through repeated normalization", () => {
    const prefix = "https://example.com/"
    const canonical = prefix + "x".repeat(8192 - prefix.length)
    expect(canonical.length).toBe(8192)
    expect(normalizeWorkbenchBrowserUrl(canonical)).toBe(canonical)
    expect(normalizeWorkbenchBrowserUrl(canonical.slice("https://".length))).toBe(canonical)
    expect(normalizeWorkbenchBrowserUrl(normalizeWorkbenchBrowserUrl(canonical))).toBe(canonical)
  })

  test.each([
    ["prefix", "example.com/" + "x".repeat(8192 - "example.com/".length)],
    ["percent encoding", "https://example.com/" + "中".repeat(1000)],
    ["punycode", "https://例子.测试/" + "x".repeat(8192 - "https://例子.测试/".length)],
  ])("rejects %s expansion beyond the native canonical URL limit", (_kind, value) => {
    expect(value.length).toBeLessThanOrEqual(8192)
    const canonical = new URL(value.startsWith("https:") ? value : "https://" + value).href
    expect(canonical.length).toBeGreaterThan(8192)
    expect(() => normalizeWorkbenchBrowserUrl(value)).toThrow("bounded HTTP(S) URL")
  })

  test.each([
    undefined, null, 42, "", " ", "//example.com", "/relative", "?query", "#hash", "javascript:alert(1)",
    "file:///C:/private.txt", "data:text/html,hello", "about:blank", "ftp://example.com", "https://user:pass@example.com",
    "https://example.com/?access_token=secret", "https://example.com/?TOKEN=secret", "https://example.com/#api_key=secret",
    "https://example.com/?%70assword=secret", "https://exam\tple.com", "https://example.com/\n", "https://example.com/" + "x".repeat(8192),
    "example.com/?access_token=secret", "localhost:5173/#TOKEN=secret", "user:pass@example.com", "user@example.com",
    "javascript:443", "data:80", "file:443", "custom:123", "ws://localhost:5173", "example.com:bad-port",
  ])("rejects unsafe or credential-bearing address %p", (value) => {
    expect(() => normalizeWorkbenchBrowserUrl(value)).toThrow()
  })

  test("requires an explicitly opened origin for top-level links and redirects", () => {
    const origins = new Set(["https://example.com", "http://127.0.0.1:5173"])
    expect(requireWorkbenchBrowserOrigin("https://example.com:443/next", origins)).toBe("https://example.com/next")
    expect(requireWorkbenchBrowserOrigin("http://127.0.0.1:5173/next", origins)).toBe("http://127.0.0.1:5173/next")
    for (const address of ["https://other.example/", "http://example.com/", "https://example.com:8443/", "https://example.com.evil.test/"]) {
      expect(() => requireWorkbenchBrowserOrigin(address, origins)).toThrow()
    }
    expect(() => requireWorkbenchBrowserOrigin("https://example.com", new Set())).toThrow()
  })

  test("disables host integration and refuses persistent/shared partitions", () => {
    const preferences = workbenchBrowserPreferences("arforge-browser-test")
    expect(preferences).toMatchObject({ nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, devTools: false, disableDialogs: true })
    expect("preload" in preferences).toBe(false)
    for (const partition of ["", "persist:arforge-browser-test", "default", "arforge-browser-test/path"]) {
      expect(() => workbenchBrowserPreferences(partition)).toThrow()
    }
  })

  test("keeps the address page self-contained, labeled and nonce-protected", () => {
    const html = workbenchBrowserStartPage("test123")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'nonce-test123'")
    expect(html).toContain('script nonce="test123"')
    expect(html).toContain('label for="address"')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain("window.api")
    expect(html).not.toMatch(/<(iframe|webview|img)\b/)
    expect(() => workbenchBrowserStartPage('"><script>')).toThrow()
  })
})
