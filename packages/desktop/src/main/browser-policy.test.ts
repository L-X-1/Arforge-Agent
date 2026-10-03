import { describe, expect, test } from "bun:test"
import { normalizeWorkbenchBrowserUrl, requireWorkbenchBrowserOrigin, workbenchBrowserPreferences } from "./browser-policy"
import { workbenchBrowserStartPage } from "./browser-start-page"

describe("isolated workbench browser", () => {
  test("normalizes complete HTTP(S) addresses without making a request", () => {
    expect(normalizeWorkbenchBrowserUrl(" https://EXAMPLE.com:443/path?q=hello#part ")).toBe("https://example.com/path?q=hello#part")
    expect(normalizeWorkbenchBrowserUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/")
  })

  test.each([
    undefined, null, 42, "", "example.com", "//example.com", "javascript:alert(1)",
    "file:///C:/private.txt", "data:text/html,hello", "about:blank", "ftp://example.com", "https://user:pass@example.com",
    "https://example.com/?access_token=secret", "https://example.com/?TOKEN=secret", "https://example.com/#api_key=secret",
    "https://example.com/?%70assword=secret", "https://exam\tple.com", "https://example.com/\n", "https://example.com/" + "x".repeat(8192),
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
