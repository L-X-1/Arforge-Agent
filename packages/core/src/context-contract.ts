export * as ContextContract from "./context-contract"

import { Schema } from "effect"

/**
 * The durable/runtime authority boundary for Context Engine V3.
 *
 * Event/Run is execution history, Memory is governed knowledge, and
 * summary/compaction is derived prompt material. A Context Package is the
 * replaceable result of compilation, never another source of truth.
 */
export const Authority = Schema.Literals([
  "event-run",
  "context-package",
  "governed-memory",
  "derived",
  "runtime-input",
])
export type Authority = typeof Authority.Type

export const Origin = Schema.Literals([
  "event",
  "run",
  "memory",
  "summary",
  "compaction",
  "instruction",
  "request",
  "interaction",
  "tool",
])
export type Origin = typeof Origin.Type

export const ContextLayer = Schema.Literals([
  "authority",
  "current_request",
  "protected_checkpoint",
  "cognitive_state",
  "recent_history",
  "recalled_memory",
  "derived_summary",
  "optional_context",
])
export type ContextLayer = typeof ContextLayer.Type

export const Trust = Schema.Literals(["trusted", "verified", "untrusted-memory", "untrusted-tool", "derived"])
export type Trust = typeof Trust.Type

export const Sensitivity = Schema.Literals(["public", "internal", "confidential", "secret"])
export type Sensitivity = typeof Sensitivity.Type

export const Unit = Schema.Struct({
  id: Schema.NonEmptyString,
  origin: Origin,
  authority: Authority,
  contextLayer: ContextLayer,
  trust: Trust,
  text: Schema.String,
  mandatory: Schema.Boolean,
  priority: Schema.Int,
  sourceID: Schema.String.pipe(Schema.optional),
  evidenceID: Schema.String.pipe(Schema.optional),
  sourceDigest: Schema.String.pipe(Schema.optional),
  instructionAllowed: Schema.Boolean.pipe(Schema.optional),
  sensitivity: Sensitivity.pipe(Schema.optional),
  selectionScore: Schema.Finite.pipe(Schema.optional),
  recency: Schema.Finite.pipe(Schema.optional),
  protectedFacts: Schema.Array(Schema.String).pipe(Schema.optional),
})
export type Unit = typeof Unit.Type

export const PackageReference = Schema.Struct({
  type: Schema.Literal("context-package"),
  version: Schema.NonEmptyString,
  digest: Schema.NonEmptyString,
})
export type PackageReference = typeof PackageReference.Type

export const AUTHORITIES: Readonly<Record<Authority, { readonly owner: string; readonly isSourceOfTruth: boolean }>> = {
  "event-run": { owner: "Event/Run", isSourceOfTruth: true },
  "context-package": { owner: "Context Package", isSourceOfTruth: false },
  "governed-memory": { owner: "Memory OS", isSourceOfTruth: true },
  derived: { owner: "summary/compaction", isSourceOfTruth: false },
  "runtime-input": { owner: "instruction/request/tool input", isSourceOfTruth: false },
}

export function authorityForOrigin(origin: Origin): Authority {
  switch (origin) {
    case "event":
    case "run":
      return "event-run"
    case "memory":
      return "governed-memory"
    case "summary":
    case "compaction":
      return "derived"
    case "instruction":
    case "request":
    case "interaction":
    case "tool":
      return "runtime-input"
  }
  throw new Error("Unknown Context origin")
}

export function trustForOrigin(origin: Origin): Trust {
  switch (origin) {
    case "event":
    case "run":
      return "verified"
    case "memory":
      return "untrusted-memory"
    case "summary":
    case "compaction":
      return "derived"
    case "tool":
      return "untrusted-tool"
    case "instruction":
    case "request":
    case "interaction":
      return "trusted"
  }
  throw new Error("Unknown Context origin")
}

export function contextLayerForLegacy(layer: string): ContextLayer {
  switch (layer) {
    case "L0":
    case "L1":
    case "L3":
      return "authority"
    case "L2":
      return "protected_checkpoint"
    case "L4":
      return "cognitive_state"
    case "L5":
      return "recalled_memory"
    case "L6":
      return "recent_history"
    case "L7":
      return "optional_context"
    default:
      return "optional_context"
  }
}

export function originForLegacy(layer: string, name: string): Origin {
  const value = `${layer}:${name}`.toLowerCase()
  if (value.includes("memory")) return "memory"
  if (value.includes("summary")) return "summary"
  if (value.includes("compact")) return "compaction"
  if (value.includes("tool")) return "tool"
  if (value.includes("request")) return "request"
  if (value.includes("history") || value.includes("interaction")) return "interaction"
  if (value.includes("event")) return "event"
  if (value.includes("run")) return "run"
  return "instruction"
}

export function isSourceOfTruth(authority: Authority): boolean {
  return AUTHORITIES[authority].isSourceOfTruth
}
