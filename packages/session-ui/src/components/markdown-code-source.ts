import { marked } from "marked"

export type MarkdownCodeSource = { text: string; normalized: string; language?: string }
type Tail = { mode: string; raw: string; complete?: boolean }
type SourceProjection = { text: string; sources: MarkdownCodeSource[]; tail?: Tail }
type Line = { text: string; ending: string }

function lines(text: string): Line[] {
  const result: Line[] = []
  const endings = /\r\n|\r|\n/g
  let start = 0
  for (let match = endings.exec(text); match; match = endings.exec(text)) {
    result.push({ text: text.slice(start, match.index), ending: match[0] })
    start = match.index + match[0].length
  }
  if (start < text.length) result.push({ text: text.slice(start), ending: "" })
  return result
}

// Marked normalizes line endings and removes list/quote prefixes. Match its
// actual code tokens back to source lines, retaining those semantics and EOLs.
const containerPrefix = /^(?:[ \t]|>[ \t]*|[-+*][ \t]+|\d+[.)][ \t]+)*$/
function matches(actual: Line, expected: Line) {
  return actual.text.endsWith(expected.text)
    && containerPrefix.test(actual.text.slice(0, actual.text.length - expected.text.length))
}

export function markdownCodeSources(markdown: string): MarkdownCodeSource[] {
  const original = lines(markdown)
  const result: MarkdownCodeSource[] = []
  let cursor = 0
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type !== "code" || !("text" in token) || typeof token.text !== "string") return
    const code = { raw: token.raw, text: token.text, lang: "lang" in token && typeof token.lang === "string" ? token.lang : undefined }
    const raw = lines(code.raw)
    let start = cursor
    while (start < original.length && !raw.every((line, index) => {
      const actual = original[start + index]
      return !!actual && matches(actual, line)
    })) start++
    const found = start < original.length
    if (found) cursor = start + raw.length
    const fence = raw[0]?.text.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    const from = fence ? 1 : 0
    let to = raw.length
    if (fence) {
      const closing = new RegExp(`^[\\t ]{0,3}${fence[1]![0]}{${fence[1]!.length},}[\\t ]*$`)
      const index = raw.findIndex((line, index) => index > 0 && closing.test(line.text))
      if (index >= 0) to = index
    } else {
      while (to > from && !raw[to - 1]!.text.trim()) to--
    }
    const content = code.text.split("\n")
    const text = found
      ? raw.slice(from, to).map((_, index) => (content[index] ?? "") + original[start + from + index]!.ending).join("")
      : code.text
    result.push({ text, normalized: code.text, language: code.lang?.trim().split(/\s+/, 1)[0] || undefined })
  })
  return result
}

export function markdownCodeLineCount(text: string) {
  let count = 1
  const endings = /\r\n|\r|\n/g
  while (endings.exec(text)) count++
  return count
}

/** Keep the stream's append fast path; completed/nested blocks are lexed once. */
export function projectMarkdownCodeSources(previous: SourceProjection | undefined, text: string, tail?: Tail): SourceProjection {
  const last = previous?.sources.at(-1)
  if (last && previous?.tail?.mode === "code" && !previous.tail.complete && previous.tail.raw.includes("\n")
    && tail?.mode === "code" && !tail.complete && tail.raw.startsWith(previous.tail.raw) && text.startsWith(previous.text)) {
    const delta = text.slice(previous.text.length)
    if (!delta) return previous
    const normalizedDelta = (last.text.endsWith("\r") && delta.startsWith("\n") ? delta.slice(1) : delta).replace(/\r\n?|\n/g, "\n")
    return { text, tail, sources: [...previous.sources.slice(0, -1), { ...last, text: last.text + delta, normalized: last.normalized + normalizedDelta }] }
  }
  return { text, tail, sources: markdownCodeSources(text) }
}
