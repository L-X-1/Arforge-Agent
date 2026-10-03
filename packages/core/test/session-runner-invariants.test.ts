import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import * as SessionCheckpoint from "@arforge-ai/core/session/checkpoint"
import * as RunnerInvariants from "@arforge-ai/core/session/runner/invariants"

const digest = "a".repeat(64)

const checkpoint = SessionCheckpoint.decode(
  SessionCheckpoint.make({
    sessionID: "ses_runner_invariant",
    nextStep: 2,
    nextPromotion: "steer",
    needsContinuation: true,
    lastTurn: {
      turnStep: 1,
      requestDigest: digest,
      contextDigest: digest,
      toolSetRevision: digest,
      routeConfigRevision: digest,
      compilerRevision: "context-compiler/v1",
    },
  }),
  "ses_runner_invariant",
)

describe("SessionRunner runtime invariants", () => {
  it("registers one idempotent owner contract for input, cursor, mature cursor, and terminal phases", () => {
    const registry = new RuntimeInvariants.RuntimeInvariantRegistry()
    RunnerInvariants.registerInvariants(registry)
    RunnerInvariants.registerInvariants(registry)

    expect(registry.list(RunnerInvariants.OWNER).map((item) => item.key)).toEqual([
      "execution-input",
      "checkpoint-cursor",
      "mature-checkpoint",
      "request-projection",
      "terminal",
    ])
  })

  it("validates metadata-only phase contexts and maps failures to a structured error", async () => {
    const registry = new RuntimeInvariants.RuntimeInvariantRegistry()
    RunnerInvariants.registerInvariants(registry)

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "execution-input",
          sessionID: "ses_runner_invariant",
          force: false,
          maxTransportRetries: 2,
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "mature-checkpoint",
          sessionID: "ses_runner_invariant",
          runID: "run_runner_invariant",
          phase: "mature-session-loop",
          nextStep: 1,
          needsContinuation: true,
          admittedThroughSequence: 0,
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "checkpoint-cursor",
          sessionID: "ses_runner_invariant",
          runID: "run_runner_invariant",
          checkpoint,
          restoringContinuation: true,
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "request-projection",
          sessionID: "ses_runner_invariant",
          runtime: "formal",
          projection: {
            schemaVersion: 1,
            runID: "run_runner_invariant",
            turnStep: 1,
            attempt: 1,
            requestDigest: digest,
            contextDigest: digest,
            toolSetRevision: digest,
            routeConfigRevision: digest,
            compilerRevision: "context-compiler/v1",
          },
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "terminal",
          sessionID: "ses_runner_invariant",
          runID: "run_runner_invariant",
          status: "completed",
          leaseMatches: true,
          attempt: 1,
        }),
      ),
    ).resolves.toBeUndefined()

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "execution-input",
          sessionID: "ses_runner_invariant",
          force: false,
          maxTransportRetries: 4,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SessionRunner.InvariantError",
      phase: "execution-input",
    })
  })

  it("selects only the active phase and rejects stale or incomplete cursors", async () => {
    const registry = new RuntimeInvariants.RuntimeInvariantRegistry()
    RunnerInvariants.registerInvariants(registry)
    registry.register({
      owner: RunnerInvariants.OWNER,
      key: "unrelated",
      version: "1",
      cost: "cheap",
      check: () => Effect.fail(new Error("unrelated invariant must not run")),
    })

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "request-projection",
          sessionID: "ses_runner_invariant",
          runtime: "mature",
          projection: {
            schemaVersion: 1,
            runID: "run_runner_invariant",
            turnStep: 1,
            attempt: 1,
            requestDigest: "invalid",
            contextDigest: digest,
            toolSetRevision: digest,
            routeConfigRevision: digest,
            compilerRevision: "context-compiler/v1",
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SessionRunner.InvariantError",
      phase: "request-projection",
    })

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "checkpoint-cursor",
          sessionID: "ses_runner_invariant",
          runID: "run_runner_invariant",
          checkpoint: undefined,
          restoringContinuation: true,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SessionRunner.InvariantError",
      phase: "checkpoint-cursor",
    })

    await expect(
      Effect.runPromise(
        RunnerInvariants.assert(registry, {
          kind: "terminal",
          sessionID: "ses_runner_invariant",
          runID: "run_runner_invariant",
          status: "paused",
          leaseMatches: false,
          attempt: 1,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SessionRunner.InvariantError",
      phase: "terminal",
    })
  })
})
