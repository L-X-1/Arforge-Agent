import { describe, expect, test } from "bun:test"
import type { FileAttachmentPart } from "@/context/prompt"
import {
  createPromptPill,
  createTextFragment,
  getCursorPosition,
  getNodeLength,
  getTextLength,
  readFilePill,
  setCursorPosition,
} from "./editor-dom"

const unmentionedResource = (clientName: string): FileAttachmentPart => ({
  type: "file",
  path: "evidence://shared/manual",
  url: "evidence://shared/manual",
  filename: "manual",
  mime: "application/pdf",
  content: "",
  start: 0,
  end: 0,
  source: { type: "resource", clientName, uri: "evidence://shared/manual", text: { value: "", start: 0, end: 0 } },
})

describe("prompt-input editor dom", () => {
  test("unmentioned resource pills expose their target without changing parsed text or ranges", () => {
    for (const server of ["server-A", "server-B"]) {
      const part = unmentionedResource(server)
      const pill = createPromptPill(part)
      expect(pill.dataset.resourceLabel).toBe(`${server}: manual`)
      expect(pill.getAttribute("aria-label")).toBe(`${server}: manual (evidence://shared/manual)`)
      expect(pill.getAttribute("title")).toBe(`${server}: evidence://shared/manual`)
      expect(pill.classList.contains("before:content-[attr(data-resource-label)]")).toBe(true)
      expect(pill.textContent).toBe("")
      expect(getNodeLength(pill)).toBe(0)
      expect(getTextLength(pill)).toBe(0)
      expect(readFilePill(pill, 0)).toEqual(part)
    }
  })

  test("unmentioned resource pills can remove only their own attachment by pointer or keyboard", () => {
    for (const key of ["click", "Enter", " ", "Backspace", "Delete"]) {
      const editor = document.createElement("div")
      const first = createPromptPill(unmentionedResource("server-A"), {
        removeLabel: "Remove attachment",
        onRemove: (pill) => pill.remove(),
      })
      const second = createPromptPill(unmentionedResource("server-B"))
      editor.append(first, second, document.createTextNode("Review these"))
      expect(first.getAttribute("role")).toBe("button")
      expect(first.tabIndex).toBe(0)
      expect(first.getAttribute("aria-label")).toBe("Remove attachment: server-A: manual (evidence://shared/manual)")
      if (key === "click") first.click()
      else first.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
      expect(editor.childNodes).toHaveLength(2)
      expect(readFilePill(second, 0)).toEqual(unmentionedResource("server-B"))
      expect(editor.textContent).toBe("Review these")
    }
  })

  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })
})
