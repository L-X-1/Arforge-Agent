import { afterEach, describe, expect, test } from "bun:test"
import { markdownCodeText, toggleMarkdownCode, updateMarkdownCodeControls } from "./markdown-code-controls"

const labels = { expand: "Show more", collapse: "Show less", range: (shown: number, total: number) => `lines1–${shown}/${total}` }
afterEach(() => { document.body.removeAttribute("data-new-layout"); document.body.innerHTML = "" })
function wrapper() {
  const root = document.createElement("div")
  root.innerHTML = '<pre class="shiki"><code><span>original stable token</span></code></pre><div data-slot="markdown-copy-button"><button>Copy</button></div>'
  document.body.appendChild(root)
  return root
}

describe("markdown code controls", () => {
  test("discloses20 original lines while retaining full source, token DOM and expansion across a streamed update", () => {
    document.body.setAttribute("data-new-layout", "")
    const root = wrapper(), code = root.querySelector("code"), token = root.querySelector("code span")
    const text = Array.from({ length: 26 }, (_, index) => `line${index} 😀`).join("\r\n")
    updateMarkdownCodeControls(root, { text, normalized: text, language: "unknown-language" }, "text", labels)
    expect(root.dataset.codeExpanded).toBe("false")
    expect(root.querySelector('[data-slot="markdown-code-range"]')?.textContent).toBe("lines1–20/26")
    expect(root.querySelector('[data-slot="markdown-code-language"]')?.textContent).toBe("unknown-language")
    expect(root.querySelector('button[data-action]')?.getAttribute("aria-controls")).toBe(root.querySelector("pre")!.id)
    expect(markdownCodeText(root)).toBe(text)
    toggleMarkdownCode(root)
    const updated = text + "\r\nadded"
    updateMarkdownCodeControls(root, { text: updated, normalized: updated, language: "unknown-language" }, "text", labels)
    expect(root.dataset.codeExpanded).toBe("true")
    expect(root.querySelector('button[data-action]')?.getAttribute("aria-expanded")).toBe("true")
    expect(root.querySelector("code")).toBe(code)
    expect(root.querySelector("code span")).toBe(token)
    expect(markdownCodeText(root)).toBe(updated)
    toggleMarkdownCode(root)
    expect(root.dataset.codeExpanded).toBe("false")
    expect(root.querySelectorAll('[data-slot="markdown-copy-button"]')).toHaveLength(1)
  })

  test("short blocks and single long lines keep the full toolbar without unnecessary disclosure; legacy layout stays unchanged", () => {
    const legacy = wrapper()
    updateMarkdownCodeControls(legacy, { text: "old\r\n", normalized: "old" }, "text", labels)
    expect(legacy.querySelector('[data-slot="markdown-code-toolbar"]')).toBeNull()
    expect(markdownCodeText(legacy)).toBe("old\r\n")
    document.body.setAttribute("data-new-layout", "")
    const root = wrapper(), text = "long ".repeat(1000)
    updateMarkdownCodeControls(root, { text, normalized: text }, undefined, labels)
    expect(root.querySelector('[data-slot="markdown-code-language"]')?.textContent).toBe("text")
    expect(root.querySelector('[data-slot="markdown-code-disclosure"]')).toBeNull()
    expect(root.querySelectorAll('[data-slot="markdown-code-toolbar"] [data-slot="markdown-copy-button"]')).toHaveLength(1)
    expect(markdownCodeText(root)).toBe(text)
  })
})
