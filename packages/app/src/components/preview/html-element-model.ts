import { parse, serialize, type DefaultTreeAdapterMap } from "parse5"

export const HTML_ELEMENT_MAX_CHARACTERS = 500_000
export const HTML_ELEMENT_MAX_NODES = 1500
export const HTML_ELEMENT_ATTRIBUTE = "data-arforge-source"
const namespace = "http://www.w3.org/1999/xhtml"
const excluded = new Set(["html", "head", "body", "base", "link", "meta", "title", "style", "script", "noscript", "template", "iframe", "object", "embed", "form", "input", "textarea", "select", "option", "button"])

export interface HtmlSourceElement {
  readonly id: string
  readonly tag: string
  readonly label: string
  readonly start: number
  readonly end: number
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly originalTitle?: string
}

export interface HtmlElementMap {
  readonly markup: string
  readonly elements: readonly HtmlSourceElement[]
  readonly markerPrefix: string
  readonly limited: boolean
}

export function htmlLineStarts(source: string) {
  const starts = [0]
  const lines = /\r\n|\r|\n/g
  for (let match = lines.exec(source); match; match = lines.exec(source)) starts.push(match.index + match[0].length)
  return starts
}

function lineAt(starts: readonly number[], offset: number) {
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const mid = (low + high) >>> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid
  }
  return low
}

export function visitHtmlElements(root: DefaultTreeAdapterMap["node"], visit: (node: DefaultTreeAdapterMap["element"]) => void) {
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if ("tagName" in node) visit(node)
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index]!)
    }
  }
}

export function mapHtmlElements(source: string, marker: string): HtmlElementMap {
  if (source.length > HTML_ELEMENT_MAX_CHARACTERS) throw new Error("HTML element selection is limited to 500,000 characters.")
  if (!/^[a-f0-9]{32}$/.test(marker)) throw new Error("Invalid HTML element map marker.")
  const document = parse(source, { sourceCodeLocationInfo: true })
  const starts = htmlLineStarts(source)
  const prefix = `arforge-source-${marker}-`
  const candidates: { node: DefaultTreeAdapterMap["element"]; element: HtmlSourceElement; key: string }[] = []
  const counts = new Map<string, number>()
  let limited = false
  visitHtmlElements(document, (node) => {
    node.attrs = node.attrs.filter((attribute) => !attribute.name.startsWith("data-arforge-"))
    const location = node.sourceCodeLocation
    if (node.namespaceURI !== namespace || excluded.has(node.tagName) || !location?.startTag) return
    if (location.startOffset < 0 || location.endOffset <= location.startOffset || location.endOffset > source.length) return
    if (candidates.length >= HTML_ELEMENT_MAX_NODES) { limited = true; return }
    const line = lineAt(starts, location.startOffset)
    const id = `element-${candidates.length + 1}`
    const originalID = node.attrs.find((attribute) => attribute.name === "id")?.value
    const originalTitle = node.attrs.find((attribute) => attribute.name === "title")?.value
    const key = `${node.tagName}:${location.startOffset}:${location.endOffset}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    candidates.push({ node, key, element: {
      id, tag: node.tagName, label: `${node.tagName}${originalID ? `#${originalID.slice(0, 64)}` : ""} :${line + 1}`,
      start: location.startOffset, end: location.endOffset, line: line + 1,
      column: location.startOffset - starts[line]! + 1,
      endLine: lineAt(starts, location.endOffset - 1) + 1,
      ...(originalTitle === undefined ? {} : { originalTitle }),
    } })
  })
  const elements: HtmlSourceElement[] = []
  for (const { node, key, element } of candidates) {
    // Corrected/reconstructed formatting nodes can share a source range.
    // Such ranges are not advertised as a unique editable source target.
    if (counts.get(key) !== 1) continue
    node.attrs = node.attrs.filter((attribute) => attribute.name !== "title")
    node.attrs.push({ name: "title", value: prefix + element.id })
    elements.push(element)
  }
  return { markup: serialize(document), elements, markerPrefix: prefix, limited }
}

export function htmlElementExcerpt(source: string, element: HtmlSourceElement, limit = 12_000) {
  const size = Math.max(0, Math.min(12_000, Math.floor(limit)))
  return { text: source.slice(element.start, Math.min(element.end, element.start + size)), truncated: element.end - element.start > size }
}

export interface HtmlElementSession {
  readonly frameID: string
  readonly revision: string
  readonly elements: readonly HtmlSourceElement[]
}

export type HtmlElementMessage = { kind: "ready" | "cancel" } | { kind: "select"; element: HtmlSourceElement }

export function decodeHtmlElementMessage(input: { data: unknown; origin: string; sourceMatches: boolean }, session: HtmlElementSession): HtmlElementMessage | undefined {
  if (!input.sourceMatches || input.origin !== "null" || !input.data || typeof input.data !== "object") return
  const data = input.data as Record<string, unknown>
  if (data.type !== "arforge.html-element" || data.frameID !== session.frameID || data.revision !== session.revision) return
  if (data.kind === "ready" || data.kind === "cancel") return { kind: data.kind }
  if (data.kind !== "select" || typeof data.id !== "string" || data.id.length > 32) return
  const element = session.elements.find((item) => item.id === data.id)
  if (element) return { kind: "select", element }
}
