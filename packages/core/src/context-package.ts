export * as ContextPackage from "./context-package"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ContextContract } from "./context-contract"
import { estimateTokens } from "./runtime/compiler"

export const VERSION = "v3"
export const COMPILER_VERSION = "context-package-v1"
const CONTEXT_LAYERS: ReadonlyArray<ContextContract.ContextLayer> = [
  "authority",
  "current_request",
  "protected_checkpoint",
  "cognitive_state",
  "recent_history",
  "recalled_memory",
  "derived_summary",
  "optional_context",
]

export type CompileInput = {
  readonly model: string
  readonly modelProfileRevision?: string
  readonly tokenizer?: {
    readonly revision: string
    readonly kind?: "provider" | "upper-bound"
    readonly count: (input: string) => number
  }
  readonly usableInputTokens: number
  readonly units: ReadonlyArray<ContextContract.Unit>
  readonly protectedFacts?: ReadonlyArray<string>
}

export interface Message {
  readonly unitID: string
  readonly role: "system" | "user" | "assistant" | "tool" | "context"
  readonly text: string
}

export interface ManifestEntry {
  readonly unitID: string
  readonly sourceID?: string
  readonly evidenceID?: string
  readonly sourceDigest?: string
  readonly instructionAllowed?: boolean
  readonly sensitivity?: ContextContract.Sensitivity
  readonly authority: ContextContract.Authority
  readonly origin: ContextContract.Origin
  readonly contextLayer: ContextContract.ContextLayer
  readonly trust: ContextContract.Trust
  readonly tokens: number
  readonly selected: boolean
  readonly omissionReason?: "budget_exceeded"
}

export interface Omission {
  readonly unitID: string
  readonly reason: "budget_exceeded"
  readonly tokens: number
}

export interface ProtectedFactCoverage {
  readonly required: ReadonlyArray<string>
  readonly present: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  readonly complete: boolean
}

export interface Allocation {
  readonly contextLayer: ContextContract.ContextLayer
  readonly tokens: number
  readonly unitIDs: ReadonlyArray<string>
}

export interface Package {
  readonly version: typeof VERSION
  readonly compilerVersion: typeof COMPILER_VERSION
  readonly model: string
  readonly modelProfileRevision?: string
  readonly tokenizerRevision?: string
  readonly tokenizerMethod?: "provider-tokenizer" | "upper-bound" | "estimator"
  readonly usableInputTokens: number
  readonly usedInputTokens: number
  readonly messages: ReadonlyArray<Message>
  readonly manifest: ReadonlyArray<ManifestEntry>
  readonly omissions: ReadonlyArray<Omission>
  readonly allocation: ReadonlyArray<Allocation>
  readonly protectedFactCoverage: ProtectedFactCoverage
  readonly digest: string
}

export class MandatoryContextOverflowError extends Error {
  readonly _tag = "Context.MandatoryContextOverflow"
  constructor(
    readonly requiredTokens: number,
    readonly usableInputTokens: number,
  ) {
    super(`Mandatory context requires ${requiredTokens} tokens but only ${usableInputTokens} are usable`)
  }
}

export class InvalidPackageError extends Error {
  readonly _tag = "Context.InvalidPackage"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const roleFor = (unit: ContextContract.Unit): Message["role"] => {
  switch (unit.origin) {
    case "request":
    case "interaction":
      return "user"
    case "tool":
      return "tool"
    case "summary":
    case "compaction":
      return "context"
    default:
      return "system"
  }
}

const canonical = (value: unknown): string => {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

const digestOf = (value: Omit<Package, "digest">): string =>
  createHash("sha256").update(canonical(value), "utf8").digest("hex")

const tokenCount = (
  text: string,
  tokenizer: CompileInput["tokenizer"],
): { readonly tokens: number; readonly method: Package["tokenizerMethod"] } => {
  if (tokenizer === undefined) return { tokens: estimateTokens(text), method: "estimator" }
  try {
    const value = tokenizer.count(text)
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid tokenizer result")
    return { tokens: Math.ceil(value), method: tokenizer.kind === "upper-bound" ? "upper-bound" : "provider-tokenizer" }
  } catch {
    return { tokens: estimateTokens(text), method: "estimator" }
  }
}

const freeze = <A extends Package>(value: A): A =>
  Object.freeze({
    ...value,
    messages: Object.freeze(value.messages.map((item) => Object.freeze({ ...item }))),
    manifest: Object.freeze(value.manifest.map((item) => Object.freeze({ ...item }))),
    omissions: Object.freeze(value.omissions.map((item) => Object.freeze({ ...item }))),
    allocation: Object.freeze(
      value.allocation.map((item) => Object.freeze({ ...item, unitIDs: Object.freeze([...item.unitIDs]) })),
    ),
    protectedFactCoverage: Object.freeze({
      ...value.protectedFactCoverage,
      required: Object.freeze([...value.protectedFactCoverage.required]),
      present: Object.freeze([...value.protectedFactCoverage.present]),
      missing: Object.freeze([...value.protectedFactCoverage.missing]),
    }),
  }) as A

export function compile(input: CompileInput): Package {
  if (!input.model.trim()) throw new InvalidPackageError("model is required")
  if (!Number.isInteger(input.usableInputTokens) || input.usableInputTokens < 0)
    throw new InvalidPackageError("usableInputTokens must be a non-negative integer")
  const units = input.units.map((unit) => Schema.decodeUnknownSync(ContextContract.Unit)(unit))
  const prepared = units.map((unit, index) => ({
    unit,
    index,
    ...tokenCount(unit.text, input.tokenizer),
  }))
  const mandatory = prepared.filter(({ unit }) => unit.mandatory)
  const mandatoryTokens = mandatory.reduce((sum, item) => sum + item.tokens, 0)
  if (mandatoryTokens > input.usableInputTokens)
    throw new MandatoryContextOverflowError(mandatoryTokens, input.usableInputTokens)
  const selected = new Set(mandatory.map((item) => item.unit.id))
  let remaining = input.usableInputTokens - mandatoryTokens
  const optional = prepared
    .filter(({ unit }) => !unit.mandatory)
    .toSorted(
      (left, right) =>
        (right.unit.selectionScore ?? 0) - (left.unit.selectionScore ?? 0) ||
        (right.unit.priority ?? 0) - (left.unit.priority ?? 0) ||
        left.index - right.index,
    )
  const omissions: Omission[] = []
  for (const item of optional) {
    if (item.tokens <= remaining) {
      selected.add(item.unit.id)
      remaining -= item.tokens
    } else {
      omissions.push({ unitID: item.unit.id, reason: "budget_exceeded", tokens: item.tokens })
    }
  }
  const selectedItems = prepared
    .filter(({ unit }) => selected.has(unit.id))
    .sort((left, right) => left.index - right.index)
  const messages = selectedItems.map(({ unit }) => ({ unitID: unit.id, role: roleFor(unit), text: unit.text }))
  const manifest = prepared.map(({ unit, tokens }) => ({
    unitID: unit.id,
    ...(unit.sourceID === undefined ? {} : { sourceID: unit.sourceID }),
    ...(unit.evidenceID === undefined ? {} : { evidenceID: unit.evidenceID }),
    ...(unit.sourceDigest === undefined ? {} : { sourceDigest: unit.sourceDigest }),
    ...(unit.instructionAllowed === undefined ? {} : { instructionAllowed: unit.instructionAllowed }),
    ...(unit.sensitivity === undefined ? {} : { sensitivity: unit.sensitivity }),
    authority: unit.authority,
    origin: unit.origin,
    contextLayer: unit.contextLayer,
    trust: unit.trust,
    tokens,
    selected: selected.has(unit.id),
    ...(selected.has(unit.id) ? {} : { omissionReason: "budget_exceeded" as const }),
  }))
  const allocation = CONTEXT_LAYERS.map((contextLayer) => {
    const layerItems = selectedItems.filter(({ unit }) => unit.contextLayer === contextLayer)
    return {
      contextLayer,
      tokens: layerItems.reduce((sum, item) => sum + item.tokens, 0),
      unitIDs: layerItems.map((item) => item.unit.id),
    }
  }).filter((item) => item.unitIDs.length > 0)
  const required = [...new Set(input.protectedFacts ?? [])]
  const body = messages.map((message) => message.text).join("\n")
  const present = required.filter((fact) => body.includes(fact))
  const packageWithoutDigest: Omit<Package, "digest"> = {
    version: VERSION,
    compilerVersion: COMPILER_VERSION,
    model: input.model,
    ...(input.modelProfileRevision === undefined ? {} : { modelProfileRevision: input.modelProfileRevision }),
    ...(input.tokenizer?.revision === undefined ? {} : { tokenizerRevision: input.tokenizer.revision }),
    tokenizerMethod:
      prepared.length === 0
        ? input.tokenizer === undefined
          ? ("estimator" as const)
          : input.tokenizer.kind === "upper-bound"
            ? ("upper-bound" as const)
            : ("provider-tokenizer" as const)
        : prepared.some((item) => item.method === "estimator")
          ? ("estimator" as const)
          : prepared.every((item) => item.method === "upper-bound")
            ? ("upper-bound" as const)
            : ("provider-tokenizer" as const),
    usableInputTokens: input.usableInputTokens,
    usedInputTokens: selectedItems.reduce((sum, item) => sum + item.tokens, 0),
    messages,
    manifest,
    omissions,
    allocation,
    protectedFactCoverage: {
      required,
      present,
      missing: required.filter((fact) => !present.includes(fact)),
      complete: present.length === required.length,
    },
  }
  return freeze({ ...packageWithoutDigest, digest: digestOf(packageWithoutDigest) })
}

export function verify(value: Package): Package {
  const { digest, ...withoutDigest } = value
  if (digestOf(withoutDigest) !== digest) throw new InvalidPackageError("context package digest mismatch")
  return value
}

export function serialize(value: Package): string {
  return canonical(verify(value))
}
