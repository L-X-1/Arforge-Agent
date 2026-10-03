import { redact } from "@arforge-ai/core/redact"

/**
 * Compatibility contracts for the historical Python print entry point.
 *
 * This module deliberately contains no session execution.  `run.ts` remains
 * the only CLI execution owner; these helpers only validate input, classify a
 * terminal error, and render the canonical Core event projection.
 */

export const PRINT_INPUT_FORMATS = ["text", "stream-json"] as const
export const PRINT_OUTPUT_FORMATS = ["text", "stream-json"] as const
export type PrintInputFormat = (typeof PRINT_INPUT_FORMATS)[number]
export type PrintOutputFormat = (typeof PRINT_OUTPUT_FORMATS)[number]

export const PRINT_MAX_INPUT_CHARS = 100_000
export const PRINT_MAX_RECORD_BYTES = 64 * 1024

export const PRINT_RETRYABLE_CODES = new Set([
  "OPERATION_TIMEOUT",
  "PROVIDER_TIMEOUT",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
])

const RETRYABLE_MESSAGE = /(?:\b429\b|\b5\d\d\b|rate.?limit|timed?.?out|timeout|temporar|connection|unavailable)/i
const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|credential|private[_-]?key)/i

export class PrintModeInputError extends Error {
  readonly code = "INVALID_INPUT"

  constructor(message: string) {
    super(message)
    this.name = "PrintModeInputError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate and flatten one JSONL user message. */
export function parsePrintStreamMessage(line: string, lineNumber: number): string {
  let payload: unknown
  try {
    payload = JSON.parse(line)
  } catch (error) {
    const position = error instanceof SyntaxError && /position (\d+)/i.exec(error.message)?.[1]
    const column = position ? Number(position) + 1 : 1
    throw new PrintModeInputError(`invalid JSONL input at line ${lineNumber}, column ${column}`)
  }

  if (!isRecord(payload) || payload.role !== "user") {
    throw new PrintModeInputError(`line ${lineNumber} must be a user message object`)
  }

  const content = payload.content
  let text: string
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const [index, item] of content.entries()) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        throw new PrintModeInputError(`line ${lineNumber} content part ${index + 1} must be a text object`)
      }
      parts.push(item.text)
    }
    text = parts.join("")
  } else {
    throw new PrintModeInputError(`line ${lineNumber} content must be text or text parts`)
  }

  if (!text.trim()) throw new PrintModeInputError(`line ${lineNumber} contains an empty user message`)
  if (text.length > PRINT_MAX_INPUT_CHARS) {
    throw new PrintModeInputError(`line ${lineNumber} exceeds ${PRINT_MAX_INPUT_CHARS} characters`)
  }
  return text
}

/** Parse non-empty JSONL lines, preserving their order and line diagnostics. */
export function parsePrintStreamMessages(input: string): string[] {
  const messages: string[] = []
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    messages.push(parsePrintStreamMessage(line, index + 1))
  }
  return messages
}

export function resolvePrintMessages(
  inputFormat: PrintInputFormat,
  positional: string,
  piped: string | undefined,
): string[] {
  if (inputFormat === "stream-json") {
    const messages = piped === undefined ? [] : parsePrintStreamMessages(piped)
    if (positional.trim()) messages.unshift(positional)
    if (messages.length === 0) throw new PrintModeInputError("print mode received no user messages")
    return messages
  }

  const text = positional && piped ? positional + "\n" + piped : positional || piped || ""
  if (!text.trim()) throw new PrintModeInputError("print mode requires a non-empty prompt")
  if (text.length > PRINT_MAX_INPUT_CHARS) {
    throw new PrintModeInputError(`prompt exceeds ${PRINT_MAX_INPUT_CHARS} characters`)
  }
  return [text]
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]"
  if (typeof value === "string") return redact(value).slice(0, 16_000)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitize(item, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED_SECRET]" : sanitize(item, depth + 1)]),
    )
  }
  return String(value).slice(0, 16_000)
}

/** Serialize tool arguments/results without leaking credential-shaped fields. */
export function safePrintJson(value: unknown, maxBytes = PRINT_MAX_RECORD_BYTES): string {
  let encoded: string
  try {
    encoded = JSON.stringify(sanitize(value)) ?? "null"
  } catch {
    encoded = JSON.stringify("[UNSERIALIZABLE]")
  }
  if (Buffer.byteLength(encoded, "utf8") <= maxBytes) return encoded
  const bounded = encoded.slice(0, Math.max(0, maxBytes - 32))
  return JSON.stringify(`${bounded}[TRUNCATED]`)
}

function asErrorParts(error: unknown): { code: string; message: string } {
  if (typeof error === "string") return { code: "", message: error }
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : undefined
    const code =
      typeof error.code === "string"
        ? error.code
        : typeof error.name === "string"
          ? error.name
          : typeof data?.code === "string"
            ? data.code
            : typeof data?.name === "string"
              ? data.name
              : ""
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : String(error)
    return { code, message }
  }
  return { code: "", message: String(error) }
}

export function isPrintRetryableError(error: unknown): boolean {
  const { code, message } = asErrorParts(error)
  return PRINT_RETRYABLE_CODES.has(code.toUpperCase()) || RETRYABLE_MESSAGE.test(message)
}

export type PrintModeOptions = {
  readonly outputFormat: PrintOutputFormat
  readonly finalMessageOnly: boolean
  readonly stdout?: NodeJS.WritableStream
  readonly stderr?: NodeJS.WritableStream
}

type ToolCall = { readonly name: string; readonly input: Record<string, unknown> }

/**
 * Stable output adapter used by `run.ts`.  It consumes mature Core boundaries
 * and never starts a second operation or tool pipeline.
 */
export class PrintModeRenderer {
  readonly #options: PrintModeOptions
  readonly #stdout: NodeJS.WritableStream
  readonly #stderr: NodeJS.WritableStream
  readonly #tools = new Map<string, ToolCall>()
  readonly #completedTools = new Set<string>()
  readonly #textParts = new Set<string>()
  readonly #textByID = new Map<string, string>()
  #answer = ""
  #finalAnswer?: string
  #printedText = false
  #assistantEmitted = false

  constructor(options: PrintModeOptions) {
    this.#options = options
    this.#stdout = options.stdout ?? process.stdout
    this.#stderr = options.stderr ?? process.stderr
  }

  beginTurn() {
    this.#tools.clear()
    this.#completedTools.clear()
    this.#textParts.clear()
    this.#textByID.clear()
    this.#answer = ""
    this.#finalAnswer = undefined
    this.#printedText = false
    this.#assistantEmitted = false
  }

  #appendText(value: string) {
    if (!value) return
    this.#answer += value
    if (this.#options.outputFormat === "text" && !this.#options.finalMessageOnly) {
      this.#stdout.write(value)
      this.#printedText = true
    }
  }

  text(value: string, partID?: string) {
    if (!value) return
    if (partID && this.#textParts.has(partID)) return
    this.#appendText(value)
    if (partID) {
      this.#textParts.add(partID)
      this.#textByID.set(partID, value)
    }
  }

  textDelta(value: string, partID: string) {
    if (!value) return
    this.#appendText(value)
    this.#textByID.set(partID, (this.#textByID.get(partID) ?? "") + value)
  }

  textEnded(value: string, partID: string) {
    const previous = this.#textByID.get(partID) ?? ""
    const delta = value.startsWith(previous) ? value.slice(previous.length) : previous ? "" : value
    this.#appendText(delta)
    this.#textByID.set(partID, value)
    this.#textParts.add(partID)
  }

  finalAnswer(value: string) {
    if (value) this.#finalAnswer = value
  }

  toolCalled(callID: string, name: string, input: Record<string, unknown>) {
    this.#tools.set(callID, { name, input })
    if (this.#options.outputFormat === "stream-json") {
      this.#flushAssistant()
      this.#json({
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: callID,
            function: { name, arguments: safePrintJson(input) },
          },
        ],
      })
      return
    }
    if (!this.#options.finalMessageOnly) this.#stderr.write(`[tool] ${name}\n`)
  }

  toolCompleted(callID: string, content: unknown, failed: boolean) {
    if (this.#completedTools.has(callID)) return
    this.#completedTools.add(callID)
    const tool = this.#tools.get(callID)
    this.#tools.delete(callID)
    const text = typeof content === "string" ? redact(content).slice(0, PRINT_MAX_RECORD_BYTES) : safePrintJson(content)
    if (this.#options.outputFormat === "stream-json") {
      this.#json({ role: "tool", tool_call_id: callID, content: text, is_error: failed })
      return
    }
    if (!this.#options.finalMessageOnly) this.#stderr.write(`[tool:${failed ? "failed" : "done"}] ${tool?.name ?? "tool"}: ${text}\n`)
  }

  finish() {
    const finalAnswer = this.#finalAnswer ?? this.#answer
    if (this.#options.outputFormat === "stream-json") {
      if (this.#answer) this.#flushAssistant()
      else if (finalAnswer && !this.#assistantEmitted) {
        this.#json({ role: "assistant", content: finalAnswer })
        this.#assistantEmitted = true
      }
      return
    }
    if (this.#options.finalMessageOnly) {
      if (finalAnswer) this.#stdout.write(finalAnswer)
      if (finalAnswer && !finalAnswer.endsWith("\n")) this.#stdout.write("\n")
      return
    }
    if (this.#printedText && !this.#answer.endsWith("\n")) this.#stdout.write("\n")
    if (!this.#printedText && finalAnswer) {
      this.#stdout.write(finalAnswer)
      if (!finalAnswer.endsWith("\n")) this.#stdout.write("\n")
    }
  }

  error(error: unknown) {
    const { message } = asErrorParts(error)
    if (message) this.#stderr.write(redact(message).slice(0, 2_000) + "\n")
  }

  get answer() {
    return this.#finalAnswer ?? this.#answer
  }

  #flushAssistant() {
    if (!this.#answer) return
    this.#json({ role: "assistant", content: this.#answer })
    this.#assistantEmitted = true
    this.#answer = ""
  }

  #json(value: Record<string, unknown>) {
    this.#stdout.write(JSON.stringify(value) + "\n")
  }
}
