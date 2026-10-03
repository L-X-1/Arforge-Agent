export * as ContextRecovery from "./context-recovery"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { ContextContract } from "./context-contract"
import * as ContextPackage from "./context-package"
import * as Evidence from "./evidence"

export type DurableState = {
  readonly sessionID: string
  readonly runID?: string
  readonly checkpointID?: string
  readonly units: ReadonlyArray<ContextContract.Unit>
}

export type RecoveryInput = {
  readonly durable: DurableState
  readonly modelID: string
  readonly modelProfileRevision: string
  readonly tokenizer?: {
    readonly revision: string
    readonly kind?: "provider" | "upper-bound"
    readonly count: (input: string) => number
  }
  readonly usableInputTokens: number
  readonly protectedFacts?: ReadonlyArray<string>
  readonly requiredEvidenceIDs?: ReadonlyArray<string>
  readonly evidence?: Evidence.Interface
  readonly missingEvidence: "degrade" | "block"
}

export class RecoveryError extends Error {
  readonly _tag = "Context.RecoveryError"
  readonly reason: "invalid" | "missing-evidence"
  readonly missingEvidenceIDs: ReadonlyArray<string>
  constructor(reason: RecoveryError["reason"], message: string, missingEvidenceIDs: ReadonlyArray<string> = []) {
    super(message)
    this.reason = reason
    this.missingEvidenceIDs = Object.freeze([...missingEvidenceIDs])
  }
}

export interface Result {
  readonly status: "recompiled" | "degraded"
  readonly package: ContextPackage.Package
  readonly recompiledFrom: {
    readonly sessionID: string
    readonly runID?: string
    readonly checkpointID?: string
  }
  readonly compilerVersion: string
  readonly modelID: string
  readonly modelProfileRevision: string
  readonly tokenizerRevision?: string
  readonly tokenizerMethod: "provider-tokenizer" | "upper-bound" | "estimator"
  readonly missingEvidenceIDs: ReadonlyArray<string>
}

const requiredString = (value: string, name: string): string => {
  if (!value.trim()) throw new RecoveryError("invalid", `${name} is required`)
  return value
}

const evidenceExists = (service: Evidence.Interface | undefined, id: string): boolean => {
  if (service === undefined) return false
  try {
    return service.get(Schema.decodeUnknownSync(AgentRuntime.EvidenceID)(id)) !== undefined
  } catch {
    return false
  }
}

const missingFor = (input: RecoveryInput): ReadonlyArray<string> => {
  const references = new Set([
    ...(input.requiredEvidenceIDs ?? []),
    ...input.durable.units.flatMap((unit) => (unit.evidenceID === undefined ? [] : [unit.evidenceID])),
  ])
  return Object.freeze([...references].filter((id) => !evidenceExists(input.evidence, id)).toSorted())
}

const downgrade = (unit: ContextContract.Unit, missing: ReadonlySet<string>): ContextContract.Unit => {
  if (unit.evidenceID === undefined || !missing.has(unit.evidenceID)) return unit
  return {
    ...unit,
    origin: "summary",
    authority: "derived",
    contextLayer: "derived_summary",
    trust: "derived",
    instructionAllowed: false,
    mandatory: false,
    evidenceID: undefined,
    sourceDigest: undefined,
    protectedFacts: undefined,
  }
}

/** Rebuilds a new package from durable state; it deliberately accepts no old prompt/package bytes. */
export function recompile(input: RecoveryInput): Result {
  const sessionID = requiredString(input.durable.sessionID, "sessionID")
  const modelID = requiredString(input.modelID, "modelID")
  const modelProfileRevision = requiredString(input.modelProfileRevision, "modelProfileRevision")
  if (input.durable.units.length === 0) throw new RecoveryError("invalid", "durable state has no context units")
  const missingEvidenceIDs = missingFor(input)
  if (missingEvidenceIDs.length > 0 && input.missingEvidence === "block")
    throw new RecoveryError("missing-evidence", "durable context references missing evidence", missingEvidenceIDs)
  const missing = new Set(missingEvidenceIDs)
  const units = input.durable.units.map((unit) => (missing.size === 0 ? unit : downgrade(unit, missing)))
  const value = ContextPackage.compile({
    model: modelID,
    modelProfileRevision,
    tokenizer: input.tokenizer,
    usableInputTokens: input.usableInputTokens,
    units,
    protectedFacts: input.protectedFacts,
  })
  return Object.freeze({
    status: missingEvidenceIDs.length === 0 ? "recompiled" : "degraded",
    package: value,
    recompiledFrom: Object.freeze({
      sessionID,
      ...(input.durable.runID === undefined ? {} : { runID: input.durable.runID }),
      ...(input.durable.checkpointID === undefined ? {} : { checkpointID: input.durable.checkpointID }),
    }),
    compilerVersion: value.compilerVersion,
    modelID,
    modelProfileRevision,
    ...(value.tokenizerRevision === undefined ? {} : { tokenizerRevision: value.tokenizerRevision }),
    tokenizerMethod: value.tokenizerMethod ?? "estimator",
    missingEvidenceIDs,
  })
}
