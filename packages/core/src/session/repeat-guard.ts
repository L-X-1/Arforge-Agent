import { canonicalHash } from "../util/canonical-hash"

/**
 * Bounds a model's exact tool-call loop without attempting semantic
 * equivalence. The identity is deliberately only the tool name plus the
 * canonicalized input; no raw input is retained in the guard or its decision.
 */
export const DEFAULT_MAX_REPEATS = 3
export const MAX_MAX_REPEATS = 32

export type Observation = {
  readonly name: string
  readonly input: unknown
}

export type Decision =
  | {
      readonly kind: "allow"
      readonly name: string
      readonly digest: string
      readonly repeatCount: number
      readonly maxRepeats: number
    }
  | {
      readonly kind: "blocked"
      readonly reason: "repeat-limit" | "previous-failure"
      readonly name: string
      readonly digest: string
      readonly repeatCount: number
      readonly maxRepeats: number
      readonly message: string
    }
  | {
      readonly kind: "unhashable"
      readonly name: string
    }

export interface Interface {
  readonly observe: (input: Observation) => Decision
  /** Consume completed results in semantic order, before the next provider turn. */
  readonly recordOutcome: (input: Observation, failed: boolean) => void
  readonly reset: () => void
}

const blockedMessage = (decision: {
  readonly name: string
  readonly digest: string
  readonly repeatCount: number
  readonly maxRepeats: number
}) =>
  `Repeat guard blocked ${decision.name}: the exact canonical tool call repeated more than ${decision.maxRepeats} times ` +
  `(repeatCount=${decision.repeatCount}, inputDigest=${decision.digest}). Change the tool input or choose a different action.`

export const make = (maxRepeats = DEFAULT_MAX_REPEATS): Interface => {
  if (!Number.isInteger(maxRepeats) || maxRepeats < 1 || maxRepeats > MAX_MAX_REPEATS)
    throw new RangeError(`maxRepeats must be an integer between 1 and ${MAX_MAX_REPEATS}`)

  let previousDigest: string | undefined
  let previousName: string | undefined
  let repeatCount = 0
  let previousFailed = false

  const reset = () => {
    previousDigest = undefined
    previousName = undefined
    repeatCount = 0
    previousFailed = false
  }

  const observe = (input: Observation): Decision => {
    const digest = canonicalHash({ name: input.name, input: input.input })
    // Do not hash a lossy representation. An unhashable call is allowed to
    // proceed through the normal ActionGateway validation path and breaks the
    // current exact-repeat streak conservatively.
    if (digest === undefined) {
      reset()
      return { kind: "unhashable", name: input.name }
    }

    if (digest === previousDigest && input.name === previousName) {
      repeatCount = Math.min(maxRepeats + 1, repeatCount + 1)
    } else {
      previousDigest = digest
      previousName = input.name
      repeatCount = 1
      previousFailed = false
    }

    const decision = {
      name: input.name,
      digest,
      repeatCount,
      maxRepeats,
    }
    if (previousFailed || repeatCount > maxRepeats)
      return {
        kind: "blocked",
        reason: previousFailed ? "previous-failure" : "repeat-limit",
        ...decision,
        message: previousFailed
          ? `Repeat guard blocked ${input.name}: the previous execution failed for this exact canonical input ` +
            `(inputDigest=${digest}). Inspect the failure and change the input or choose a different action; do not repeat it unchanged.`
          : blockedMessage(decision),
      }
    return { kind: "allow", ...decision }
  }

  const recordOutcome = (input: Observation, failed: boolean) => {
    if (previousName !== input.name || previousDigest === undefined) return
    if (canonicalHash({ name: input.name, input: input.input }) === previousDigest) previousFailed = failed
  }

  return { observe, recordOutcome, reset }
}
