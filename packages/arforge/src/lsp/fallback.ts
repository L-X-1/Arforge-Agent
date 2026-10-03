import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { FSUtil } from "@arforge-ai/core/fs-util"

/**
 * The fallback is intentionally small and deterministic. It is a safety net
 * when no language server is installed, not a second language-server runtime.
 * Keep the limits bounded because this code runs in the request path.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 2_000
export const MAX_RESULTS = 200

export const SOURCE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".go",
  ".rs",
])

export type Operation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls"
  | "diagnostics"

export type PositionInput = {
  file: string
  line: number
  character: number
}

type Point = { line: number; character: number }
type Range = { start: Point; end: Point }

export type FallbackDiagnostic = {
  severity: 1
  message: string
  range: Range
  source: "ts-index-fallback" | "python-compile"
}

type FallbackSymbol = {
  name: string
  kind: number
  location: { uri: string; range: Range }
  selectionRange?: Range
  detail?: string
}

type FileSymbol = FallbackSymbol & { file: string }

const SYMBOL_KIND = {
  class: 5,
  method: 6,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
  struct: 23,
  enum: 10,
  type: 26,
  def: 12,
} as const

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".arforge",
])

const PYTHON_SYMBOL = /^\s*(?:(?:async)\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/
const JS_SYMBOL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:(async)\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
const GO_SYMBOL = /^\s*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/
const RUST_SYMBOL =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/

function extension(file: string) {
  return path.extname(file).toLowerCase()
}

export function isSupported(file: string) {
  return SOURCE_EXTENSIONS.has(extension(file))
}

export async function isWithinFileLimit(file: string) {
  const info = await stat(file).catch(() => undefined)
  return Boolean(info?.isFile() && info.size <= MAX_FILE_BYTES)
}

function clampPoint(point: Point, lines: string[]): Point {
  const line = Math.max(0, Math.min(point.line, Math.max(0, lines.length - 1)))
  const content = lines[line] ?? ""
  return { line, character: Math.max(0, Math.min(point.character, content.length)) }
}

function rangeForLine(line: number, content: string, start = 0, end = content.length): Range {
  return {
    start: { line, character: Math.max(0, start) },
    end: { line, character: Math.max(start, end) },
  }
}

function relativeFile(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}

async function safeRealPath(input: string) {
  return realpath(input).catch(() => path.resolve(input))
}

async function insideWorkspace(root: string, file: string) {
  const [realRoot, realFile] = await Promise.all([safeRealPath(root), safeRealPath(file)])
  return { root: realRoot, file: realFile, inside: FSUtil.contains(realRoot, realFile) }
}

async function readSource(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_FILE_BYTES) return undefined
  return readFile(file, "utf8").catch(() => undefined)
}

function symbolAtPosition(lines: string[], line: number, character: number) {
  const content = lines[line] ?? ""
  const offset = Math.max(0, Math.min(character, Math.max(0, content.length - 1)))
  const regex = /[A-Za-z_$][A-Za-z0-9_$]*/g
  for (const match of content.matchAll(regex)) {
    const start = match.index ?? 0
    const value = match[0]
    if (start <= offset && offset < start + value.length) return value
  }
  return ""
}

function symbolMatch(file: string, content: string, line: number): FallbackSymbol | undefined {
  const ext = extension(file)
  const match =
    ext === ".py"
      ? content.match(PYTHON_SYMBOL)
      : ext === ".go"
        ? content.match(GO_SYMBOL)
        : ext === ".rs"
          ? content.match(RUST_SYMBOL)
          : content.match(JS_SYMBOL)
  if (!match) return undefined

  const name = match[match.length - 1]
  const kindName = match[match.length - 2]
  const nameStart = Math.max(0, content.indexOf(name))
  const range = rangeForLine(line, content)
  const selectionRange = rangeForLine(line, content, nameStart, nameStart + name.length)
  return {
    name,
    kind: SYMBOL_KIND[kindName as keyof typeof SYMBOL_KIND] ?? SYMBOL_KIND.variable,
    location: { uri: pathToFileURL(file).href, range },
    selectionRange,
  }
}

async function documentSymbols(file: string, source?: string): Promise<FallbackSymbol[]> {
  const text = source ?? (await readSource(file))
  if (text === undefined) return []
  const symbols: FallbackSymbol[] = []
  for (const [line, content] of text.split(/\r?\n/).entries()) {
    const symbol = symbolMatch(file, content, line)
    if (symbol) symbols.push(symbol)
  }
  return symbols
}

async function sourceFiles(root: string) {
  const result: string[] = []
  const queue = [root]
  while (queue.length > 0 && result.length < MAX_FILES) {
    const directory = queue.shift()!
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) queue.push(path.join(directory, entry.name))
        continue
      }
      if (entry.isFile()) {
        const file = path.join(directory, entry.name)
        if (isSupported(file)) result.push(file)
        if (result.length >= MAX_FILES) break
      }
    }
  }
  return result.toSorted((a, b) => relativeFile(root, a).localeCompare(relativeFile(root, b)))
}

async function allSymbols(root: string): Promise<FileSymbol[]> {
  const result: FileSymbol[] = []
  for (const file of await sourceFiles(root)) {
    for (const symbol of await documentSymbols(file)) {
      result.push({ ...symbol, file: relativeFile(root, file) })
      if (result.length >= MAX_RESULTS) return result
    }
  }
  return result
}

async function definitions(root: string, name: string) {
  if (!name) return []
  return (await allSymbols(root)).filter((item) => item.name === name).map(({ file, ...item }) => ({ ...item, file }))
}

async function references(root: string, name: string) {
  if (!name) return []
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`\\b${escaped}\\b`, "g")
  const result: Array<{ file: string; range: Range }> = []
  for (const file of await sourceFiles(root)) {
    const source = await readSource(file)
    if (source === undefined) continue
    for (const [line, content] of source.split(/\r?\n/).entries()) {
      for (const match of content.matchAll(pattern)) {
        const start = match.index ?? 0
        result.push({ file: relativeFile(root, file), range: rangeForLine(line, content, start, start + name.length) })
        if (result.length >= MAX_RESULTS) return result
      }
    }
  }
  return result
}

function diagnostic(
  message: string,
  line: number,
  character: number,
  source: FallbackDiagnostic["source"],
  length = 1,
): FallbackDiagnostic {
  return {
    severity: 1,
    message,
    range: {
      start: { line, character },
      end: { line, character: character + length },
    },
    source,
  }
}

function stripPythonComment(content: string) {
  let quote: string | undefined
  let triple = false
  for (let character = 0; character < content.length; character++) {
    const current = content[character]
    if (quote) {
      if (triple) {
        if (content.startsWith(quote.repeat(3), character)) {
          quote = undefined
          triple = false
          character += 2
        } else if (current === "\\") {
          character++
        }
      } else if (current === "\\") {
        character++
      } else if (current === quote) {
        quote = undefined
      }
      continue
    }
    if (current === '"' || current === "'") {
      if (content.startsWith(current.repeat(3), character)) {
        quote = current
        triple = true
        character += 2
      } else {
        quote = current
      }
      continue
    }
    if (current === "#") return content.slice(0, character)
  }
  return content
}

function indentationWidth(content: string) {
  let width = 0
  for (const current of content) {
    if (current === " ") width++
    else if (current === "\t") width += 8 - (width % 8)
    else break
  }
  return width
}

function bracketDelta(content: string) {
  let delta = 0
  let quote: string | undefined
  let triple = false
  for (let character = 0; character < content.length; character++) {
    const current = content[character]
    if (quote) {
      if (triple) {
        if (content.startsWith(quote.repeat(3), character)) {
          quote = undefined
          triple = false
          character += 2
        } else if (current === "\\") {
          character++
        }
      } else if (current === "\\") {
        character++
      } else if (current === quote) {
        quote = undefined
      }
      continue
    }
    if (current === '"' || current === "'") {
      if (content.startsWith(current.repeat(3), character)) {
        quote = current
        triple = true
        character += 2
      } else {
        quote = current
      }
      continue
    }
    if (current === "#") break
    if (current === "(" || current === "[" || current === "{") delta++
    else if (current === ")" || current === "]" || current === "}") delta--
  }
  return delta
}

function pythonCompileDiagnostics(file: string, source: string): FallbackDiagnostic[] {
  const lines = source.split(/\r?\n/)
  const delimiters: Array<{ token: string; line: number; character: number }> = []
  const tripleStringLines = new Set<number>()
  let quote: { token: string; triple: boolean; line: number; character: number } | undefined
  let first: FallbackDiagnostic | undefined

  for (const [line, content] of lines.entries()) {
    if (quote?.triple) tripleStringLines.add(line)
    for (let character = 0; character < content.length; character++) {
      const current = content[character]
      if (quote) {
        if (quote.triple) {
          if (content.startsWith(quote.token.repeat(3), character)) {
            quote = undefined
            character += 2
          } else if (current === "\\") {
            character++
          }
        } else if (current === "\\") {
          character++
        } else if (current === quote.token) {
          quote = undefined
        }
        continue
      }
      if (current === "#") break
      if (current === '"' || current === "'") {
        if (content.startsWith(current.repeat(3), character)) {
          quote = { token: current, triple: true, line, character }
          tripleStringLines.add(line)
          character += 2
        } else {
          quote = { token: current, triple: false, line, character }
        }
        continue
      }
      if (current === "(" || current === "[" || current === "{") {
        delimiters.push({ token: current, line, character })
        continue
      }
      if (current !== ")" && current !== "]" && current !== "}") continue
      const expected = current === ")" ? "(" : current === "]" ? "[" : "{"
      const previous = delimiters.pop()
      if (!previous) {
        first ??= diagnostic(`unmatched '${current}'`, line, character, "python-compile")
      } else if (previous.token !== expected) {
        const names: Record<string, string> = { "(": "parenthesis", "[": "square bracket", "{": "curly brace" }
        first ??= diagnostic(
          `closing ${names[current === ")" ? "(" : current === "]" ? "[" : "{"]} '${current}' does not match opening ${names[previous.token]} '${previous.token}'`,
          line,
          character,
          "python-compile",
        )
      }
    }
    if (quote && !quote.triple) {
      let trailingSlashes = 0
      for (let character = content.length - 1; character >= 0 && content[character] === "\\"; character--) {
        trailingSlashes++
      }
      if (trailingSlashes % 2 === 0) {
        first ??= diagnostic(
          `unterminated string literal (detected at line ${quote.line + 1})`,
          quote.line,
          quote.character,
          "python-compile",
        )
        quote = undefined
      }
    }
  }

  if (quote) {
    first ??= diagnostic(
      quote.triple
        ? `unterminated triple-quoted string literal (detected at line ${quote.line + 1})`
        : `unterminated string literal (detected at line ${quote.line + 1})`,
      quote.line,
      quote.character,
      "python-compile",
    )
  }
  if (delimiters.length > 0) {
    const opening = delimiters[0]!
    first ??= diagnostic(`'${opening.token}' was never closed`, opening.line, opening.character, "python-compile")
  }
  if (first) return [first]

  const blockHeader = /^(?:(?:async)\s+)?(def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b/
  const indents = [0]
  let pending: { indent: number; line: number; keyword: string; character: number } | undefined
  let depth = 0
  for (const [line, raw] of lines.entries()) {
    const code = stripPythonComment(raw)
    const trimmed = code.trim()
    const leading = raw.match(/^[ \t]*/)?.[0] ?? ""
    const indent = indentationWidth(leading)
    const continuation = depth > 0 || /\\\s*$/.test(code)
    if (tripleStringLines.has(line)) continue
    if (!trimmed) {
      depth += bracketDelta(code)
      continue
    }

    const activePending = !continuation ? pending : undefined
    const hadPending = Boolean(activePending)
    if (activePending) {
      if (indent <= activePending.indent) {
        return [
          diagnostic(
            `expected an indented block after '${activePending.keyword}' statement on line ${activePending.line + 1}`,
            line,
            leading.length,
            "python-compile",
          ),
        ]
      }
      pending = undefined
    }

    if (!continuation) {
      const currentIndent = indents.at(-1) ?? 0
      if (indent > currentIndent && !hadPending) {
        return [diagnostic("unexpected indent", line, 0, "python-compile")]
      }
      if (indent < currentIndent) {
        const matching = indents.lastIndexOf(indent)
        if (matching < 0)
          return [diagnostic("unindent does not match any outer indentation level", line, 0, "python-compile")]
        indents.length = matching + 1
      }
    }

    const header = trimmed.match(blockHeader)
    const endsWithColon = trimmed.endsWith(":")
    if (header && !endsWithColon && !/\\\s*$/.test(trimmed)) {
      return [diagnostic("expected ':'", line, code.trimEnd().length, "python-compile")]
    }
    if (header && endsWithColon && !trimmed.includes(";")) {
      pending = {
        indent,
        line,
        keyword: header[1] === "def" ? "function definition" : header[1]!,
        character: code.trimEnd().length,
      }
    }
    if (indent > (indents.at(-1) ?? 0)) indents.push(indent)
    depth += bracketDelta(code)
  }
  if (pending) {
    return [
      diagnostic(
        `expected an indented block after '${pending.keyword}' statement on line ${pending.line + 1}`,
        pending.line,
        pending.character,
        "python-compile",
      ),
    ]
  }
  return []
}

function fallbackDiagnostics(file: string, source: string): FallbackDiagnostic[] {
  if (extension(file) === ".py") {
    const compileDiagnostics = pythonCompileDiagnostics(file, source)
    if (compileDiagnostics.length > 0) return compileDiagnostics
  }
  const stack: Array<{ token: string; line: number; character: number }> = []
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
  const opening = new Set(Object.values(pairs))
  const diagnostics: FallbackDiagnostic[] = []
  for (const [line, content] of source.split(/\r?\n/).entries()) {
    let quote: string | undefined
    for (let character = 0; character < content.length; character++) {
      const current = content[character]
      if (quote) {
        if (current === quote && content[character - 1] !== "\\") quote = undefined
        continue
      }
      if (current === '"' || current === "'" || current === "`") {
        quote = current
        continue
      }
      if (current === "#" && extension(file) === ".py") break
      if (current === "/" && content[character + 1] === "/") break
      if (opening.has(current)) stack.push({ token: current, line, character })
      else if (current in pairs) {
        const expected = pairs[current]
        const previous = stack.pop()
        if (!previous || previous.token !== expected) {
          diagnostics.push({
            severity: 1,
            message: `Unexpected closing ${current}`,
            range: rangeForLine(line, content, character, character + 1),
            source: "ts-index-fallback",
          })
          if (diagnostics.length >= 20) return diagnostics
        }
      }
    }
  }
  for (const item of stack.slice(-20)) {
    diagnostics.push({
      severity: 1,
      message: `Unclosed ${item.token}`,
      range: rangeForLine(item.line, source.split(/\r?\n/)[item.line] ?? "", item.character, item.character + 1),
      source: "ts-index-fallback",
    })
  }
  return diagnostics
}

export async function query(
  operation: Operation,
  input: PositionInput,
  root: string,
  queryText = "",
): Promise<unknown> {
  if (operation === "workspaceSymbol") {
    const boundary = await insideWorkspace(root, root)
    if (!boundary.inside) return []
    const symbols = await allSymbols(boundary.root)
    return symbols
      .filter((item) => !queryText || item.name.toLowerCase().includes(queryText.toLowerCase()))
      .slice(0, 10)
  }
  if (!isSupported(input.file)) return []
  const boundary = await insideWorkspace(root, input.file)
  if (!boundary.inside) return []
  const source = await readSource(boundary.file)
  if (source === undefined) return []
  const lines = source.split(/\r?\n/)
  const point = clampPoint({ line: input.line, character: input.character }, lines)
  const symbol = symbolAtPosition(lines, point.line, point.character)
  if (operation === "hover") {
    return {
      contents: { kind: "plaintext", value: symbol || lines[point.line]?.trim() || "" },
      range: rangeForLine(point.line, lines[point.line] ?? ""),
      backend: "index-fallback",
    }
  }
  if (operation === "documentSymbol") return documentSymbols(boundary.file, source)
  if (operation === "diagnostics") return fallbackDiagnostics(boundary.file, source)
  if (operation === "goToDefinition" || operation === "goToImplementation" || operation === "prepareCallHierarchy") {
    return definitions(boundary.root, symbol)
  }
  if (operation === "findReferences" || operation === "incomingCalls") return references(boundary.root, symbol)
  return []
}

export async function workspaceDiagnostics(root: string) {
  const result: Record<string, FallbackDiagnostic[]> = {}
  for (const file of await sourceFiles(root)) {
    const source = await readSource(file)
    if (source === undefined) continue
    const diagnostics = fallbackDiagnostics(file, source)
    if (diagnostics.length > 0) result[file] = diagnostics
  }
  return result
}
