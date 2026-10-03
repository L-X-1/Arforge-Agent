import { describe, expect, test } from "bun:test"
import * as SessionCheckpoint from "../../src/session/checkpoint"

const digest = (character: string) => character.repeat(64)

const lastTurn: SessionCheckpoint.TurnBinding = {
  turnStep: 2,
  requestDigest: digest("a"),
  contextDigest: digest("b"),
  toolSetRevision: digest("c"),
  routeConfigRevision: digest("d"),
  compilerRevision: "context-compiler/v1",
}

describe("SessionCheckpoint", () => {
  test("request dispatch metadata preserves the loop cursor and child provider owner", () => {
    const cursor = SessionCheckpoint.make({ sessionID: "ses_dispatch", nextStep: 3, needsContinuation: true, lastTurn })
    const previous = { phase: "subagent-provider", epoch: 4, sessionLoop: cursor, continuation: { sequence: 7 } }
    const turn = { ...lastTurn, turnStep: 3, requestDigest: digest("e") }
    const dispatch = {
      version: 1 as const,
      requestEventID: "evt_dispatch_fixture",
      requestDigest: turn.requestDigest,
      turnStep: turn.turnStep,
      attempt: 2,
      providerAttempt: 1,
      phase: "prepared" as const,
    }
    const prepared = SessionCheckpoint.withRequestDispatch(previous, { sessionID: "ses_dispatch", turn, dispatch })
    expect(prepared).toEqual({ ...previous, sessionLoop: { ...cursor, dispatch } })
    expect(
      SessionCheckpoint.fromContainer(
        SessionCheckpoint.withRequestDispatch(prepared, {
          sessionID: "ses_dispatch",
          turn,
          dispatch: { ...dispatch, attempt: 3 },
        }),
        "ses_dispatch",
      ),
    ).toMatchObject({ dispatch: { ...dispatch, attempt: 3 } })
    const sending = SessionCheckpoint.withRequestDispatch(prepared, {
      sessionID: "ses_dispatch",
      turn,
      dispatch: { ...dispatch, phase: "dispatching" },
    })
    expect(SessionCheckpoint.fromContainer(sending, "ses_dispatch")).toMatchObject({
      lastTurn,
      dispatch: { ...dispatch, phase: "dispatching" },
    })
    expect(() => SessionCheckpoint.withRequestDispatch(sending, { sessionID: "ses_dispatch", turn, dispatch })).toThrow(
      "regress",
    )
    expect(() =>
      SessionCheckpoint.withRequestDispatch(sending, {
        sessionID: "ses_dispatch",
        turn,
        dispatch: { ...dispatch, attempt: 3 },
      }),
    ).toThrow("event identity")
    expect(() =>
      SessionCheckpoint.withRequestDispatch(prepared, {
        sessionID: "ses_dispatch",
        turn,
        dispatch: { ...dispatch, requestDigest: digest("f") },
      }),
    ).toThrow("turn binding")
    const completed = SessionCheckpoint.make({
      sessionID: "ses_dispatch",
      nextStep: 4,
      needsContinuation: false,
      lastTurn: turn,
    })
    expect(SessionCheckpoint.intoContainer(sending, completed, "ses_dispatch")).toEqual({
      ...previous,
      sessionLoop: completed,
    })
    expect(previous.sessionLoop).not.toHaveProperty("dispatch")
  })

  test("request dispatch rejects malformed or unversioned metadata", () => {
    const cursor = SessionCheckpoint.make({ sessionID: "ses_dispatch", nextStep: 2, needsContinuation: true, lastTurn })
    const dispatch = {
      version: 1,
      requestEventID: "evt_fixture",
      requestDigest: digest("a"),
      turnStep: 2,
      attempt: 1,
      providerAttempt: 1,
      phase: "prepared",
    }
    for (const changed of [
      { ...dispatch, version: 2 },
      { ...dispatch, phase: "sent" },
      { ...dispatch, requestEventID: "" },
      { ...dispatch, requestDigest: "bad" },
      { ...dispatch, turnStep: 0 },
      { ...dispatch, attempt: 0 },
      { ...dispatch, providerAttempt: 0 },
      { ...dispatch, unexpected: "fixture" },
      null,
    ])
      expect(() => SessionCheckpoint.decode({ ...cursor, dispatch: changed }, "ses_dispatch")).toThrow()
    expect(() =>
      SessionCheckpoint.decode(
        { sessionID: "ses_dispatch", nextStep: 2, needsContinuation: true, dispatch },
        "ses_dispatch",
      ),
    ).toThrow("versioned Core")
  })

  test("keeps a Core cursor inside the existing provider checkpoint without overwriting its binding", () => {
    const provider = {
      phase: "subagent-provider",
      epoch: 2,
      permissionDigest: digest("e"),
      subagentContinuation: { nextSequence: 7 },
    }
    const state = SessionCheckpoint.make({ sessionID: "ses_child", nextStep: 3, needsContinuation: true, lastTurn })
    const combined = SessionCheckpoint.intoContainer(provider, state, "ses_child")
    expect(combined).toEqual({ ...provider, sessionLoop: state })
    expect(SessionCheckpoint.fromContainer(combined, "ses_child")).toEqual(SessionCheckpoint.decode(state, "ses_child"))
    expect(SessionCheckpoint.fromContainer(provider, "ses_child")).toBeUndefined()
    expect(provider).not.toHaveProperty("sessionLoop")
    expect(() => SessionCheckpoint.fromContainer(combined, "ses_other")).toThrow()
    expect(() => SessionCheckpoint.intoContainer({ ...provider, sessionLoop: "broken" }, state, "ses_child")).toThrow()
  })

  test("advances interrupted turns only after provider output is durable", () => {
    expect(SessionCheckpoint.nextStepAfterInterruption({ turnStep: 2, providerOutputObserved: false })).toBe(2)
    expect(SessionCheckpoint.nextStepAfterInterruption({ turnStep: 2, providerOutputObserved: true })).toBe(3)
    expect(() =>
      SessionCheckpoint.nextStepAfterInterruption({ turnStep: Number.MAX_SAFE_INTEGER, providerOutputObserved: true }),
    ).toThrow("safe integer")
  })

  test("round-trips a versioned semantic cursor", () => {
    const state = SessionCheckpoint.make({
      sessionID: "ses_checkpoint",
      nextStep: 3,
      nextPromotion: "steer",
      needsContinuation: true,
      lastTurn,
    })

    expect(SessionCheckpoint.decode(state, "ses_checkpoint")).toEqual({
      version: 1,
      kind: "session-agent-loop",
      sessionID: "ses_checkpoint",
      phase: "continuation",
      nextStep: 3,
      nextPromotion: "steer",
      needsContinuation: true,
      lastTurn,
      legacy: false,
    })
  })

  test("reads the legacy cursor without pretending it has a request binding", () => {
    expect(
      SessionCheckpoint.decode(
        {
          sessionID: "ses_legacy",
          nextStep: 2,
          nextPromotion: "queue",
          needsContinuation: true,
        },
        "ses_legacy",
      ),
    ).toEqual({
      version: 0,
      sessionID: "ses_legacy",
      nextStep: 2,
      nextPromotion: "queue",
      needsContinuation: true,
      lastTurn: undefined,
      legacy: true,
    })
  })

  test("round-trips a versioned mature-loop cursor without fabricating a request binding", () => {
    const state = SessionCheckpoint.makeMature({
      sessionID: "ses_mature_checkpoint",
      nextStep: 2,
      needsContinuation: true,
      admittedThroughSequence: 17,
    })

    expect(SessionCheckpoint.decode(state, "ses_mature_checkpoint")).toEqual({
      version: 1,
      kind: "mature-session-loop",
      sessionID: "ses_mature_checkpoint",
      phase: "mature-session-loop",
      nextStep: 2,
      needsContinuation: true,
      admittedThroughSequence: 17,
      legacy: false,
    })
  })

  test("fails closed for session, phase, and malformed revision tampering", () => {
    const state = SessionCheckpoint.make({
      sessionID: "ses_tamper",
      nextStep: 1,
      needsContinuation: false,
      lastTurn,
    })

    expect(() => SessionCheckpoint.decode({ ...state, sessionID: "ses_other" }, "ses_tamper")).toThrow(
      "identity or cursor",
    )
    expect(() => SessionCheckpoint.decode({ ...state, phase: "continuation" }, "ses_tamper")).toThrow(
      "phase does not match",
    )
    expect(() =>
      SessionCheckpoint.decode({ ...state, lastTurn: { ...lastTurn, requestDigest: "tampered" } }, "ses_tamper"),
    ).toThrow("lastTurn.requestDigest")
  })

  test("rejects malformed cursor values before the runner can use them", () => {
    expect(() =>
      SessionCheckpoint.make({
        sessionID: "ses_invalid",
        nextStep: 0,
        needsContinuation: true,
        lastTurn,
      }),
    ).toThrow("nextStep must be a positive integer")

    expect(() =>
      SessionCheckpoint.decode(
        {
          version: 1,
          kind: "session-agent-loop",
          sessionID: "ses_invalid",
          phase: "continuation",
          nextStep: 1,
          needsContinuation: true,
          legacy: false,
        },
        "ses_invalid",
      ),
    ).toThrow("missing the last turn binding")

    expect(() =>
      SessionCheckpoint.decode(
        {
          version: 1,
          kind: "mature-session-loop",
          sessionID: "ses_invalid",
          phase: "mature-session-loop",
          nextStep: 1,
          needsContinuation: false,
          admittedThroughSequence: -1,
          legacy: false,
        },
        "ses_invalid",
      ),
    ).toThrow("identity or cursor")
  })
})
