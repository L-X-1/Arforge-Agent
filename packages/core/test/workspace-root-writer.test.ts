import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
  actionGatewayAuthorizationPlan,
  commitWorkspaceRootMutation,
  type WorkspaceRootMutationState,
  type WorkspaceRootWriterSeams,
  WorkspaceRootWriterError,
} from "../src/workspace-root-writer"
import {
  planWorkspaceRootMutation,
  workspaceRootMutationIntentDigest,
  workspaceRootMutationStateDigest,
} from "../src/workspace-roots"

const makeFixture = async () => {
  const primary = await mkdtemp(resolve(tmpdir(), "arforge-workspace-writer-primary-"))
  const target = await mkdtemp(resolve(tmpdir(), "arforge-workspace-writer-target-"))
  const request = {
    action: "trust" as const,
    primary,
    primaryIsDirectory: true,
    target,
    targetIsDirectory: true,
    trustedWorkspaces: [] as string[],
    configuredRoots: [] as string[],
  }
  const authorization = {
    kind: "action-gateway" as const,
    status: "approved" as const,
    receiptID: "receipt-writer",
    actionID: "action-writer",
    workspace: resolve(primary),
    target: resolve(target),
    intentDigest: workspaceRootMutationIntentDigest(request),
  }
  const plan = planWorkspaceRootMutation({ ...request, authorization })
  const state: WorkspaceRootMutationState = {
    trustedWorkspaces: [],
    configuredRoots: [],
    digest: workspaceRootMutationStateDigest({ trustedWorkspaces: [], configuredRoots: [] }),
  }
  return { primary, target, request, authorization, plan, state }
}

const successfulSeams = (initial: WorkspaceRootMutationState) => {
  let current = initial
  const outbox: string[] = []
  const audits: string[] = []
  const writer: WorkspaceRootWriterSeams = {
    enabled: true,
    readState: () => Effect.succeed(current),
    targetIsDirectory: () => Effect.succeed(true),
    createRollbackArtifact: ({ before }) =>
      Effect.succeed({ artifactID: "workspace-rollback-1", stateDigest: before.digest }),
    appendRecoveryOutbox: (record) =>
      Effect.sync(() => {
        outbox.push(record.phase)
      }),
    compareAndSwap: (input) =>
      Effect.sync(() => {
        if (!sameDigest(current.digest, input.expected)) return false
        current = {
          trustedWorkspaces: input.nextTrustedWorkspaces,
          configuredRoots: input.nextConfiguredRoots,
          digest: workspaceRootMutationStateDigest({
            trustedWorkspaces: input.nextTrustedWorkspaces,
            configuredRoots: input.nextConfiguredRoots,
          }),
        }
        return true
      }),
    audit: (record) => Effect.sync(() => audits.push(record.phase)),
  }
  return { writer, outbox, audits, current: () => current }
}

const sameDigest = (left: WorkspaceRootMutationState["digest"], right: WorkspaceRootMutationState["digest"]) =>
  left.trusted === right.trusted && left.configured === right.configured

describe("workspace root writer seam", () => {
  test("commits only after rollback, prepared outbox, CAS, committed outbox and audit", async () => {
    const fixture = await makeFixture()
    try {
      const seams = successfulSeams(fixture.state)
      const result = await Effect.runPromise(
        commitWorkspaceRootMutation({
          request: fixture.request,
          authorization: fixture.authorization,
          plan: fixture.plan,
          writer: seams.writer,
        }),
      )
      expect(result).toMatchObject({ status: "committed", action: "trust", rollbackArtifactID: "workspace-rollback-1" })
      expect(seams.outbox).toEqual(["prepared", "committed"])
      expect(seams.audits).toEqual(["committed"])
      expect(seams.current().trustedWorkspaces).toEqual([resolve(fixture.target)])
    } finally {
      await rm(fixture.primary, { recursive: true, force: true })
      await rm(fixture.target, { recursive: true, force: true })
    }
  })

  test("is disabled by default and never invokes persistence seams", async () => {
    const fixture = await makeFixture()
    let calls = 0
    try {
      const writer: WorkspaceRootWriterSeams = {
        ...successfulSeams(fixture.state).writer,
        enabled: false,
        readState: () => {
          calls += 1
          return Effect.succeed(fixture.state)
        },
      }
      const exit = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: fixture.request,
          authorization: fixture.authorization,
          plan: fixture.plan,
          writer,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("writer_disabled")
      expect(calls).toBe(0)
    } finally {
      await rm(fixture.primary, { recursive: true, force: true })
      await rm(fixture.target, { recursive: true, force: true })
    }
  })

  test("rejects stale state before rollback or outbox and rejects forged artifact digest", async () => {
    const fixture = await makeFixture()
    try {
      const stale = {
        ...fixture.state,
        trustedWorkspaces: [resolve(fixture.primary)],
        digest: workspaceRootMutationStateDigest({
          trustedWorkspaces: [resolve(fixture.primary)],
          configuredRoots: [],
        }),
      }
      const staleSeams = successfulSeams(stale)
      const staleExit = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: fixture.request,
          authorization: fixture.authorization,
          plan: fixture.plan,
          writer: staleSeams.writer,
        }),
      )
      expect(Exit.isFailure(staleExit)).toBe(true)
      if (Exit.isFailure(staleExit)) expect(staleExit.cause.toString()).toContain("state_conflict")
      expect(staleSeams.outbox).toEqual([])

      const goodArtifact = successfulSeams(fixture.state)
      const badWriter: WorkspaceRootWriterSeams = {
        ...goodArtifact.writer,
        createRollbackArtifact: ({ before }) =>
        Effect.succeed({ artifactID: "workspace-rollback-forged", stateDigest: { ...before.digest, trusted: "0".repeat(64) } })
      }
      const badExit = await Effect.runPromiseExit(
        commitWorkspaceRootMutation({
          request: fixture.request,
          authorization: fixture.authorization,
          plan: fixture.plan,
          writer: badWriter,
        }),
      )
      expect(Exit.isFailure(badExit)).toBe(true)
      if (Exit.isFailure(badExit)) expect(badExit.cause.toString()).toContain("rollback_unavailable")
      expect(goodArtifact.outbox).toEqual([])
    } finally {
      await rm(fixture.primary, { recursive: true, force: true })
      await rm(fixture.target, { recursive: true, force: true })
    }
  })

  test("keeps a single deterministic ActionGateway permission scope", () => {
    const plan = actionGatewayAuthorizationPlan({
      action: "remove",
      primary: "C:\\workspace",
      primaryIsDirectory: true,
      target: "D:\\extra",
      targetIsDirectory: false,
      trustedWorkspaces: ["D:\\extra"],
      configuredRoots: ["D:\\extra"],
    })
    expect(plan.requests).toEqual([
      { action: "workspace-root:remove", resources: ["C:\\workspace", "D:\\extra"] },
    ])
    expect(plan.metadata).toEqual({ schemaVersion: 1, mutation: "remove", workspaceMutation: true })
  })

  test("records recovery-required when post-CAS outbox or audit completion fails", async () => {
    const fixture = await makeFixture()
    try {
      for (const failure of ["outbox", "audit"] as const) {
        const seams = successfulSeams(fixture.state)
        const phases: string[] = []
        const writer: WorkspaceRootWriterSeams = {
          ...seams.writer,
          appendRecoveryOutbox: (record) =>
            Effect.gen(function* () {
              phases.push(record.phase)
              if (failure === "outbox" && record.phase === "committed")
                return yield* Effect.fail(new Error("committed receipt unavailable"))
            }),
          audit: (record) =>
            failure === "audit" ? Effect.fail(new Error("audit unavailable")) : Effect.sync(() => phases.push(record.phase)),
        }
        const exit = await Effect.runPromiseExit(
          commitWorkspaceRootMutation({
            request: fixture.request,
            authorization: fixture.authorization,
            plan: fixture.plan,
            writer,
          }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain(`${failure}_unavailable`)
        expect(phases).toEqual(
          failure === "outbox"
            ? ["prepared", "committed", "recovery_required"]
            : ["prepared", "committed", "recovery_required"],
        )
      }
    } finally {
      await rm(fixture.primary, { recursive: true, force: true })
      await rm(fixture.target, { recursive: true, force: true })
    }
  })

  test("exposes typed writer failures without leaking seam errors", () => {
    const error = new WorkspaceRootWriterError("audit_unavailable")
    expect(error._tag).toBe("WorkspaceRootWriterError")
    expect(error.reason).toBe("audit_unavailable")
    expect(error.message).toBe("workspace root writer blocked: audit_unavailable")
  })
})
