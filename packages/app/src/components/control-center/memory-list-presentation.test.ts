import { describe, expect, test } from "bun:test"
import { managementListPage, memoryListPreview } from "./memory-list-presentation"

describe("memory list and inspector presentation", () => {
  test("bounds the row preview without changing complete content or splitting Unicode", () => {
    const content = "\n完整记忆 👩‍💻\n" + "正文".repeat(100)
    const preview = memoryListPreview(content, 18)
    expect(preview).not.toContain("\n")
    expect(Array.from(preview).length).toBe(19)
    expect(preview.endsWith("…")).toBe(true)
    expect(content).toContain("\n完整记忆")
    expect(memoryListPreview("  short\nvalue  ")).toBe("short value")
  })

  test("all loaded objects remain accessible by paging and keep their original identities", () => {
    const items = Array.from({ length: 61 }, (_, index) => ({ id: String(index), content: `memory ${index}` }))
    const pages = Array.from({ length: 4 }, (_, index) => managementListPage(items, index))
    expect(pages.flatMap(page => page.items)).toEqual(items)
    expect(pages[3]!.items[0]).toBe(items[60])
    expect(managementListPage(items, 99).index).toBe(3)
    expect(managementListPage(items.slice(0, 2), 3).index).toBe(0)
    expect(managementListPage([], 9)).toEqual({ index: 0, pages: 1, items: [] })
  })
})
