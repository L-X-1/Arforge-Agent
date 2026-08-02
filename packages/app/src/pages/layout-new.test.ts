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
    expect(fallback).toContain('aria-label="Arforge 正在载入会话"')
    expect(fallback).toContain("正在载入会话，请稍候…")
    expect(fallback).not.toContain("animate-")
    expect(session).toContain("sessionSync.latest")
    expect(session).not.toContain("sessionSync()")
  })
})
