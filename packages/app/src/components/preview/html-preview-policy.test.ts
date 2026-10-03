import { describe, expect, test } from "bun:test"
import { escapePreviewText, HTML_PREVIEW_CSP, HTML_PREVIEW_DEBOUNCE_MS, HTML_PREVIEW_MAX_CHARACTERS, htmlPreviewFits, isEmbeddedRasterImage, isHtmlDocument } from "./html-preview-policy"

describe("isolated HTML preview policy", () => {
  test("recognizes HTML files without treating JSX or Markdown as HTML", () => {
    for (const path of ["page.html", "C:\\project\\PAGE.HTM", "page.xhtml"]) expect(isHtmlDocument(path)).toBe(true)
    for (const path of ["page.html.tsx", "component.mdx", "notes.md", "html"]) expect(isHtmlDocument(path)).toBe(false)
  })
  test("bounds preview parsing independently of the editor buffer", () => {
    expect(htmlPreviewFits("x".repeat(HTML_PREVIEW_MAX_CHARACTERS))).toBe(true)
    expect(htmlPreviewFits("x".repeat(HTML_PREVIEW_MAX_CHARACTERS + 1))).toBe(false)
    expect(HTML_PREVIEW_DEBOUNCE_MS).toBe(200)
  })
  test("allows only embedded base64 raster image sources", () => {
    expect(isEmbeddedRasterImage("data:image/png;base64,aGVsbG8=")).toBe(true)
    expect(isEmbeddedRasterImage("data:image/webp;base64,YQ==")).toBe(true)
    for (const value of ["https://example.com/a.png", "../a.png", "file:///C:/a.png", "data:image/svg+xml;base64,YQ==", "data:text/html;base64,YQ==", "data:image/png;base64,"]) expect(isEmbeddedRasterImage(value)).toBe(false)
  })
  test("CSP denies scripts, connections, frames, forms and base URL changes", () => {
    for (const directive of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(HTML_PREVIEW_CSP).toContain(directive)
    expect(HTML_PREVIEW_CSP).toContain("style-src 'unsafe-inline'")
    expect(HTML_PREVIEW_CSP).not.toContain("'self'")
  })
  test("escapes filenames before adding them to the trusted document shell", () => {
    expect(escapePreviewText('</title><script a="b">&\'')).toBe("&lt;/title&gt;&lt;script a=&quot;b&quot;&gt;&amp;&#39;")
  })
})
