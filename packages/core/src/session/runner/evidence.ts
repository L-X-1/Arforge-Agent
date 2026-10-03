import type { Budget } from "@arforge-ai/schema/agent-runtime"
import * as SessionCheckpoint from "../checkpoint"
import { parseRequestEnvelopeJson, type RequestEnvelope } from "../request-envelope"
import {
  makeExecutionEvidence,
  compareRequestProjection as compareParityRequestProjection,
  type ExecutionEvidence,
  type BudgetEvidence,
  type RequestProjection,
} from "./parity-matrix"

export type { RequestProjection } from "./parity-matrix"
export type { ExecutionEvidence } from "./parity-matrix"

/**
 * The only durable inputs needed to build switch evidence.  The checkpoint
 * must already have passed SessionCheckpoint.decode; raw checkpoint JSON is
 * intentionally not accepted here.
 */
export type DurableEvidenceInput = Readonly<{
  readonly checkpoint: SessionCheckpoint.Decoded | undefined
  readonly budget: Budget
}>

/**
 * Metadata-only request binding emitted by the mature provider adapter.  This
 * is intentionally a transport projection rather than a second request
 * envelope: it carries the owner/attempt identity and digests, never prompt,
 * tool arguments, headers, credentials, or provider output.
 */
export type MatureRequestBinding = Readonly<{
  readonly schemaVersion: 1
  readonly runID: string
  readonly turnStep: number
  readonly attempt: number
  /** `mature` is the in-memory owner marker; durable events use transport. */
  readonly runtime: "mature" | "native" | "ai-sdk"
  readonly mode: "native-envelope" | "prepared-projection"
  readonly requestDigest: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  readonly skillSnapshotDigest?: string
  readonly compilerRevision: string
}>

export type MatureDurableEvidence = Readonly<{
  readonly execution: ExecutionEvidence
  readonly binding: MatureRequestBinding
}>

export type FormalRequestEvent = Readonly<{
  readonly envelope: string
  readonly requestDigest: string
}>

export type FormalDurableEvidence = Readonly<{
  readonly execution: ExecutionEvidence
  readonly request: RequestProjection
}>

export class EvidenceProjectionError extends Error {
  readonly _tag = "SessionRunner.EvidenceProjectionError" as const
}

const budgetEvidence = (budget: Budget): BudgetEvidence => ({
  attemptsUsed: budget.attemptsUsed,
  maxAttempts: budget.maxAttempts,
  durationMsUsed: budget.durationMsUsed,
  maxDurationMs: budget.maxDurationMs,
  costMicrosUsed: budget.costMicrosUsed,
  maxCostMicros: budget.maxCostMicros,
  tokensUsed: budget.tokensUsed,
  maxTokens: budget.maxTokens,
})

/**
 * Project one durable run snapshot into metadata-only parity evidence.
 * Legacy and missing cursors cannot prove semantic checkpoint parity, so the
 * projection fails closed rather than inventing an idle cursor.
 */
export const fromDurable = (input: DurableEvidenceInput): ExecutionEvidence => {
  const checkpoint = input.checkpoint
  if (!checkpoint || checkpoint.legacy)
    throw new EvidenceProjectionError("A versioned semantic checkpoint is required for parity evidence")

  return makeExecutionEvidence({
    checkpoint: {
      phase: checkpoint.phase,
      nextStep: checkpoint.nextStep,
      needsContinuation: checkpoint.needsContinuation,
    },
    budget: budgetEvidence(input.budget),
  })
}

const digest = /^[0-9a-f]{64}$/
const boundedBindingIdentifier = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256)
    throw new EvidenceProjectionError(`Mature request binding ${field} is not a bounded identifier`)
}

const positiveBindingNumber = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new EvidenceProjectionError(`Mature request binding ${field} must be a positive safe integer`)
}

const bindingDigests = ["requestDigest", "contextDigest", "toolSetRevision", "routeConfigRevision"] as const

const validateMatureBinding = (binding: MatureRequestBinding) => {
  if (binding.schemaVersion !== 1) throw new EvidenceProjectionError("Mature request binding schema version is invalid")
  boundedBindingIdentifier(binding.runID, "runID")
  positiveBindingNumber(binding.turnStep, "turnStep")
  positiveBindingNumber(binding.attempt, "attempt")
  if (binding.runtime !== "mature" && binding.runtime !== "native" && binding.runtime !== "ai-sdk")
    throw new EvidenceProjectionError("Mature request binding runtime is invalid")
  if (binding.mode !== "native-envelope" && binding.mode !== "prepared-projection")
    throw new EvidenceProjectionError("Mature request binding mode is invalid")
  for (const field of bindingDigests) {
    if (typeof binding[field] !== "string" || !digest.test(binding[field]))
      throw new EvidenceProjectionError(`Mature request binding ${field} must be a SHA-256 digest`)
  }
  if (binding.skillSnapshotDigest !== undefined && !digest.test(binding.skillSnapshotDigest))
    throw new EvidenceProjectionError("Mature request binding skillSnapshotDigest must be a SHA-256 digest")
  if (
    typeof binding.compilerRevision !== "string" ||
    binding.compilerRevision.length === 0 ||
    binding.compilerRevision.length > 128
  )
    throw new EvidenceProjectionError("Mature request binding compiler revision is invalid")
  return binding
}

const projection = (input: {
  readonly runID: unknown
  readonly turnStep: unknown
  readonly attempt: unknown
  readonly requestDigest: unknown
  readonly contextDigest: unknown
  readonly toolSetRevision: unknown
  readonly routeConfigRevision: unknown
  readonly skillSnapshotDigest?: unknown
  readonly compilerRevision: unknown
}): RequestProjection => {
  boundedBindingIdentifier(input.runID, "runID")
  positiveBindingNumber(input.turnStep, "turnStep")
  positiveBindingNumber(input.attempt, "attempt")
  for (const field of bindingDigests) {
    if (typeof input[field] !== "string" || !digest.test(input[field]))
      throw new EvidenceProjectionError(`Request projection ${field} must be a SHA-256 digest`)
  }
  if (input.skillSnapshotDigest !== undefined) {
    if (typeof input.skillSnapshotDigest !== "string" || !digest.test(input.skillSnapshotDigest))
      throw new EvidenceProjectionError("Request projection skillSnapshotDigest must be a SHA-256 digest")
  }
  if (
    typeof input.compilerRevision !== "string" ||
    input.compilerRevision.length === 0 ||
    input.compilerRevision.length > 128
  )
    throw new EvidenceProjectionError("Request projection compiler revision is invalid")
  return Object.freeze({
    schemaVersion: 1,
    runID: input.runID as string,
    turnStep: input.turnStep as number,
    attempt: input.attempt as number,
    requestDigest: input.requestDigest as string,
    contextDigest: input.contextDigest as string,
    toolSetRevision: input.toolSetRevision as string,
    routeConfigRevision: input.routeConfigRevision as string,
    ...(input.skillSnapshotDigest === undefined ? {} : { skillSnapshotDigest: input.skillSnapshotDigest as string }),
    compilerRevision: input.compilerRevision as string,
  })
}

/**
 * Project a strict formal RequestEnvelope into the same metadata shape as a
 * mature binding. Older envelopes without an attempt or context revisions are
 * intentionally rejected by this switch-gate helper.
 */
export const fromFormalEnvelope = (envelope: RequestEnvelope, expectedRunID?: string): RequestProjection => {
  if (envelope.schema_version !== "1.0")
    throw new EvidenceProjectionError("Formal request projection schema version is invalid")
  if (expectedRunID !== undefined && envelope.execution.run_id !== expectedRunID)
    throw new EvidenceProjectionError("Formal request projection runID does not match the expected run")
  return projection({
    runID: envelope.execution.run_id,
    turnStep: envelope.execution.turn_step,
    attempt: envelope.execution.attempt,
    requestDigest: envelope.request_digest,
    contextDigest: envelope.execution.context_digest,
    toolSetRevision: envelope.execution.tool_set_revision,
    routeConfigRevision: envelope.execution.route_config_revision,
    skillSnapshotDigest: envelope.execution.skill_snapshot_digest,
    compilerRevision: envelope.execution.compiler_revision,
  })
}

/**
 * Project the persisted formal event boundary after checking that its outer
 * digest agrees with the canonical envelope. Callers must not bypass this
 * check by trusting the event metadata alone; a truncated or tampered event
 * cannot become switch evidence.
 */
export const fromFormalEvent = (event: FormalRequestEvent, expectedRunID?: string): RequestProjection => {
  let envelope: RequestEnvelope
  try {
    envelope = parseRequestEnvelopeJson(event.envelope)
  } catch (error) {
    throw new EvidenceProjectionError(
      `Formal request event envelope is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (envelope.request_digest !== event.requestDigest)
    throw new EvidenceProjectionError("Formal request event digest does not match the persisted envelope")
  return fromFormalEnvelope(envelope, expectedRunID)
}

/**
 * Compose a formal request event with the same semantic cursor and bounded
 * budget checks used by the mature path. A request from a later attempt or a
 * turn beyond the recovered cursor is stale evidence and fails closed.
 */
export const fromFormalDurable = (
  input: DurableEvidenceInput & {
    readonly event: FormalRequestEvent
    readonly runID?: string
  },
): FormalDurableEvidence => {
  const execution = fromDurable(input)
  const request = fromFormalEvent(input.event, input.runID)
  if (request.attempt > input.budget.attemptsUsed)
    throw new EvidenceProjectionError("Formal request event attempt is not admitted by the durable budget")
  if (execution.checkpoint.nextStep !== undefined && request.turnStep > execution.checkpoint.nextStep)
    throw new EvidenceProjectionError("Formal request event turnStep is ahead of the semantic checkpoint")
  return Object.freeze({ execution, request })
}

/** Project a mature binding without exposing transport-specific fields. */
export const fromMatureBinding = (binding: MatureRequestBinding, expectedRunID?: string): RequestProjection => {
  const valid = validateMatureBinding(binding)
  if (expectedRunID !== undefined && valid.runID !== expectedRunID)
    throw new EvidenceProjectionError("Mature request projection runID does not match the expected run")
  return projection(valid)
}

/** Return stable metadata field names that differ between two adapters. */
export const compareRequestProjection = compareParityRequestProjection

/**
 * Compose a mature request binding with the already validated semantic cursor
 * and bounded budget.  The checks prevent a stale event from being mistaken
 * for evidence belonging to another run or a later attempt.  No request body
 * is accepted by this API, so it cannot accidentally become durable evidence.
 */
export const fromMatureDurable = (
  input: DurableEvidenceInput & {
    readonly binding: MatureRequestBinding
    readonly runID?: string
  },
): MatureDurableEvidence => {
  const execution = fromDurable(input)
  const binding = validateMatureBinding(input.binding)
  if (input.runID !== undefined && binding.runID !== input.runID)
    throw new EvidenceProjectionError("Mature request binding runID does not match the durable run")
  if (binding.attempt > input.budget.attemptsUsed)
    throw new EvidenceProjectionError("Mature request binding attempt is not admitted by the durable budget")
  if (execution.checkpoint.nextStep !== undefined && binding.turnStep > execution.checkpoint.nextStep)
    throw new EvidenceProjectionError("Mature request binding turnStep is ahead of the semantic checkpoint")
  return Object.freeze({ execution, binding: Object.freeze({ ...binding }) })
}
