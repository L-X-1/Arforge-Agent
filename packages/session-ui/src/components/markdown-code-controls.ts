import { markdownCodeLineCount, type MarkdownCodeSource } from "./markdown-code-source"

export type MarkdownCodeLabels = {
  expand: string
  collapse: string
  range: (shown: number, total: number) => string
}

type State = { text: string; expanded: boolean; total: number; labels: MarkdownCodeLabels }
const states = new WeakMap<HTMLElement, State>()
let codeID = 0

function disclosure(wrapper: HTMLElement, state: State) {
  const pre = wrapper.querySelector("pre")
  if (!pre) return
  const expanded = state.expanded || state.total <= 20
  wrapper.dataset.codeExpanded = String(expanded)
  wrapper.dataset.codeFoldable = String(state.total > 20)
  let footer = wrapper.querySelector<HTMLElement>('[data-slot="markdown-code-disclosure"]')
  if (state.total <= 20) { footer?.remove(); return }
  if (!footer) {
    footer = document.createElement("div")
    footer.dataset.slot = "markdown-code-disclosure"
    const range = document.createElement("span")
    range.dataset.slot = "markdown-code-range"
    const button = document.createElement("button")
    button.type = "button"
    button.dataset.action = "markdown-code-expand"
    footer.append(range, button)
    wrapper.appendChild(footer)
  }
  if (!pre.id) pre.id = `markdown-code-${++codeID}`
  const range = footer.querySelector<HTMLElement>('[data-slot="markdown-code-range"]')!
  range.textContent = state.labels.range(expanded ? state.total : 20, state.total)
  const button = footer.querySelector("button")!
  button.textContent = expanded ? state.labels.collapse : state.labels.expand
  button.setAttribute("aria-expanded", String(expanded))
  button.setAttribute("aria-controls", pre.id)
}

export function updateMarkdownCodeControls(wrapper: HTMLElement, source: MarkdownCodeSource | undefined, language: string | undefined, labels: MarkdownCodeLabels) {
  const prior = states.get(wrapper)
  const text = source?.text ?? wrapper.querySelector("code")?.textContent ?? ""
  const state = { text, total: markdownCodeLineCount(text), expanded: prior?.expanded ?? false, labels }
  states.set(wrapper, state)
  if (!document.body.hasAttribute("data-new-layout")) return
  let toolbar = wrapper.querySelector<HTMLElement>('[data-slot="markdown-code-toolbar"]')
  if (!toolbar) {
    toolbar = document.createElement("div")
    toolbar.dataset.slot = "markdown-code-toolbar"
    const label = document.createElement("span")
    label.dataset.slot = "markdown-code-language"
    toolbar.appendChild(label)
    wrapper.prepend(toolbar)
  }
  toolbar.querySelector<HTMLElement>('[data-slot="markdown-code-language"]')!.textContent = source?.language ?? language ?? "text"
  const copy = wrapper.querySelector<HTMLElement>('[data-slot="markdown-copy-button"]')
  if (copy && copy.parentElement !== toolbar) toolbar.appendChild(copy)
  disclosure(wrapper, state)
}

export function markdownCodeText(wrapper: HTMLElement) {
  return states.get(wrapper)?.text ?? wrapper.querySelector("code")?.textContent ?? ""
}

export function toggleMarkdownCode(wrapper: HTMLElement) {
  const state = states.get(wrapper)
  if (!state || state.total <= 20) return
  state.expanded = !state.expanded
  disclosure(wrapper, state)
  if (!state.expanded) wrapper.querySelector("pre")?.scrollTo({ top: 0 })
}
