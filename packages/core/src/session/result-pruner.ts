export * as ResultPruner from "./result-pruner"

import { Message, type ToolContent, type ToolResultPart, type ToolResultValue } from "@arforge-ai/llm"

/** Versioned because the exact projection is part of provider request identity. */
export const POLICY_REVISION = "tool-result-pruner/v1"

/** Fixed, model-visible replacement for every removed middle span. */
export const PRUNE_MARKER = "\n\n[... tool result middle pruned; original retained in session history ...]\n\n"

export type Config = Readonly<{
  /** Prune when the combined text in one result exceeds this many Unicode code points. */
  readonly thresholdChars?: number
  /** Leading Unicode code points retained across all text blocks. */
  readonly headChars?: number
  /** Trailing Unicode code points retained across all text blocks. */
  readonly tailChars?: number
}>

export type ResolvedConfig = Readonly<{
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}>

export const DEFAULT_CONFIG: ResolvedConfig = Object.freeze({
  thresholdChars: 8_192,
  headChars: 4_096,
  tailChars: 1_024,
})

export type PrunedEntry = Readonly<{
  readonly messageIndex: number
  readonly partIndex: number
  readonly messageID?: string
  readonly toolCallID: string
  readonly toolName: string
  readonly resultType: ToolResultValue["type"]
  readonly charsBefore: number
  readonly charsAfter: number
}>

export type Result = Readonly<{
  readonly revision: typeof POLICY_REVISION
  readonly config: ResolvedConfig
  readonly messages: ReadonlyArray<Message>
  readonly pruned: ReadonlyArray<PrunedEntry>
  readonly charsRemoved: number
  readonly changed: boolean
}>

const CONFIG_KEYS = new Set(["thresholdChars", "headChars", "tailChars"])

export const codePointLength = (value: string) => Array.from(value).length

const positiveInteger = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}

const nonNegativeInteger = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
}

/** Resolve once into a detached immutable policy; stale keys fail closed. */
export const resolveConfig = (input: Config = {}): ResolvedConfig => {
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new TypeError(`Unknown ResultPruner config key: ${key}`)
  }
  const resolved = {
    thresholdChars: input.thresholdChars ?? DEFAULT_CONFIG.thresholdChars,
    headChars: input.headChars ?? DEFAULT_CONFIG.headChars,
    tailChars: input.tailChars ?? DEFAULT_CONFIG.tailChars,
  }
  positiveInteger("thresholdChars", resolved.thresholdChars)
  nonNegativeInteger("headChars", resolved.headChars)
  nonNegativeInteger("tailChars", resolved.tailChars)
  const emitted = resolved.headChars + codePointLength(PRUNE_MARKER) + resolved.tailChars
  if (emitted > resolved.thresholdChars)
    throw new TypeError(
      `ResultPruner headChars + marker + tailChars (${emitted}) exceeds thresholdChars (${resolved.thresholdChars})`,
    )
  return Object.freeze({ ...resolved })
}

const measureContent = (content: ReadonlyArray<ToolContent>) =>
  content.reduce((total, block) => total + (block.type === "text" ? codePointLength(block.text) : 0), 0)

/**
 * Prune text as one logical stream while leaving every non-text block in its
 * original relative position. Array.from prevents slicing a UTF-16 surrogate
 * pair; grapheme clusters are deliberately outside this model-free policy.
 */
const pruneContent = (
  content: ReadonlyArray<ToolContent>,
  config: ResolvedConfig,
):
  | Readonly<{ readonly content: ReadonlyArray<ToolContent>; readonly before: number; readonly after: number }>
  | undefined => {
  const before = measureContent(content)
  if (before <= config.thresholdChars) return
  const removedStart = config.headChars
  const removedEnd = before - config.tailChars
  const output: ToolContent[] = []
  let consumed = 0
  let markerInserted = false

  for (const block of content) {
    if (block.type !== "text") {
      output.push(block)
      continue
    }
    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ""
    if (marker) markerInserted = true
    const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("")
    if (text) output.push({ ...block, text })
    consumed = blockEnd
  }

  if (!markerInserted) throw new Error("ResultPruner could not locate the deterministic middle span")
  const after = measureContent(output)
  if (after > config.thresholdChars || after >= before)
    throw new Error("ResultPruner replacement must be smaller and within the configured threshold")
  return Object.freeze({ content: Object.freeze(output), before, after })
}

const pruneScalar = (value: unknown, config: ResolvedConfig) => {
  if (typeof value !== "string" || codePointLength(value) <= config.thresholdChars) return
  const points = Array.from(value)
  const text =
    points.slice(0, config.headChars).join("") +
    PRUNE_MARKER +
    (config.tailChars === 0 ? "" : points.slice(-config.tailChars).join(""))
  const after = codePointLength(text)
  if (after > config.thresholdChars || after >= points.length)
    throw new Error("ResultPruner scalar replacement must be smaller and within the configured threshold")
  return Object.freeze({ value: text, before: points.length, after })
}

const prunePart = (part: ToolResultPart, config: ResolvedConfig) => {
  if (part.result.type === "content") {
    const pruned = pruneContent(part.result.value, config)
    if (!pruned) return
    return {
      part: { ...part, result: { ...part.result, value: pruned.content } } satisfies ToolResultPart,
      before: pruned.before,
      after: pruned.after,
    }
  }
  if (part.result.type !== "text" && part.result.type !== "error") return
  const pruned = pruneScalar(part.result.value, config)
  if (!pruned) return
  return {
    part: { ...part, result: { ...part.result, value: pruned.value } } satisfies ToolResultPart,
    before: pruned.before,
    after: pruned.after,
  }
}

/**
 * Build a deterministic provider-visible projection without mutating Session
 * history. Tool calls, result IDs, metadata, errors, cache hints and rich
 * blocks remain unchanged; only an over-budget result's text middle changes.
 */
export const pruneMessages = (messages: ReadonlyArray<Message>, rawConfig: Config = {}): Result => {
  const config = resolveConfig(rawConfig)
  const pruned: PrunedEntry[] = []
  const projected = messages.map((message, messageIndex) => {
    let changed = false
    const content = message.content.map((part, partIndex) => {
      if (part.type !== "tool-result") return part
      const replacement = prunePart(part, config)
      if (!replacement) return part
      changed = true
      pruned.push(
        Object.freeze({
          messageIndex,
          partIndex,
          ...(message.id === undefined ? {} : { messageID: message.id }),
          toolCallID: part.id,
          toolName: part.name,
          resultType: part.result.type,
          charsBefore: replacement.before,
          charsAfter: replacement.after,
        }),
      )
      return replacement.part
    })
    return changed ? Message.make({ ...message, content }) : message
  })
  const charsRemoved = pruned.reduce((total, entry) => total + entry.charsBefore - entry.charsAfter, 0)
  return Object.freeze({
    revision: POLICY_REVISION,
    config,
    messages: Object.freeze(projected),
    pruned: Object.freeze(pruned),
    charsRemoved,
    changed: pruned.length > 0,
  })
}
