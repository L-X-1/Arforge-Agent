const DIGEST = /^[0-9a-f]{64}$/

export const VERSION = 1 as const
export const KIND = "session-agent-loop" as const
export const MATURE_KIND = "mature-session-loop" as const

export type Promotion = "steer" | "queue"

export type TurnBinding = {
  readonly turnStep: number
  readonly requestDigest: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  readonly compilerRevision: string
}

/** Metadata only. Dispatching means send may have begun, never proof of delivery or zero usage. */
export type RequestDispatch = {
  readonly version: 1
  readonly requestEventID: string
  readonly requestDigest: string
  readonly turnStep: number
  readonly attempt: number
  readonly providerAttempt: number
  readonly phase: "prepared" | "dispatching"
}

export type State = {
  readonly version: typeof VERSION
  readonly kind: typeof KIND
  readonly sessionID: string
  readonly phase: "continuation" | "idle"
  readonly nextStep: number
  readonly nextPromotion?: Promotion
  readonly needsContinuation: boolean
  readonly lastTurn: TurnBinding
  readonly dispatch?: RequestDispatch
  readonly legacy: false
}

/** Versioned cursor written by the mature compatibility loop. */
export type MatureState = {
  readonly version: typeof VERSION
  readonly kind: typeof MATURE_KIND
  readonly sessionID: string
  readonly phase: "mature-session-loop"
  readonly nextStep: number
  readonly nextPromotion?: Promotion
  readonly needsContinuation: boolean
  readonly admittedThroughSequence: number
  readonly legacy: false
}

export type LegacyState = {
  readonly version: 0
  readonly sessionID: string
  readonly nextStep: number
  readonly nextPromotion?: Promotion
  readonly needsContinuation: boolean
  readonly lastTurn?: undefined
  readonly legacy: true
}

export type Decoded = State | MatureState | LegacyState

export class CheckpointError extends globalThis.Error {
  readonly _tag = "SessionCheckpoint.Error"
}

/** Recovery must retain the original cursor until its request can be safely resumed. */
export class RecoveryRequiredError extends globalThis.Error {
  readonly _tag = "SessionCheckpoint.RecoveryRequired"
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The provider cursor and the Core loop share one DurableRun checkpoint. */
export const fromContainer = (state: Readonly<Record<string, unknown>>, sessionID: string): Decoded | undefined => {
  if (state.phase !== "subagent-provider") return decode(state, sessionID)
  if (state.sessionLoop === undefined) return undefined
  if (!isRecord(state.sessionLoop)) throw new CheckpointError("Nested session checkpoint must be an object")
  return decode(state.sessionLoop, sessionID)
}

export const intoContainer = (
  previous: Readonly<Record<string, unknown>> | undefined,
  state: Readonly<Record<string, unknown>>,
  sessionID: string,
): Readonly<Record<string, unknown>> => {
  decode(state, sessionID)
  if (previous?.phase !== "subagent-provider") return state
  // Validate any existing loop before replacing its cursor. Never discard a
  // corrupt/foreign nested state just because the next turn finished.
  fromContainer(previous, sessionID)
  return { ...previous, sessionLoop: state }
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/**
 * Resolve the resumable provider cursor after an interruption. A request with
 * no durable provider output retains its step; this is not permission to
 * resend. The request dispatch boundary must be reconciled separately. Once
 * provider output is durable, continuation advances past the observed turn.
 */
export const nextStepAfterInterruption = (input: {
  readonly turnStep: number
  readonly providerOutputObserved: boolean
}): number => {
  if (!isPositiveInt(input.turnStep))
    throw new CheckpointError("Interrupted session checkpoint turnStep must be a positive integer")
  if (typeof input.providerOutputObserved !== "boolean")
    throw new CheckpointError("Interrupted session checkpoint provider output flag is invalid")
  const nextStep = input.providerOutputObserved ? input.turnStep + 1 : input.turnStep
  if (!isPositiveInt(nextStep))
    throw new CheckpointError("Interrupted session checkpoint nextStep exceeds the safe integer range")
  return nextStep
}

const isPromotion = (value: unknown): value is Promotion => value === "steer" || value === "queue"

const requiredDigest = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new CheckpointError(`Invalid ${field} in session checkpoint`)
  return value
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new CheckpointError(`Invalid ${field} in session checkpoint`)
  return value
}

const decodeRequestDispatch = (value: unknown): RequestDispatch => {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "attempt,phase,providerAttempt,requestDigest,requestEventID,turnStep,version" ||
    value.version !== 1 ||
    typeof value.requestEventID !== "string" ||
    !/^evt_.+/.test(value.requestEventID) ||
    !isPositiveInt(value.turnStep) ||
    !isPositiveInt(value.attempt) ||
    !isPositiveInt(value.providerAttempt) ||
    (value.phase !== "prepared" && value.phase !== "dispatching")
  )
    throw new CheckpointError("Invalid request dispatch metadata in session checkpoint")
  return {
    version: 1,
    requestEventID: value.requestEventID,
    requestDigest: requiredDigest(value.requestDigest, "dispatch.requestDigest"),
    turnStep: value.turnStep,
    attempt: value.attempt,
    providerAttempt: value.providerAttempt,
    phase: value.phase,
  }
}

/** Pure updater for the original DurableRun checkpoint, including child containers. */
export const withRequestDispatch = (
  previous: Readonly<Record<string, unknown>> | undefined,
  input: { readonly sessionID: string; readonly turn: TurnBinding; readonly dispatch: RequestDispatch },
): Readonly<Record<string, unknown>> => {
  const dispatch = decodeRequestDispatch(input.dispatch)
  if (dispatch.turnStep !== input.turn.turnStep || dispatch.requestDigest !== input.turn.requestDigest)
    throw new CheckpointError("Request dispatch does not match its turn binding")
  const existing = previous === undefined ? undefined : fromContainer(previous, input.sessionID)
  const current = existing && !existing.legacy && existing.kind === KIND ? existing : undefined
  const cursor =
    current ??
    make({
      sessionID: input.sessionID,
      nextStep: input.turn.turnStep,
      needsContinuation: true,
      lastTurn: input.turn,
    })
  const prior = current?.dispatch
  if (
    prior?.requestEventID === dispatch.requestEventID &&
    (prior.requestDigest !== dispatch.requestDigest ||
      prior.turnStep !== dispatch.turnStep ||
      (prior.attempt !== dispatch.attempt &&
        !(prior.phase === "prepared" && dispatch.phase === "prepared" && dispatch.attempt > prior.attempt)))
  )
    throw new CheckpointError("Request dispatch event identity cannot change")
  if (
    prior?.requestEventID === dispatch.requestEventID &&
    prior.attempt === dispatch.attempt &&
    (dispatch.providerAttempt < prior.providerAttempt ||
      (dispatch.providerAttempt === prior.providerAttempt &&
        prior.phase === "dispatching" &&
        dispatch.phase === "prepared"))
  )
    throw new CheckpointError("Request dispatch phase cannot regress within an attempt")
  return intoContainer(previous, { ...cursor, dispatch }, input.sessionID)
}

export const make = (input: {
  readonly sessionID: string
  readonly nextStep: number
  readonly nextPromotion?: Promotion
  readonly needsContinuation: boolean
  readonly lastTurn: TurnBinding
}): Readonly<Record<string, unknown>> => {
  if (typeof input.sessionID !== "string" || input.sessionID.length === 0)
    throw new CheckpointError("Session checkpoint requires a session ID")
  if (!isPositiveInt(input.nextStep))
    throw new CheckpointError("Session checkpoint nextStep must be a positive integer")
  if (input.nextPromotion !== undefined && !isPromotion(input.nextPromotion))
    throw new CheckpointError("Session checkpoint promotion is invalid")
  if (!isRecord(input.lastTurn) || !isPositiveInt(input.lastTurn.turnStep))
    throw new CheckpointError("Session checkpoint turnStep must be a positive integer")
  const state: State = {
    version: VERSION,
    kind: KIND,
    sessionID: input.sessionID,
    phase: input.needsContinuation ? "continuation" : "idle",
    nextStep: input.nextStep,
    ...(input.nextPromotion === undefined ? {} : { nextPromotion: input.nextPromotion }),
    needsContinuation: input.needsContinuation,
    lastTurn: {
      turnStep: input.lastTurn.turnStep,
      requestDigest: requiredDigest(input.lastTurn.requestDigest, "lastTurn.requestDigest"),
      contextDigest: requiredDigest(input.lastTurn.contextDigest, "lastTurn.contextDigest"),
      toolSetRevision: requiredDigest(input.lastTurn.toolSetRevision, "lastTurn.toolSetRevision"),
      routeConfigRevision: requiredDigest(input.lastTurn.routeConfigRevision, "lastTurn.routeConfigRevision"),
      compilerRevision: requiredString(input.lastTurn.compilerRevision, "lastTurn.compilerRevision"),
    },
    legacy: false,
  }
  return state
}

export const makeMature = (input: {
  readonly sessionID: string
  readonly nextStep: number
  readonly nextPromotion?: Promotion
  readonly needsContinuation: boolean
  readonly admittedThroughSequence: number
}): Readonly<Record<string, unknown>> => {
  if (typeof input.sessionID !== "string" || input.sessionID.length === 0)
    throw new CheckpointError("Mature session checkpoint requires a session ID")
  if (!isPositiveInt(input.nextStep))
    throw new CheckpointError("Mature session checkpoint nextStep must be a positive integer")
  if (typeof input.needsContinuation !== "boolean")
    throw new CheckpointError("Mature session checkpoint continuation flag is invalid")
  if (!Number.isSafeInteger(input.admittedThroughSequence) || input.admittedThroughSequence < 0)
    throw new CheckpointError("Mature session checkpoint admission sequence must be a non-negative integer")
  return {
    version: VERSION,
    kind: MATURE_KIND,
    sessionID: input.sessionID,
    phase: MATURE_KIND,
    nextStep: input.nextStep,
    ...(input.nextPromotion === undefined ? {} : { nextPromotion: input.nextPromotion }),
    needsContinuation: input.needsContinuation,
    admittedThroughSequence: input.admittedThroughSequence,
    legacy: false,
  } satisfies MatureState
}

const decodeMature = (value: Record<string, unknown>, sessionID: string): MatureState => {
  if (
    value.version !== VERSION ||
    value.kind !== MATURE_KIND ||
    value.sessionID !== sessionID ||
    value.phase !== MATURE_KIND ||
    value.legacy !== false ||
    !isPositiveInt(value.nextStep) ||
    (value.nextPromotion !== undefined && !isPromotion(value.nextPromotion)) ||
    typeof value.needsContinuation !== "boolean" ||
    !isNonNegativeInt(value.admittedThroughSequence) ||
    value.admittedThroughSequence < 0
  )
    throw new CheckpointError("Mature session checkpoint identity or cursor is invalid")
  return {
    version: VERSION,
    kind: MATURE_KIND,
    sessionID,
    phase: MATURE_KIND,
    nextStep: value.nextStep,
    ...(value.nextPromotion === undefined ? {} : { nextPromotion: value.nextPromotion }),
    needsContinuation: value.needsContinuation,
    admittedThroughSequence: value.admittedThroughSequence,
    legacy: false,
  }
}

/**
 * Decode one Session runner checkpoint. The old unversioned state remains
 * readable for existing runs, while a versioned state is strict and fails
 * closed instead of silently restarting at an arbitrary step.
 */
export const decode = (value: Readonly<Record<string, unknown>>, sessionID: string): Decoded => {
  if (!isRecord(value)) throw new CheckpointError("Session checkpoint state must be an object")
  if (value.dispatch !== undefined && (value.version !== VERSION || value.kind !== KIND))
    throw new CheckpointError("Request dispatch requires a versioned Core session checkpoint")
  if (value.kind === MATURE_KIND) return decodeMature(value, sessionID)
  if (value.version === undefined) {
    if (value.sessionID !== sessionID || !isPositiveInt(value.nextStep) || typeof value.needsContinuation !== "boolean")
      throw new CheckpointError("Legacy session checkpoint identity or cursor is invalid")
    if (value.nextPromotion !== undefined && !isPromotion(value.nextPromotion))
      throw new CheckpointError("Legacy session checkpoint promotion is invalid")
    return {
      version: 0,
      sessionID,
      nextStep: value.nextStep,
      ...(value.nextPromotion === undefined ? {} : { nextPromotion: value.nextPromotion }),
      needsContinuation: value.needsContinuation,
      lastTurn: undefined,
      legacy: true,
    }
  }
  if (value.version !== VERSION || value.kind !== KIND)
    throw new CheckpointError("Unsupported session checkpoint version or kind")
  if (value.sessionID !== sessionID || !isPositiveInt(value.nextStep) || typeof value.needsContinuation !== "boolean")
    throw new CheckpointError("Session checkpoint identity or cursor is invalid")
  if (value.nextPromotion !== undefined && !isPromotion(value.nextPromotion))
    throw new CheckpointError("Session checkpoint promotion is invalid")
  if (value.legacy !== false) throw new CheckpointError("Session checkpoint legacy marker is invalid")
  const expectedPhase = value.needsContinuation ? "continuation" : "idle"
  if (value.phase !== expectedPhase)
    throw new CheckpointError("Session checkpoint phase does not match continuation state")
  if (!isRecord(value.lastTurn)) throw new CheckpointError("Session checkpoint is missing the last turn binding")
  const lastTurn: TurnBinding = {
    turnStep: value.lastTurn.turnStep as number,
    requestDigest: requiredDigest(value.lastTurn.requestDigest, "lastTurn.requestDigest"),
    contextDigest: requiredDigest(value.lastTurn.contextDigest, "lastTurn.contextDigest"),
    toolSetRevision: requiredDigest(value.lastTurn.toolSetRevision, "lastTurn.toolSetRevision"),
    routeConfigRevision: requiredDigest(value.lastTurn.routeConfigRevision, "lastTurn.routeConfigRevision"),
    compilerRevision: requiredString(value.lastTurn.compilerRevision, "lastTurn.compilerRevision"),
  }
  if (!isPositiveInt(lastTurn.turnStep)) throw new CheckpointError("Session checkpoint turnStep is invalid")
  return {
    version: VERSION,
    kind: KIND,
    sessionID,
    phase: expectedPhase,
    nextStep: value.nextStep,
    ...(value.nextPromotion === undefined ? {} : { nextPromotion: value.nextPromotion as Promotion }),
    needsContinuation: value.needsContinuation,
    lastTurn,
    ...(value.dispatch === undefined ? {} : { dispatch: decodeRequestDispatch(value.dispatch) }),
    legacy: false,
  }
}
