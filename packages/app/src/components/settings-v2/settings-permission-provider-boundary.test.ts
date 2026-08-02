import { describe, expect, test } from "bun:test"

describe("Settings permission provider boundary", () => {
  test("injects permission state into the detached settings dialog", async () => {
    const opener = await Bun.file(new URL("../settings-dialog.tsx", import.meta.url)).text()
    const dialog = await Bun.file(new URL("./dialog-settings-v2.tsx", import.meta.url)).text()
    const general = await Bun.file(new URL("./general.tsx", import.meta.url)).text()
    const legacyGeneral = await Bun.file(new URL("../settings-general.tsx", import.meta.url)).text()
    const legacyLayout = await Bun.file(new URL("../../pages/layout.tsx", import.meta.url)).text()

    expect(opener).toMatch(/const permission = usePermission\(\)/)
    expect(opener).toContain("permission={permission}")
    expect(dialog).toContain("permission: ReturnType<typeof usePermission>")
    expect(dialog).toContain("permission={props.permission}")
    expect(general).not.toMatch(/const permission = usePermission\(\)/)
    expect(general).toContain("const permission = props.permission")
    expect(legacyGeneral).toContain("<module.DialogSettings permission={permission} />")
    expect(legacyLayout).toContain("permission={permission}")
  })
})
