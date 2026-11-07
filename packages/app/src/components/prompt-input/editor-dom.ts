import type { AgentPart, FileAttachmentPart } from "@/context/prompt"

const MAX_BREAKS = 200

export function createPromptPill(
  part: FileAttachmentPart | AgentPart,
  removal?: { removeLabel: string; onRemove: (pill: HTMLElement) => void },
) {
  const pill = document.createElement("span")
  pill.textContent = part.content
  pill.setAttribute("data-type", part.type)
  if (part.type === "file") {
    pill.setAttribute("data-path", part.path)
    if (part.mime) pill.setAttribute("data-mime", part.mime)
    if (part.filename) pill.setAttribute("data-filename", part.filename)
    if (part.url) pill.setAttribute("data-url", part.url)
    if (part.source?.type === "resource") {
      pill.setAttribute("data-source-type", part.source.type)
      pill.setAttribute("data-source-client-name", part.source.clientName)
      pill.setAttribute("data-source-uri", part.source.uri)
      if (!part.content) {
        const label = `${part.source.clientName}: ${part.filename || part.source.uri}`
        const target = `${label} (${part.source.uri})`
        pill.dataset.resourceLabel = label
        pill.setAttribute("aria-label", removal ? `${removal.removeLabel}: ${target}` : target)
        pill.setAttribute("title", `${part.source.clientName}: ${part.source.uri}`)
        pill.classList.add("before:content-[attr(data-resource-label)]")
        if (removal) {
          pill.setAttribute("role", "button")
          pill.tabIndex = 0
          pill.classList.add("inline-flex", "gap-1", "after:content-['×']")
          const remove = (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            removal.onRemove(pill)
          }
          pill.addEventListener("click", remove)
          pill.addEventListener("keydown", (event) => {
            if (["Enter", " ", "Backspace", "Delete"].includes(event.key)) remove(event)
          })
        }
      }
    }
  }
  if (part.type === "agent") pill.setAttribute("data-name", part.name)
  pill.setAttribute("contenteditable", "false")
  pill.style.userSelect = "text"
  pill.style.cursor =
    removal && part.type === "file" && part.source?.type === "resource" && !part.content ? "pointer" : "default"
  return pill
}

export function readFilePill(file: HTMLElement, position: number): FileAttachmentPart {
  const content = file.textContent ?? ""
  const source =
    file.dataset.sourceType === "resource" && file.dataset.sourceClientName && file.dataset.sourceUri
      ? {
          type: "resource" as const,
          text: { value: content, start: position, end: position + content.length },
          clientName: file.dataset.sourceClientName,
          uri: file.dataset.sourceUri,
        }
      : undefined
  return {
    type: "file",
    path: file.dataset.path!,
    content,
    start: position,
    end: position + content.length,
    ...(file.dataset.mime ? { mime: file.dataset.mime } : {}),
    ...(file.dataset.filename ? { filename: file.dataset.filename } : {}),
    ...(file.dataset.url ? { url: file.dataset.url } : {}),
    ...(source ? { source } : {}),
  }
}

export function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let breaks = 0
  for (const char of content) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks > MAX_BREAKS) {
      const tail = content.endsWith("\n")
      const text = tail ? content.slice(0, -1) : content
      if (text) fragment.appendChild(document.createTextNode(text))
      if (tail) fragment.appendChild(document.createElement("br"))
      return fragment
    }
  }

  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

export function getNodeLength(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  return (node.textContent ?? "").replace(/\u200B/g, "").length
}

export function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u200B/g, "").length
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR") return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

export function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      const selection = window.getSelection()
      if (remaining === 0) {
        range.setStartBefore(node)
      }
      if (remaining > 0 && isPill) {
        range.setStartAfter(node)
      }
      if (remaining > 0 && isBreak) {
        const next = node.nextSibling
        if (next && next.nodeType === Node.TEXT_NODE) {
          range.setStart(next, 0)
        }
        if (!next || next.nodeType !== Node.TEXT_NODE) {
          range.setStartAfter(node)
        }
      }
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const fallbackSelection = window.getSelection()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    const len = last.textContent ? last.textContent.length : 0
    fallbackRange.setStart(last, len)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  fallbackSelection?.removeAllRanges()
  fallbackSelection?.addRange(fallbackRange)
}

export function setRangeEdge(parent: HTMLElement, range: Range, edge: "start" | "end", offset: number) {
  let remaining = offset
  const nodes = Array.from(parent.childNodes)

  for (const node of nodes) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill =
      node.nodeType === Node.ELEMENT_NODE &&
      ((node as HTMLElement).dataset.type === "file" || (node as HTMLElement).dataset.type === "agent")
    const isBreak = node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === "BR"

    if (isText && remaining <= length) {
      if (edge === "start") range.setStart(node, remaining)
      if (edge === "end") range.setEnd(node, remaining)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      if (edge === "start" && remaining === 0) range.setStartBefore(node)
      if (edge === "start" && remaining > 0) range.setStartAfter(node)
      if (edge === "end" && remaining === 0) range.setEndBefore(node)
      if (edge === "end" && remaining > 0) range.setEndAfter(node)
      return
    }

    remaining -= length
  }
}
