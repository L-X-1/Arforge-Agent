import { describe, expect, test } from "bun:test"
import { join } from "node:path"

describe("new layout route loading boundary", () => {
  test("wires a stable, accessible session skeleton instead of an empty black main area", async () => {
    const layout = await Bun.file(join(import.meta.dir, "layout-new.tsx")).text()
    const app = await Bun.file(join(import.meta.dir, "../app.tsx")).text()
    const fallback = await Bun.file(join(import.meta.dir, "../components/route-loading-fallback.tsx")).text()
    const session = await Bun.file(join(import.meta.dir, "session.tsx")).text()

    expect(layout).not.toContain("<Suspense")
    expect(app).toContain("<Suspense fallback={<RouteLoadingFallback />}>")
    expect(fallback).toContain('data-component="route-loading-fallback"')
    expect(fallback).toContain('role="status"')
    expect(fallback).toContain('aria-live="polite"')
    expect(fallback).toContain("const language = useLanguage()")
    expect(fallback).toContain('aria-label={language.t("session.messages.loading")}')
    expect(fallback).toContain('{language.t("session.messages.loading")}')
    expect(fallback).not.toContain("正在载入会话")
    for (const locale of ["en", "zh"]) {
      const dictionary = await Bun.file(join(import.meta.dir, `../i18n/${locale}.ts`)).text()
      expect(dictionary).toContain('"session.messages.loading":')
    }
    expect(fallback).not.toContain("animate-")
    expect(session).toContain("sessionSync.latest")
    expect(session).not.toContain("sessionSync()")
  })
})
