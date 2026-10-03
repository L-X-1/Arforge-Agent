import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU, desktopMenuVisible } from "./desktop-menu"

test("offers the isolated browser through the native desktop action on both platforms", () => {
  const entries = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
    (entry) => entry.type === "item" && entry.action === "window.browser",
  )
  expect(entries).toHaveLength(1)
  expect(desktopMenuVisible(entries[0]!, "windows")).toBe(true)
  expect(desktopMenuVisible(entries[0]!, "macos")).toBe(true)
})

describe("桌面菜单", () => {
  test("通过桌面命令注册表导出日志", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.label === "导出日志…",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })
})
