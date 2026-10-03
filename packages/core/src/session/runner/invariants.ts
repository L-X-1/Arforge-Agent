import { Effect, Schema } from "effect"
import * as RuntimeInvariants from "../../runtime/invariants"
import * as SessionCheckpoint from "../checkpoint"
import { requestProjectionErrors, type RequestProjection } from "./parity-matrix"

/** The runtime invariant owner shared by every Session execution adapter. */
export const OWNER = "session-runner" as const

const MAX_IDENTIFIER_BYTES = 256

const boundedIdentifier = (value: unknown, label: string): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES)
    return `${label} must be a non-empty bounded identifier`
  return undefined
}

export type ExecutionInputContext = Readonly<{
  readonly kind: "execution-input"
  readonly sessionID: string
  readonly force: boolean
  readonly maxTransportRetries: number
}>

export type CheckpointCursorContext = Readonly<{
  readonly kind: "checkpoint-cursor"
  readonly sessionID: string
  readonly runID: string
  readonly checkpoint: SessionCheckpoint.Decoded | undefined
  readonly restoringContinuation: boolean
}>

/**
 * The mature compatibility loop uses the same owner with a deliberately
 * smaller versioned cursor: it records admission progress and continuation
 * state without pretending to have a formal request binding.
 */
export type MatureCheckpointContext = Readonly<{
  readonly kind: "mature-checkpoint"
  readonly sessionID: string
  readonly runID: string
  readonly phase: "mature-session-loop"
  readonly nextStep: number
  readonly needsContinuation: boolean
  readonly admittedThroughSequence: number
}>

/**
 * Request metadata is checked at the provider boundary as well as in the
 * parity matrix. `runtime` names the execution owner, not the transport
 * implementation (native/AI SDK), so both loops share one contract.
 */
export type RequestProjectionContext = Readonly<{
  readonly kind: "request-projection"
  readonly sessionID: string
  readonly runtime: "formal" | "mature"
  readonly projection: RequestProjection
}>

export type TerminalContext = Readonly<{
  readonly kind: "terminal"
  readonly sessionID: string
  readonly runID: string
  readonly status: "completed" | "paused" | "failed"
  readonly leaseMatches: boolean
  readonly attempt: number
}>

export type Context =
  | ExecutionInputContext
  | CheckpointCursorContext
  | MatureCheckpointContext
  | RequestProjectionContext
  | TerminalContext

export class InvariantError extends Schema.TaggedErrorClass<InvariantError>()("SessionRunner.InvariantError", {
  phase: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Session runner runtime invariant failed during ${this.phase}: ${this.reason}`
  }
}

const contextRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateExecutionInput = (value: unknown): string | undefined => {
  if (!contextRecord(value) || value.kind !== "execution-input") return "execution-input context is invalid"
  const context = value as Partial<ExecutionInputContext>
  return (
    boundedIdentifier(context.sessionID, "sessionID") ??
    (typeof context.force !== "boolean" ? "force must be boolean" : undefined) ??
    (typeof context.maxTransportRetries !== "number" ||
    !Number.isSafeInteger(context.maxTransportRetries) ||
    context.maxTransportRetries < 0 ||
    context.maxTransportRetries > 3
      ? "maxTransportRetries must be an integer from 0 to 3"
      : undefined)
  )
}

const validateCheckpointCursor = (value: unknown): string | undefined => {
  if (!contextRecord(value) || value.kind !== "checkpoint-cursor") return "checkpoint-cursor context is invalid"
  const context = value as Partial<CheckpointCursorContext>
  const identityError = boundedIdentifier(context.sessionID, "sessionID") ?? boundedIdentifier(context.runID, "runID")
  if (identityError) return identityError
  if (typeof context.restoringContinuation !== "boolean") return "restoringContinuation must be boolean"
  if (context.restoringContinuation && context.checkpoint === undefined)
    return "restoring continuation requires a semantic checkpoint"
  const checkpoint = context.checkpoint
  if (checkpoint === undefined) return undefined
  if (checkpoint.sessionID !== context.sessionID) return "checkpoint session identity drifted"
  if (!Number.isSafeInteger(checkpoint.nextStep) || checkpoint.nextStep < 1)
    return "checkpoint nextStep must be a positive safe integer"
  if (typeof checkpoint.needsContinuation !== "boolean") return "checkpoint continuation flag is invalid"
  if (
    checkpoint.nextPromotion !== undefined &&
    checkpoint.nextPromotion !== "steer" &&
    checkpoint.nextPromotion !== "queue"
  )
    return "checkpoint promotion is invalid"
  if (checkpoint.version === SessionCheckpoint.VERSION && checkpoint.legacy === false) {
    if (checkpoint.kind === SessionCheckpoint.MATURE_KIND) {
      if (
        checkpoint.phase !== "mature-session-loop" ||
        !Number.isSafeInteger(checkpoint.admittedThroughSequence) ||
        checkpoint.admittedThroughSequence < 0
      )
        return "mature checkpoint cursor is invalid"
    } else if (
      !checkpoint.lastTurn ||
      !Number.isSafeInteger(checkpoint.lastTurn.turnStep) ||
      checkpoint.lastTurn.turnStep < 1
    ) {
      return "versioned checkpoint last turn is invalid"
    }
  }
  return undefined
}

const validateMatureCheckpoint = (value: unknown): string | undefined => {
  if (!contextRecord(value) || value.kind !== "mature-checkpoint") return "mature-checkpoint context is invalid"
  const context = value as Partial<MatureCheckpointContext>
  return (
    boundedIdentifier(context.sessionID, "sessionID") ??
    boundedIdentifier(context.runID, "runID") ??
    (context.phase !== "mature-session-loop" ? "mature checkpoint phase is invalid" : undefined) ??
    (typeof context.nextStep !== "number" || !Number.isSafeInteger(context.nextStep) || context.nextStep < 1
      ? "mature checkpoint nextStep must be a positive safe integer"
      : undefined) ??
    (typeof context.needsContinuation !== "boolean" ? "mature checkpoint continuation flag is invalid" : undefined) ??
    (typeof context.admittedThroughSequence !== "number" ||
    !Number.isSafeInteger(context.admittedThroughSequence) ||
    context.admittedThroughSequence < 0
      ? "admittedThroughSequence must be a non-negative safe integer"
      : undefined)
  )
}

const validateRequestProjection = (value: unknown): string | undefined => {
  if (!contextRecord(value) || value.kind !== "request-projection") return "request-projection context is invalid"
  const context = value as Partial<RequestProjectionContext>
  const sessionError = boundedIdentifier(context.sessionID, "sessionID")
  if (sessionError) return sessionError
  if (context.runtime !== "formal" && context.runtime !== "mature") return "request projection runtime is invalid"
  const projection = context.projection
  const projectionErrors = requestProjectionErrors(projection)
  if (projectionErrors.length > 0) return "request projection " + projectionErrors[0]
  return undefined
}

const validateTerminal = (value: unknown): string | undefined => {
  if (!contextRecord(value) || value.kind !== "terminal") return "terminal context is invalid"
  const context = value as Partial<TerminalContext>
  return (
    boundedIdentifier(context.sessionID, "sessionID") ??
    boundedIdentifier(context.runID, "runID") ??
    (context.status !== "completed" && context.status !== "paused" && context.status !== "failed"
      ? "terminal status is invalid"
      : undefined) ??
    (context.leaseMatches !== true ? "terminal settlement requires the current execution lease" : undefined) ??
    (typeof context.attempt !== "number" || !Number.isSafeInteger(context.attempt) || context.attempt < 1
      ? "terminal attempt must be a positive safe integer"
      : undefined)
  )
}

const validate = (context: unknown): string | undefined => {
  if (!contextRecord(context) || typeof context.kind !== "string") return "session runner invariant context is invalid"
  switch (context.kind) {
    case "execution-input":
      return validateExecutionInput(context)
    case "checkpoint-cursor":
      return validateCheckpointCursor(context)
    case "mature-checkpoint":
      return validateMatureCheckpoint(context)
    case "request-projection":
      return validateRequestProjection(context)
    case "terminal":
      return validateTerminal(context)
    default:
      return "unknown session runner invariant phase"
  }
}

/** Register the runner's phase contracts once into the shared process registry. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (!registry.get(OWNER, "execution-input", "1"))
    registry.register({
      owner: OWNER,
      key: "execution-input",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          const error = validateExecutionInput(context)
          if (error) throw new Error(error)
        }),
    })
  if (!registry.get(OWNER, "checkpoint-cursor", "1"))
    registry.register({
      owner: OWNER,
      key: "checkpoint-cursor",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          const error = validateCheckpointCursor(context)
          if (error) throw new Error(error)
        }),
    })
  if (!registry.get(OWNER, "mature-checkpoint", "1"))
    registry.register({
      owner: OWNER,
      key: "mature-checkpoint",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          const error = validateMatureCheckpoint(context)
          if (error) throw new Error(error)
        }),
    })
  if (!registry.get(OWNER, "request-projection", "1"))
    registry.register({
      owner: OWNER,
      key: "request-projection",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          const error = validateRequestProjection(context)
          if (error) throw new Error(error)
        }),
    })
  if (!registry.get(OWNER, "terminal", "1"))
    registry.register({
      owner: OWNER,
      key: "terminal",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          const error = validateTerminal(context)
          if (error) throw new Error(error)
        }),
    })
}

const mode = (): RuntimeInvariants.InvariantMode =>
  process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"

/** Execute exactly the phase check selected by the context kind. */
export const assert = (
  registry: RuntimeInvariants.RuntimeInvariantRegistry,
  context: Context,
): Effect.Effect<void, InvariantError> =>
  registry
    .assert(context, {
      owner: OWNER,
      key:
        context.kind === "execution-input"
          ? "execution-input"
          : context.kind === "checkpoint-cursor"
            ? "checkpoint-cursor"
            : context.kind === "mature-checkpoint"
              ? "mature-checkpoint"
              : context.kind === "request-projection"
                ? "request-projection"
                : "terminal",
      mode: mode(),
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new InvariantError({
            phase: context.kind,
            reason: error instanceof RuntimeInvariants.RuntimeInvariantError ? error.message : String(error),
          }),
      ),
      Effect.asVoid,
    )

export const validateContext = (context: Context): void => {
  const error = validate(context)
  if (error) throw new Error(error)
}
