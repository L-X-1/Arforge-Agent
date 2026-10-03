export * as ContextBudget from "./context-budget"

import { createHash } from "node:crypto"
import * as ContextPackage from "./context-package"
import { Token } from "./util/token"

export type Tokenizer = {
  readonly revision: string
  readonly kind?: "provider" | "upper-bound"
  readonly count: (input: string) => number
}

export type TokenCount = {
  readonly tokens: number
  readonly method: "provider-tokenizer" | "upper-bound" | "estimator"
  readonly tokenizerRevision?: string
  readonly fallbackReason?: "unavailable" | "failed" | "invalid"
}

export class BudgetError extends Error {
  readonly _tag = "Context.BudgetError"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const integer = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))
    throw new BudgetError(`${name} must be a non-negative integer`)
  return value
}

export function count(input: string, tokenizer?: Tokenizer): TokenCount {
  if (tokenizer === undefined)
    return { tokens: Token.estimate(input), method: "estimator", fallbackReason: "unavailable" }
  try {
    const value = tokenizer.count(input)
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid tokenizer result")
    return {
      tokens: Math.ceil(value),
      method: tokenizer.kind === "upper-bound" ? "upper-bound" : "provider-tokenizer",
      tokenizerRevision: tokenizer.revision,
    }
  } catch (error) {
    return {
      tokens: Token.estimate(input),
      method: "estimator",
      fallbackReason: error instanceof Error ? "failed" : "invalid",
    }
  }
}

export interface BudgetInput {
  readonly contextWindowTokens: number
  readonly requestedInputTokens: number
  readonly inputText?: string
  readonly outputTokens: number
  readonly toolTokens: number
  readonly recoveryTokens: number
  readonly safetyBufferTokens?: number
  readonly tokenizer?: Tokenizer
}

export interface Plan {
  readonly contextWindowTokens: number
  readonly requestedInputTokens: number
  readonly outputTokens: number
  readonly toolTokens: number
  readonly recoveryTokens: number
  readonly safetyBufferTokens: number
  readonly reservedTokens: number
  readonly usableInputTokens: number
  readonly inputFits: boolean
  readonly tokenizer: TokenCount
}

/** Reserves output/tool/recovery capacity before compiling a Context Package. */
export function plan(input: BudgetInput): Plan {
  const contextWindowTokens = integer(input.contextWindowTokens, "contextWindowTokens")
  const requestedInputTokens = integer(input.requestedInputTokens, "requestedInputTokens")
  const outputTokens = integer(input.outputTokens, "outputTokens")
  const toolTokens = integer(input.toolTokens, "toolTokens")
  const recoveryTokens = integer(input.recoveryTokens, "recoveryTokens")
  const safetyBufferTokens = integer(input.safetyBufferTokens ?? 0, "safetyBufferTokens")
  const reservedTokens = outputTokens + toolTokens + recoveryTokens + safetyBufferTokens
  const usableInputTokens = Math.max(0, contextWindowTokens - reservedTokens)
  return Object.freeze({
    contextWindowTokens,
    requestedInputTokens,
    outputTokens,
    toolTokens,
    recoveryTokens,
    safetyBufferTokens,
    reservedTokens,
    usableInputTokens,
    inputFits: requestedInputTokens <= usableInputTokens,
    tokenizer:
      input.inputText === undefined
        ? ({ tokens: requestedInputTokens, method: "estimator", fallbackReason: "unavailable" } as const)
        : count(input.inputText, input.tokenizer),
  })
}

export interface PackagePlanInput extends Omit<BudgetInput, "requestedInputTokens"> {
  readonly package: ContextPackage.Package
}

export function planPackage(input: PackagePlanInput): Plan {
  const text = input.package.messages.map((message) => message.text).join("\n")
  const measured = count(text, input.tokenizer)
  return Object.freeze({
    ...plan({ ...input, requestedInputTokens: measured.tokens }),
    tokenizer: measured,
  })
}

export type CompactionKind = "system" | "user" | "assistant" | "tool-call" | "tool-response" | "context"

export interface CompactionEntry {
  readonly id: string
  readonly kind: CompactionKind
  readonly text: string
  readonly pairID?: string
}

export interface CompactionAnchors {
  readonly objective: string
  readonly policy: string
  readonly protectedFacts: ReadonlyArray<string>
}

export interface CompactionInput {
  readonly entries: ReadonlyArray<CompactionEntry>
  readonly recentTokenBudget: number
  readonly anchors: CompactionAnchors
  readonly summarize: (input: { readonly entries: ReadonlyArray<CompactionEntry> }) => string | undefined
  readonly tokenizer?: Tokenizer
}

export interface CompactionResult {
  readonly status: "compacted" | "noop"
  readonly reason: "compacted" | "not-needed" | "empty-head" | "failed" | "not-smaller"
  readonly summary?: string
  readonly retained: ReadonlyArray<CompactionEntry>
  readonly removed: ReadonlyArray<CompactionEntry>
  readonly protectedFacts: ReadonlyArray<string>
  readonly tokenCountBefore: number
  readonly tokenCountAfter: number
  readonly tokenizer: TokenCount
}

type EntryGroup = { readonly entries: ReadonlyArray<CompactionEntry>; readonly tokens: number }

const grouped = (entries: ReadonlyArray<CompactionEntry>): ReadonlyArray<EntryGroup> => {
  const groups: Array<{ entries: CompactionEntry[]; pairID?: string }> = []
  for (const entry of entries) {
    const previous = groups.at(-1)
    const paired = entry.pairID !== undefined && (entry.kind === "tool-call" || entry.kind === "tool-response")
    if (paired && previous?.pairID === entry.pairID) previous.entries.push(entry)
    else groups.push({ entries: [entry], ...(paired ? { pairID: entry.pairID } : {}) })
  }
  return groups.map((group) => ({ entries: Object.freeze([...group.entries]), tokens: 0 }))
}

const withTokens = (groups: ReadonlyArray<EntryGroup>, tokenizer?: Tokenizer): ReadonlyArray<EntryGroup> =>
  groups.map((group) => ({
    ...group,
    tokens: group.entries.reduce((total, entry) => total + count(entry.text, tokenizer).tokens, 0),
  }))

const anchorSummary = (anchors: CompactionAnchors, generated: string): string =>
  [
    "## Objective",
    anchors.objective,
    "## Policy",
    anchors.policy,
    "## Protected Facts",
    anchors.protectedFacts.length === 0 ? "(none)" : anchors.protectedFacts.map((fact) => `- ${fact}`).join("\n"),
    "## Derived Summary",
    generated,
  ].join("\n")

const noop = (
  reason: CompactionResult["reason"],
  entries: ReadonlyArray<CompactionEntry>,
  before: number,
  tokenizer: TokenCount,
  anchors: CompactionAnchors,
): CompactionResult =>
  Object.freeze({
    status: "noop",
    reason,
    retained: Object.freeze([...entries]),
    removed: Object.freeze([]),
    protectedFacts: Object.freeze([...anchors.protectedFacts]),
    tokenCountBefore: before,
    tokenCountAfter: before,
    tokenizer,
  })

/**
 * Compacts only complete atomic groups. Tool call/response pairs are never split;
 * anchors are assembled outside model output so a generated summary cannot replace them.
 */
export function compact(input: CompactionInput): CompactionResult {
  const recentTokenBudget = integer(input.recentTokenBudget, "recentTokenBudget")
  const groups = withTokens(grouped(input.entries), input.tokenizer)
  const before = groups.reduce((total, group) => total + group.tokens, 0)
  const measuredBefore = count(String(before), input.tokenizer)
  if (input.entries.length === 0 || before <= recentTokenBudget)
    return noop("not-needed", input.entries, before, measuredBefore, input.anchors)

  let split = groups.length
  let recentTokens = 0
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const next = recentTokens + groups[index].tokens
    if (next > recentTokenBudget) break
    recentTokens = next
    split = index
  }
  const head = groups.slice(0, split).flatMap((group) => group.entries)
  const retained = groups.slice(split).flatMap((group) => group.entries)
  if (head.length === 0) return noop("empty-head", input.entries, before, measuredBefore, input.anchors)

  let generated: string | undefined
  try {
    generated = input.summarize({ entries: Object.freeze([...head]) })?.trim()
  } catch {
    return noop("failed", input.entries, before, measuredBefore, input.anchors)
  }
  if (!generated) return noop("failed", input.entries, before, measuredBefore, input.anchors)
  const summary = anchorSummary(input.anchors, generated)
  const after = count(summary, input.tokenizer).tokens + recentTokens
  if (after >= before) return noop("not-smaller", input.entries, before, measuredBefore, input.anchors)
  return Object.freeze({
    status: "compacted",
    reason: "compacted",
    summary,
    retained: Object.freeze([...retained]),
    removed: Object.freeze([...head]),
    protectedFacts: Object.freeze([...input.anchors.protectedFacts]),
    tokenCountBefore: before,
    tokenCountAfter: after,
    tokenizer: count(summary, input.tokenizer),
  })
}

export interface CacheScope {
  readonly tenantID: string
  readonly packageDigest: string
  readonly modelProfileRevision: string
  readonly toolSchemaDigest: string
}

export interface CacheRecord {
  readonly key: string
  readonly tenantDigest: string
  readonly packageDigest: string
  readonly modelProfileRevision: string
  readonly toolSchemaDigest: string
  readonly outputDigest: string
  readonly tokenCount: number
}

export interface DigestCache {
  readonly get: (scope: CacheScope) => CacheRecord | undefined
  readonly put: (scope: CacheScope, record: Omit<CacheRecord, "key" | "tenantDigest">) => CacheRecord
  readonly clear: () => void
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
const nonEmpty = (value: string, name: string) => {
  if (!value.trim()) throw new BudgetError(`${name} is required`)
  return value
}

export function cacheKey(scope: CacheScope): string {
  nonEmpty(scope.tenantID, "tenantID")
  nonEmpty(scope.packageDigest, "packageDigest")
  nonEmpty(scope.modelProfileRevision, "modelProfileRevision")
  nonEmpty(scope.toolSchemaDigest, "toolSchemaDigest")
  return `context-cache-v1:${digest(scope)}`
}

/** A digest-only cache intentionally has no field for prompt, summary, secret, or raw context content. */
export function makeCache(): DigestCache {
  const values = new Map<string, CacheRecord>()
  return {
    get: (scope) => {
      const value = values.get(cacheKey(scope))
      return value?.tenantDigest === digest(scope.tenantID) ? value : undefined
    },
    put: (scope, input) => {
      const key = cacheKey(scope)
      if (!Number.isInteger(input.tokenCount) || input.tokenCount < 0)
        throw new BudgetError("cache tokenCount is invalid")
      for (const field of ["outputDigest", "packageDigest", "toolSchemaDigest"] as const)
        nonEmpty(input[field], `cache ${field}`)
      const value: CacheRecord = Object.freeze({
        ...input,
        key,
        tenantDigest: digest(scope.tenantID),
        packageDigest: scope.packageDigest,
        modelProfileRevision: scope.modelProfileRevision,
        toolSchemaDigest: scope.toolSchemaDigest,
      })
      values.set(key, value)
      return value
    },
    clear: () => values.clear(),
  }
}
