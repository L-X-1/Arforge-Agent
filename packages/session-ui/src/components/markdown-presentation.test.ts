import { describe, expect, test } from "bun:test"
import { decorateMarkdownLists } from "./markdown-presentation"

describe("native markdown list presentation", () => {
  test("keeps start, reversed, explicit value, nesting and task state intact", () => {
    const root = document.createElement("div")
    root.innerHTML = '<ol start="120" reversed><li>First</li><li value="998">Second<ul><li><input type="checkbox" checked disabled>Task</li></ul></li><li>Third</li></ol>'
    const list = root.querySelector("ol")!
    const items = [...root.querySelectorAll("li")]
    decorateMarkdownLists(root)
    expect(list.start).toBe(120)
    expect(list.reversed).toBe(true)
    expect(items[1]!.value).toBe(998)
    expect([...root.querySelectorAll("li")]).toEqual(items)
    expect(root.querySelector("input")!.checked).toBe(true)
    expect(root.querySelector("input")!.disabled).toBe(true)
    expect(list.style.getPropertyValue("--arforge-list-marker-width")).toBe("max(24px, 4ch)")
  })

  test("counts implicit reversed starts and negative resets without adding counter text", () => {
    const root = document.createElement("div")
    root.innerHTML = '<ol reversed><li>A</li><li value="-999">B</li><li>C</li></ol>'
    const before = root.textContent
    decorateMarkdownLists(root)
    expect(root.querySelector("ol")!.hasAttribute("start")).toBe(false)
    expect(root.querySelector("ol")!.style.getPropertyValue("--arforge-list-marker-width")).toBe("max(24px, 6ch)")
    expect(root.textContent).toBe(before)
  })

  test("nested ordered lists get independent marker widths", () => {
    const root = document.createElement("div")
    root.innerHTML = '<ol start="1"><li>A<ol start="999"><li>B</li><li>C</li></ol></li></ol>'
    decorateMarkdownLists(root)
    const lists = root.querySelectorAll("ol")
    expect(lists[0]!.style.getPropertyValue("--arforge-list-marker-width")).toBe("max(24px, 2ch)")
    expect(lists[1]!.style.getPropertyValue("--arforge-list-marker-width")).toBe("max(24px, 5ch)")
  })
})
