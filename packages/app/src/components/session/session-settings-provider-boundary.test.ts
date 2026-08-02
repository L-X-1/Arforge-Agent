import { describe, expect, test } from "bun:test"

describe("Session settings provider boundary", () => {
  test("does not acquire Sync context from inside the detached settings dialog", async () => {
    const panel = await Bun.file(new URL("./session-operations-dialog.tsx", import.meta.url)).text()
    const dialog = await Bun.file(new URL("../settings-v2/dialog-settings-v2.tsx", import.meta.url)).text()
    const sessionPage = await Bun.file(new URL("../../pages/session.tsx", import.meta.url)).text()

    expect(panel).not.toMatch(/\buseSync\s*\(\s*\)/)
    expect(panel).toContain("sync?: ReturnType<typeof useSync>")
    expect(dialog).toContain("sync={props.sync}")
    expect(sessionPage).toMatch(/function TargetSessionSettingsCommand\(\) \{\s*useSettingsCommand\(\)/)
  })
})
