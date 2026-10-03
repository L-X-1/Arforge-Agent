import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  bindMergeAction,
  evaluateMerge,
  executeMergeAction,
  makeWriteChangeReceipt,
  makeWriteLanePolicy,
  normalizeWorkspaceKey,
  verifyParentMerge,
  verifyParentMergeDurably,
  withWriteLane,
  type TestReceipt,
} from "@arforge-ai/core/runtime/write-conflict-control"
import { AgentV2 } from "@arforge-ai/core/agent"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { Effect } from "effect"

const baseHeadDigest = "a".repeat(64)
const nextHeadDigest = "b".repeat(64)
const beforeFileDigest = "c".repeat(64)
const afterFileDigest = "d".repeat(64)
const testDigest = "e".repeat(64)
const parentRunID = AgentRuntime.RunID.make("run_parent")
const mergeSubject = {
  sessionID: SessionSchema.ID.make("ses_merge"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_merge"),
  runID: parentRunID,
}

const tests: ReadonlyArray<TestReceipt> = [{ name: "bun test", status: "passed", resultDigest: testDigest }]

const receipt = (overrides: Partial<Parameters<typeof makeWriteChangeReceipt>[0]> = {}) =>
  makeWriteChangeReceipt({
    parentRunID,
    childRunID: "run-child",
    nodeID: "write-node",
    workspace: "E:/repo",
    isolation: "workspace-exclusive",
    baseHeadDigest,
    headDigest: nextHeadDigest,
    files: [
      { path: "src/example.ts", status: "modified", beforeDigest: beforeFileDigest, afterDigest: afterFileDigest },
    ],
    tests,
    ...overrides,
  })

describe("write conflict control", () => {
  test("defaults read children to read-only and rejects a contradictory write lane", () => {
    expect(normalizeWorkspaceKey("E:/")).toBe("e:/")
    expect(normalizeWorkspaceKey("//Server/Share/")).toBe("//server/share")
    expect(
      makeWriteLanePolicy({
        parentRunID: "parent",
        childRunID: "child",
        nodeID: "read",
        ownerID: "owner",
        workspace: "E:/repo",
        access: "read",
      }),
    ).toMatchObject({ mode: "read-only", canMutate: false })
    expect(() =>
      makeWriteLanePolicy({
        parentRunID: "parent",
        childRunID: "child",
        nodeID: "read",
        ownerID: "owner",
        workspace: "E:/repo",
        access: "read",
        isolation: "workspace-exclusive",
      }),
    ).toThrow("read children cannot request a write isolation mode")
  })

  test("serializes workspace-exclusive writers across runtime instances", async () => {
    const lockDirectory = mkdtempSync(join(tmpdir(), "arforge-write-lane-test-"))
    const active: string[] = []
    let concurrent = 0
    let maximumConcurrent = 0
    const run = (childRunID: string) =>
      withWriteLane(
        {
          parentRunID: "parent",
          childRunID,
          nodeID: childRunID,
          ownerID: `owner-${childRunID}`,
          workspace: "E:/shared-repo",
          access: "write",
          isolation: "workspace-exclusive",
        },
        new AbortController().signal,
        async (policy) => {
          active.push(`${policy.childRunID}:start`)
          concurrent += 1
          maximumConcurrent = Math.max(maximumConcurrent, concurrent)
          await Bun.sleep(25)
          concurrent -= 1
          active.push(`${policy.childRunID}:end`)
        },
        { lockDirectory },
      )
    try {
      await Promise.all([run("child-a"), run("child-b")])
      expect(maximumConcurrent).toBe(1)
      expect(active).toHaveLength(4)
      expect(active[0]?.replace(":start", ":end")).toBe(active[1])
      expect(active[2]?.replace(":start", ":end")).toBe(active[3])
      expect(active[0]?.split(":")[0]).not.toBe(active[2]?.split(":")[0])
    } finally {
      rmSync(lockDirectory, { recursive: true, force: true })
    }
  })

  test("serializes workspace-exclusive writers across operating-system processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "arforge-write-lane-process-test-"))
    const lockDirectory = join(root, "locks")
    const acquiredMarker = join(root, "acquired")
    const releasedMarker = join(root, "released")
    const workspace = "E:/shared-process-repo"
    const worker = Bun.spawn(
      [process.execPath, "test/fixture/write-lane-worker.ts", lockDirectory, workspace, acquiredMarker, releasedMarker],
      { cwd: join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" },
    )

    try {
      for (let attempt = 0; attempt < 100 && !existsSync(acquiredMarker); attempt += 1) await Bun.sleep(10)
      expect(existsSync(acquiredMarker)).toBe(true)

      let childReleasedBeforeParentEntered = false
      await withWriteLane(
        {
          parentRunID: "parent-process",
          childRunID: "child-process-parent",
          nodeID: "parent-node",
          ownerID: "parent-process-owner",
          workspace,
          access: "write",
          isolation: "workspace-exclusive",
        },
        new AbortController().signal,
        async () => {
          childReleasedBeforeParentEntered = existsSync(releasedMarker)
        },
        { lockDirectory },
      )

      expect(childReleasedBeforeParentEntered).toBe(true)
      expect(await worker.exited).toBe(0)
    } finally {
      worker.kill()
      await worker.exited
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("creates a deterministic receipt and only readies an authorized merge action", () => {
    const first = receipt()
    const second = receipt()
    expect(first.diffDigest).toBe(second.diffDigest)
    const decision = evaluateMerge({
      receipt: first,
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    expect(decision).toMatchObject({ allowed: true, action: "ready" })
    expect(decision.plan).toMatchObject({
      actionKind: "repository.merge",
      riskTier: "L2",
      authority: "scoped_grant",
      requiresActionGateway: true,
      resources: ["workspace:e:/repo", "file:src/example.ts"],
    })
    expect(decision.plan?.planID).toMatch(/^merge_[a-f0-9]{32}$/)
    expect(decision.plan?.planDigest).toMatch(/^[a-f0-9]{64}$/)
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const binding = bindMergeAction(decision.plan, mergeSubject)
    expect(binding.input).toMatchObject({
      actionID: expect.stringMatching(/^act_[a-f0-9]{32}$/),
      name: "repository.merge",
      runID: parentRunID,
      inputDigest: decision.plan.planDigest,
    })
    expect(binding.authorization.requests).toEqual([
      { action: "repository.merge", resources: ["file:src/example.ts", "workspace:e:/repo"] },
    ])
  })

  test("executes a ready merge only through the canonical ActionGateway binding", async () => {
    const decision = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const plan = decision.plan
    const binding = bindMergeAction(plan, mergeSubject)
    let observed: { input?: ActionGateway.Input; authorization?: ActionGateway.AuthorizationPlan } = {}
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- this fake observes the generic gateway handoff and deliberately never invokes the operation body
    const gateway = {
      execute: (input: ActionGateway.Input, operation: ActionGateway.Operation<unknown, never, never>) => {
        observed = { input, authorization: operation.authorization }
        return Effect.succeed({
          value: "gateway-settled",
          observation: { headDigest: nextHeadDigest, diffDigest: plan.diffDigest, changedPaths: ["src/example.ts"] },
          tests,
        })
      },
    } as unknown as ActionGateway.Interface

    const result = await Effect.runPromise(
      executeMergeAction(gateway, plan, binding, {
        inspect: () =>
          Effect.succeed({ headDigest: baseHeadDigest, diffDigest: plan.diffDigest, changedPaths: [] }),
        apply: () => Effect.succeed("unreachable"),
        verifyTests: () => Effect.succeed(tests),
      }),
    )
    expect(result.value).toBe("gateway-settled")
    expect(observed.input?.actionID).toBe(binding.input.actionID)
    expect(observed.authorization).toEqual(binding.authorization)
  })

  test("rejects forged write receipt isolation at runtime", () => {
    const invalidInput = {
      parentRunID,
      childRunID: "run-child",
      nodeID: "write-node",
      workspace: "E:/repo",
      isolation: "workspace-exclusive" as const,
      baseHeadDigest,
      headDigest: nextHeadDigest,
      files: [
        { path: "src/example.ts", status: "modified" as const, beforeDigest: beforeFileDigest, afterDigest: afterFileDigest },
      ],
      tests,
    }
    Reflect.set(invalidInput, "isolation", "read-only")
    expect(() => makeWriteChangeReceipt(invalidInput)).toThrow("write receipt isolation")

    const forged = { ...receipt() }
    Reflect.set(forged, "isolation", "read-only")
    const decision = evaluateMerge({
      receipt: forged,
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    expect(decision.allowed).toBe(false)
    expect(decision.failedChecks.join(" ")).toContain("write receipt isolation")
  })

  test("rejects ambiguous paths, no-op modifications, and silently truncated test names", () => {
    expect(() =>
      receipt({
        files: [
          { path: "src/Example.ts", status: "modified", beforeDigest: beforeFileDigest, afterDigest: afterFileDigest },
          { path: "SRC/example.ts", status: "modified", beforeDigest: beforeFileDigest, afterDigest: nextHeadDigest },
        ],
      }),
    ).toThrow("case-insensitive aliases")
    expect(() =>
      receipt({
        files: [
          { path: "src/example.ts", status: "modified", beforeDigest: beforeFileDigest, afterDigest: beforeFileDigest },
        ],
      }),
    ).toThrow("must change its content digest")
    expect(() => receipt({ tests: [{ ...tests[0], name: "x".repeat(257) }] })).toThrow("must not exceed")
  })

  test("canonicalizes active-claim ordering for stable merge decisions", () => {
    const first = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
      activeClaims: [
        { ownerID: "z", changedPaths: ["src/z.ts"] },
        { ownerID: "a", changedPaths: ["src/a.ts"] },
      ],
    })
    const second = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
      activeClaims: [
        { ownerID: "a", changedPaths: ["src/a.ts"] },
        { ownerID: "z", changedPaths: ["src/z.ts"] },
      ],
    })
    expect(first.inputDigest).toBe(second.inputDigest)
    expect(first.decisionDigest).toBe(second.decisionDigest)
  })

  test("fails closed for stale bases, failed tests, wrong authority, and same-file overlap", () => {
    const stale = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: "f".repeat(64),
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    expect(stale.allowed).toBe(false)
    expect(stale.failedChecks.join(" ")).toContain("current HEAD differs")

    const failedTest = evaluateMerge({
      receipt: receipt({ tests: [{ ...tests[0], status: "failed" }] }),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    expect(failedTest.allowed).toBe(false)
    expect(failedTest.failedChecks.join(" ")).toContain("tests must pass")

    const wrongAuthority = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L3",
      authorization: "scoped-grant",
    })
    expect(wrongAuthority.allowed).toBe(false)
    expect(wrongAuthority.failedChecks.join(" ")).toContain("human approval")

    const overlap = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
      activeClaims: [{ ownerID: "other", childRunID: "other-child", changedPaths: ["SRC/EXAMPLE.ts"] }],
    })
    expect(overlap.allowed).toBe(false)
    expect(overlap.failedChecks.join(" ")).toContain("automatic overwrite is forbidden")

    const forgedSelfClaim = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
      activeClaims: [{ ownerID: "other", childRunID: "run-child", changedPaths: ["src/example.ts"] }],
    })
    expect(forgedSelfClaim.allowed).toBe(false)
  })

  test("parent verifier checks the settled action, resulting head, diff, paths, and tests", () => {
    const childReceipt = receipt()
    const decision = evaluateMerge({
      receipt: childReceipt,
      currentHeadDigest: baseHeadDigest,
      riskTier: "L3",
      authorization: "human-approved",
    })
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const binding = bindMergeAction(decision.plan, mergeSubject)
    const actionIntentDigest = ActionGateway.intentDigestOf(binding.input, binding.authorization)
    const passed = verifyParentMerge({
      plan: decision.plan,
      binding,
      observedActionID: binding.input.actionID,
      observedActionIntentDigest: actionIntentDigest,
      actionStatus: "settled",
      observedParentRunID: parentRunID,
      parentStatus: "verifying",
      observedHeadDigest: nextHeadDigest,
      observedDiffDigest: childReceipt.diffDigest,
      observedChangedPaths: ["src/example.ts"],
      tests,
    })
    expect(passed.passed).toBe(true)
    expect(passed.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)

    const rejected = verifyParentMerge({
      plan: decision.plan,
      binding,
      observedActionID: binding.input.actionID,
      observedActionIntentDigest: actionIntentDigest,
      actionStatus: "blocked",
      observedParentRunID: parentRunID,
      parentStatus: "verifying",
      observedHeadDigest: baseHeadDigest,
      observedDiffDigest: childReceipt.diffDigest,
      observedChangedPaths: ["src/example.ts"],
      tests,
    })
    expect(rejected.passed).toBe(false)
    expect(rejected.failedChecks).toContain("merge Action did not settle successfully")
  })

  test("rejects a plan or Action binding that drifts after preflight", () => {
    const decision = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const plan = decision.plan
    expect(() => bindMergeAction({ ...plan, changedPaths: ["src/other.ts"] }, mergeSubject)).toThrow(
      "merge plan",
    )

    const binding = bindMergeAction(plan, mergeSubject)
    const actionIntentDigest = ActionGateway.intentDigestOf(binding.input, binding.authorization)
    const forged = { ...binding, input: { ...binding.input, inputDigest: "f".repeat(64) } }
    const verification = verifyParentMerge({
      plan,
      binding: forged,
      observedActionID: binding.input.actionID,
      observedActionIntentDigest: actionIntentDigest,
      actionStatus: "settled",
      observedParentRunID: parentRunID,
      parentStatus: "verifying",
      observedHeadDigest: nextHeadDigest,
      observedDiffDigest: plan.diffDigest,
      observedChangedPaths: ["src/example.ts"],
      tests,
    })
    expect(verification.passed).toBe(false)
    expect(verification.failedChecks.join(" ")).toContain("binding")
  })

  test("loads the settled durable Action before parent verification", async () => {
    const decision = evaluateMerge({
      receipt: receipt(),
      currentHeadDigest: baseHeadDigest,
      riskTier: "L2",
      authorization: "scoped-grant",
    })
    if (!decision.plan) throw new Error("expected a ready merge plan")
    const binding = bindMergeAction(decision.plan, mergeSubject)
    let loaded: AgentRuntime.ActionID | undefined
    const durableActions = {
      load: (actionID: AgentRuntime.ActionID) => {
        loaded = actionID
        return Effect.succeed({
          action: {
            id: binding.input.actionID,
            status: "settled" as const,
            intentDigest: ActionGateway.intentDigestOf(binding.input, binding.authorization),
          },
          observation: { status: "succeeded" as const },
        })
      },
    }
    const durableRuns = {
      load: (runID: AgentRuntime.RunID) =>
        Effect.succeed({ run: { id: runID, status: "verifying" as const } }),
    }

    const verification = await Effect.runPromise(
      verifyParentMergeDurably(durableActions, durableRuns, {
        plan: decision.plan,
        binding,
        observedHeadDigest: nextHeadDigest,
        observedDiffDigest: decision.plan.diffDigest,
        observedChangedPaths: ["src/example.ts"],
        tests,
      }),
    )
    expect(loaded).toBe(binding.input.actionID)
    expect(verification.passed).toBe(true)

    const mismatchedParent = await Effect.runPromise(
      verifyParentMergeDurably(
        durableActions,
        {
          load: () =>
            Effect.succeed({
              run: { id: AgentRuntime.RunID.make("run_other_parent"), status: "verifying" as const },
            }),
        },
        {
          plan: decision.plan,
          binding,
          observedHeadDigest: nextHeadDigest,
          observedDiffDigest: decision.plan.diffDigest,
          observedChangedPaths: ["src/example.ts"],
          tests,
        },
      ),
    )
    expect(mismatchedParent.passed).toBe(false)
    expect(mismatchedParent.failedChecks.join(" ")).toContain("parent Run ID")
  })
})
