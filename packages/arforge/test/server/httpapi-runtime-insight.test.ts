import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { rm, writeFile } from "node:fs/promises"
import { Context, DateTime, Effect, Fiber } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Project } from "@arforge-ai/schema/project"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Location } from "@arforge-ai/core/location"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SessionID } from "@/session/schema"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import { AppRuntime } from "../../src/effect/app-runtime"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

async function request(route: string, directory: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("x-arforge-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("runtime insight HttpApi", () => {
  test("returns the real durable runtime snapshot for the requested workspace", async () => {
    await using workspace = await tmpdir()
    const response = await request("/api/runtime-insight/snapshot?limit=100", workspace.path)
    const body = await response.text()
    if (response.status !== 200) throw new Error(`runtime insight returned ${response.status}: ${body}`)
    const snapshot = JSON.parse(body) as {
      access: {
        role: string
        canReviewMutation: boolean
        canRollbackMutation: boolean
        canMaintainArtifacts: boolean
        canRecordMcpEvidence: boolean
      }
      durableRuns: unknown[]
      durableActions: unknown[]
      auditVerify: { valid: boolean }
    }
    expect(snapshot.access).toEqual({
      role: "owner",
      canReviewMutation: true,
      canRollbackMutation: true,
      canMaintainArtifacts: true,
      canRecordMcpEvidence: true,
    })
    expect(snapshot.durableRuns).toBeArray()
    expect(snapshot.durableActions).toBeArray()
    expect(snapshot.auditVerify).toMatchObject({ valid: true })
  })

  test("runs the bounded child-settlement recovery sweep through the Core owner", async () => {
    await using workspace = await tmpdir()
    const blocked = await request("/api/runtime-insight/settlements/recover-pending", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: "recover_settlement", limit: 10 }),
    })
    expect(blocked.status).toBe(400)
    expect(await blocked.text()).toContain("recover_settlements")

    const response = await request("/api/runtime-insight/settlements/recover-pending", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: "recover_settlements", limit: 10 }),
    })
    const body = await response.text()
    if (response.status !== 200) throw new Error(`settlement recovery sweep returned ${response.status}: ${body}`)
    const report = JSON.parse(body) as {
      schemaVersion: number
      status: string | null
      limit: number
      scanned: number
      committed: number
      pending: number
      recoveryRequired: number
      failed: number
      hasMore: boolean
      items: unknown[]
      deterministic: boolean
      providerExecutionAllowed: boolean
      access: { role: string }
    }
    expect(report).toMatchObject({
      schemaVersion: 1,
      status: null,
      limit: 10,
      scanned: 0,
      committed: 0,
      pending: 0,
      recoveryRequired: 0,
      failed: 0,
      hasMore: false,
      deterministic: true,
      providerExecutionAllowed: false,
      access: { role: "owner" },
    })
    expect(report.items).toEqual([])
    expect(JSON.stringify(report)).not.toContain("tenantID")
    expect(JSON.stringify(report)).not.toContain("userID")
  })

  test("projects admitted custom-agent evidence into the existing runtime insight run record", async () => {
    await using workspace = await tmpdir()
    const seeded = (await AppRuntime.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationContext = yield* locations.contextEffect(
              Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
            )
            return yield* Effect.provide(
              Effect.gen(function* () {
                const runtime = yield* DurableRun.Service
                const parentBudget = AgentRuntime.Budget.make({
                  maxAttempts: 2,
                  maxDurationMs: 10_000,
                  maxCostMicros: 10_000,
                  maxTokens: 10_000,
                  attemptsUsed: 0,
                  durationMsUsed: 0,
                  costMicrosUsed: 0,
                  tokensUsed: 0,
                })
                const childBudget = AgentRuntime.Budget.make({
                  maxAttempts: 1,
                  maxDurationMs: 5_000,
                  maxCostMicros: 5_000,
                  maxTokens: 5_000,
                  attemptsUsed: 0,
                  durationMsUsed: 0,
                  costMicrosUsed: 0,
                  tokensUsed: 0,
                })
                const parent = yield* runtime.create({
                  sessionID: SessionID.make("ses_runtime_insight_admission_parent"),
                  initiator: "user",
                  authority: "automatic",
                  riskTier: "L1",
                  reasonSummary: "runtime insight admission projection parent",
                  budget: parentBudget,
                  traceID: "runtime-insight-admission-parent",
                  visibility: "details",
                  project: Project.ID.global,
                  location: AbsolutePath.make(workspace.path),
                })
                for (const [to, reason] of [
                  ["preflight", "admission projection preflight"],
                  ["queued", "admission projection queued"],
                  ["running", "admission projection running"],
                ] as const)
                  yield* runtime.transition({ runID: parent.run.id, to, reason })
                const descriptorDigest = "e".repeat(64)
                const evidenceID = AgentRuntime.EvidenceID.make("evd_runtime_insight_admission")
                const child = yield* runtime.createChild({
                  parentRunID: parent.run.id,
                  sessionID: SessionID.make("ses_runtime_insight_admission_child"),
                  idempotencyKey: "runtime-insight-admission-child",
                  runtimeDescriptorDigest: descriptorDigest,
                  runtimeAdmission: {
                    evidence: {
                      schema_version: 1,
                      kind: "custom-agent-admission",
                      role: "CustomAgent.runtime-insight",
                      profile_path: "profiles/runtime-insight.json",
                      status: "admitted",
                      decision: "admitted",
                      reason: "profile is opted in and tool projection is complete",
                      ready: true,
                      descriptor_digest: descriptorDigest,
                      checks: {
                        status_consistent: true,
                        descriptor_digest_consistent: true,
                        tool_projection_consistent: true,
                        payload_free: true,
                      },
                      declared_tool_count: 1,
                      canonical_tool_count: 1,
                      unsupported_tool_count: 0,
                      valid: true,
                      violations: [],
                    },
                    evidenceRefs: [evidenceID],
                  },
                  delegatedObjective: "inspect runtime insight projection",
                  allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
                  project: Project.ID.global,
                  location: AbsolutePath.make(workspace.path),
                  expectedDeliverable: {
                    summaryRequired: true,
                    artifactKinds: [],
                    evidenceKinds: [],
                    verifier: "parent",
                  },
                  initiator: "agent",
                  authority: "automatic",
                  riskTier: "L0",
                  reasonSummary: "runtime insight admission projection child",
                  budget: childBudget,
                  traceID: "runtime-insight-admission-child",
                  parentTraceID: "runtime-insight-admission-parent",
                  visibility: "details",
                })
                return child.run.id
              }),
              locationContext,
            )
          }),
          HttpApiApp.locationServiceMapV2,
        ),
      ) as never,
    )) as AgentRuntime.RunID

    const response = await request("/api/runtime-insight/snapshot?limit=100", workspace.path)
    const body = await response.text()
    if (response.status !== 200)
      throw new Error(`runtime insight admission snapshot returned ${response.status}: ${body}`)
    const snapshot = JSON.parse(body) as {
      durableRuns: Array<{
        runID: string
        admission: {
          role: string
          status: string
          decision: string
          ready: boolean
          descriptorDigest: string | null
          checks: Record<string, boolean>
          declaredToolCount: number
          canonicalToolCount: number
          unsupportedToolCount: number
          valid: boolean
          evidenceRefs: string[]
        } | null
      }>
    }
    const record = snapshot.durableRuns.find((run) => run.runID === seeded)
    expect(record?.admission).toMatchObject({
      role: "CustomAgent.runtime-insight",
      status: "admitted",
      decision: "admitted",
      ready: true,
      descriptorDigest: "e".repeat(64),
      checks: {
        statusConsistent: true,
        descriptorDigestConsistent: true,
        toolProjectionConsistent: true,
        payloadFree: true,
      },
      declaredToolCount: 1,
      canonicalToolCount: 1,
      unsupportedToolCount: 0,
      valid: true,
      evidenceRefs: ["evd_runtime_insight_admission"],
    })
    expect(JSON.stringify(record?.admission)).not.toContain("profile_path")
    expect(JSON.stringify(record?.admission)).not.toContain("prompt")
    expect(JSON.stringify(record?.admission)).not.toContain("credential")
  })

  test("inspects a real postimage and records an evidence-bound review without replaying the action", async () => {
    await using workspace = await tmpdir()
    const postimage = "postimage-from-http-review\n"
    const target = "http-review.txt"
    await writeFile(join(workspace.path, target), postimage, "utf8")

    const seeded = (await AppRuntime.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationContext = yield* locations.contextEffect(
              Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
            )
            return yield* Effect.provide(
              Effect.gen(function* () {
                const gateway = yield* ActionGateway.Service
                const sessionID = SessionID.make("ses_runtime_http_review")
                const assistantMessageID = SessionMessage.ID.make("msg_runtime_http_review")
                const toolCallID = "call_runtime_http_review"
                const actionID = ActionGateway.stableActionID({ sessionID, assistantMessageID, toolCallID })
                const semantics = AgentRuntime.EffectSemantics.make({
                  riskTier: "L0",
                  authority: "automatic",
                  idempotency: "conditional",
                  retryability: "guarded",
                  reversibility: "reversible",
                  filesystemScope: [workspace.path],
                  networkScope: [],
                  secretScope: [],
                  externalServices: [],
                  expectedArtifacts: [target],
                  successCriteria: ["postimage exists"],
                })
                let executions = 0
                yield* gateway.execute(
                  {
                    sessionID,
                    assistantMessageID,
                    toolCallID,
                    agent: AgentV2.ID.make("build"),
                    actionID,
                    name: "write",
                    resources: [target],
                    semantics,
                    reasonSummary: "seed HTTP recovery review",
                    inputDigest: "digest-http-review",
                  },
                  {
                    execute: () =>
                      Effect.sync(() => {
                        executions += 1
                        return "seeded"
                      }),
                  },
                )
                if (!gateway.recordMutationIntent) throw new Error("mutation intent recorder is unavailable")
                const now = yield* DateTime.now
                const entry: AgentRuntime.MutationIntentEntry = {
                  target,
                  operation: "write",
                  afterDigest: createHash("sha256").update(postimage).digest("hex"),
                  afterByteLength: Buffer.byteLength(postimage),
                  recovery: "restore-from-volatile-journal",
                }
                const transactionID = AgentRuntime.MutationTransactionID.create()
                for (const phase of ["prepared", "committed"] as const) {
                  yield* gateway.recordMutationIntent({
                    actionID,
                    transactionID,
                    phase,
                    entries: [entry],
                    manifestDigest: MutationIntent.manifestDigest([entry])!,
                    createdAt: now,
                    updatedAt: now,
                    summary: "seed HTTP recovery review",
                  })
                }
                return { actionID, transactionID, executions }
              }),
              locationContext,
            )
          }),
          HttpApiApp.locationServiceMapV2,
        ),
      ) as never,
    )) as { actionID: AgentRuntime.ActionID; transactionID: AgentRuntime.MutationTransactionID; executions: number }

    const inspectedResponse = await request(
      `/api/runtime-insight/actions/${encodeURIComponent(seeded.actionID)}/recovery`,
      workspace.path,
    )
    const inspectedBody = await inspectedResponse.text()
    if (inspectedResponse.status !== 200)
      throw new Error(`recovery inspection returned ${inspectedResponse.status}: ${inspectedBody}`)
    const inspected = JSON.parse(inspectedBody) as {
      mutationRecovery: { transactionID: string; phase: string; requiresReview: boolean }
      inspection: { decision: string; observationDigest: string } | null
    }
    expect(inspected.mutationRecovery).toMatchObject({
      transactionID: seeded.transactionID,
      phase: "committed",
      requiresReview: true,
    })
    expect(inspected.inspection?.decision).toBe("postimage_matches")

    const reviewedResponse = await request(
      `/api/runtime-insight/actions/${encodeURIComponent(seeded.actionID)}/recovery/review`,
      workspace.path,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-arforge-directory": workspace.path },
        body: JSON.stringify({
          transactionID: seeded.transactionID,
          expectedPhase: "committed",
          observationDigest: inspected.inspection?.observationDigest,
          decision: "settle_postimage",
          inspectedDecision: "postimage_matches",
        }),
      },
    )
    const reviewedBody = await reviewedResponse.text()
    if (reviewedResponse.status !== 200)
      throw new Error(`recovery review returned ${reviewedResponse.status}: ${reviewedBody}`)
    const reviewed = JSON.parse(reviewedBody) as {
      mutationRecovery: { phase: string; requiresReview: boolean }
      inspection: { decision: string } | null
    }
    expect(reviewed.mutationRecovery).toMatchObject({ phase: "settled", requiresReview: false })
    expect(reviewed.inspection).toMatchObject({ decision: "postimage_matches" })
    expect(await Bun.file(join(workspace.path, target)).text()).toBe(postimage)
    expect(seeded.executions).toBe(1)
  })

  test("executes an explicitly approved artifact rollback through Core CAS and the ActionGateway", async () => {
    await using workspace = await tmpdir()
    const target = "http-artifact-rollback.txt"
    const beforeBytes = new TextEncoder().encode("before-from-http\n")
    const postimage = "postimage-from-http-rollback\n"
    await writeFile(join(workspace.path, target), postimage, "utf8")

    const seeded = (await AppRuntime.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationContext = yield* locations.contextEffect(
              Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
            )
            return yield* Effect.provide(
              Effect.gen(function* () {
                const gateway = yield* ActionGateway.Service
                const artifacts = yield* RollbackArtifact.Service
                const orphan = yield* Effect.promise(() =>
                  artifacts.store.put(new TextEncoder().encode("orphan-http-artifact\n")),
                )
                const sessionID = SessionID.make("ses_runtime_http_rollback")
                const assistantMessageID = SessionMessage.ID.make("msg_runtime_http_rollback")
                const toolCallID = "call_runtime_http_rollback"
                const actionID = ActionGateway.stableActionID({ sessionID, assistantMessageID, toolCallID })
                const semantics = AgentRuntime.EffectSemantics.make({
                  riskTier: "L0",
                  authority: "automatic",
                  idempotency: "conditional",
                  retryability: "guarded",
                  reversibility: "reversible",
                  filesystemScope: [workspace.path],
                  networkScope: [],
                  secretScope: [],
                  externalServices: [],
                  expectedArtifacts: [target],
                  successCriteria: ["postimage exists"],
                })
                let executions = 0
                yield* gateway.execute(
                  {
                    sessionID,
                    assistantMessageID,
                    toolCallID,
                    agent: AgentV2.ID.make("build"),
                    actionID,
                    name: "write",
                    resources: [target],
                    semantics,
                    reasonSummary: "seed HTTP artifact rollback",
                    inputDigest: "digest-http-artifact-rollback",
                  },
                  {
                    execute: () =>
                      Effect.sync(() => {
                        executions += 1
                        return "seeded"
                      }),
                  },
                )
                if (!gateway.recordMutationIntent) throw new Error("mutation intent recorder is unavailable")
                const artifact = yield* Effect.promise(() => artifacts.store.put(beforeBytes))
                const now = yield* DateTime.now
                const entry: AgentRuntime.MutationIntentEntry = {
                  target,
                  operation: "write",
                  beforeDigest: createHash("sha256").update(beforeBytes).digest("hex"),
                  afterDigest: createHash("sha256").update(postimage).digest("hex"),
                  afterByteLength: Buffer.byteLength(postimage),
                  rollbackArtifact: artifact,
                  recovery: "restore-from-artifact",
                }
                const transactionID = AgentRuntime.MutationTransactionID.create()
                for (const phase of ["prepared", "committed"] as const) {
                  yield* gateway.recordMutationIntent({
                    actionID,
                    transactionID,
                    phase,
                    entries: [entry],
                    manifestDigest: MutationIntent.manifestDigest([entry])!,
                    createdAt: now,
                    updatedAt: now,
                    summary: "seed HTTP artifact rollback",
                  })
                }
                return { actionID, transactionID, executions, orphan, artifact }
              }),
              locationContext,
            )
          }),
          HttpApiApp.locationServiceMapV2,
        ),
      ) as never,
    )) as {
      actionID: AgentRuntime.ActionID
      transactionID: AgentRuntime.MutationTransactionID
      executions: number
      orphan: RollbackArtifact.RollbackArtifactRef
      artifact: RollbackArtifact.RollbackArtifactRef
    }

    const recoveryURL = `/api/runtime-insight/actions/${encodeURIComponent(seeded.actionID)}/recovery`
    const inspectedResponse = await request(recoveryURL, workspace.path)
    const inspectedBody = await inspectedResponse.text()
    if (inspectedResponse.status !== 200)
      throw new Error(`artifact recovery inspection returned ${inspectedResponse.status}: ${inspectedBody}`)
    const inspected = JSON.parse(inspectedBody) as {
      mutationRecovery: { transactionID: string; phase: string }
      inspection: { decision: string; observationDigest: string; rollbackAvailable: boolean } | null
      artifact: { status: string; referencedCount: number; missingReferenceCount: number; corruptCount: number }
    }
    expect(inspected.mutationRecovery).toMatchObject({ transactionID: seeded.transactionID, phase: "committed" })
    expect(inspected.inspection).toMatchObject({ decision: "postimage_matches", rollbackAvailable: true })
    expect(inspected.artifact).toMatchObject({
      status: "available",
      referencedCount: 1,
      missingReferenceCount: 0,
      corruptCount: 0,
    })

    const artifactAuditResponse = await request("/api/runtime-insight/artifacts/maintenance", workspace.path)
    const artifactAuditBody = await artifactAuditResponse.text()
    if (artifactAuditResponse.status !== 200)
      throw new Error(`artifact audit returned ${artifactAuditResponse.status}: ${artifactAuditBody}`)
    const artifactAudit = JSON.parse(artifactAuditBody) as {
      scope: string
      operation: string
      scanID: string
      scanStatus: string
      pageNumber: number
      sessionDigest: string
      scanExpiresAt: number
      scanComplete: boolean
      nextCursor?: string
      referencedCount: number
      audit: { referencedCount: number; orphanCount: number }
      removed: number
    }
    expect(artifactAudit).toMatchObject({
      scope: "profile",
      operation: "audit",
      scanComplete: true,
      scanStatus: "complete",
      pageNumber: 1,
      referencedCount: 1,
      removed: 0,
    })
    expect(artifactAudit.nextCursor).toBeUndefined()
    expect(artifactAudit.audit).toMatchObject({ referencedCount: 1, orphanCount: 1 })

    const replayAuditResponse = await request(
      `/api/runtime-insight/artifacts/maintenance?scanID=${encodeURIComponent(artifactAudit.scanID)}`,
      workspace.path,
    )
    const replayAuditBody = await replayAuditResponse.text()
    if (replayAuditResponse.status !== 200)
      throw new Error(`maintenance scan replay returned ${replayAuditResponse.status}: ${replayAuditBody}`)
    expect(JSON.parse(replayAuditBody)).toMatchObject({
      scanID: artifactAudit.scanID,
      scanStatus: "complete",
      scanComplete: true,
      sessionDigest: artifactAudit.sessionDigest,
    })

    const invalidCursorResponse = await request(
      "/api/runtime-insight/artifacts/maintenance?cursor=not-a-durable-cursor",
      workspace.path,
    )
    const invalidCursorBody = await invalidCursorResponse.text()
    expect(invalidCursorResponse.status).toBe(400)
    expect(invalidCursorBody).toContain("cursor")

    const invalidScanResponse = await request(
      "/api/runtime-insight/artifacts/maintenance?scanID=not-a-maintenance-scan",
      workspace.path,
    )
    const invalidScanBody = await invalidScanResponse.text()
    expect(invalidScanResponse.status).toBe(400)
    expect(invalidScanBody).toContain("scan ID")

    const artifactSweepResponse = await request("/api/runtime-insight/artifacts/maintenance", workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scanID: artifactAudit.scanID,
        approval: "execute_sweep",
        maxAgeMs: 0,
        enforceQuota: false,
      }),
    })
    const artifactSweepBody = await artifactSweepResponse.text()
    if (artifactSweepResponse.status !== 200)
      throw new Error(`artifact sweep returned ${artifactSweepResponse.status}: ${artifactSweepBody}`)
    const artifactSweep = JSON.parse(artifactSweepBody) as {
      operation: string
      removed: number
      audit: { referencedCount: number; orphanCount: number }
    }
    expect(artifactSweep).toMatchObject({ operation: "sweep", removed: 1 })
    expect(artifactSweep.audit).toMatchObject({ referencedCount: 1, orphanCount: 0 })

    const artifactRoot = await AppRuntime.runPromise(
      Effect.gen(function* () {
        return (yield* RollbackArtifact.Service).store.root
      }),
    )
    const artifactPath = join(artifactRoot, `${seeded.artifact.artifactID}.bin`)
    await writeFile(artifactPath, "tampered-http-artifact")
    const corruptResponse = await request(recoveryURL, workspace.path)
    const corruptBody = await corruptResponse.text()
    if (corruptResponse.status !== 200)
      throw new Error(`corrupt artifact inspection returned ${corruptResponse.status}: ${corruptBody}`)
    const corrupt = JSON.parse(corruptBody) as {
      artifact: { status: string; reason: string }
      inspection: { rollbackAvailable: boolean } | null
    }
    expect(corrupt.artifact).toMatchObject({ status: "corrupt" })
    expect(corrupt.inspection).toMatchObject({ rollbackAvailable: false })
    expect(corrupt.artifact.reason).toContain("integrity")
    await rm(artifactPath, { force: true })
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const artifacts = yield* RollbackArtifact.Service
        yield* Effect.promise(() => artifacts.store.put(beforeBytes))
      }),
    )

    const requireRollbackResponse = await request(`${recoveryURL}/review`, workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transactionID: seeded.transactionID,
        expectedPhase: "committed",
        observationDigest: inspected.inspection?.observationDigest,
        decision: "require_rollback",
        inspectedDecision: "postimage_matches",
      }),
    })
    const requireRollbackBody = await requireRollbackResponse.text()
    if (requireRollbackResponse.status !== 200)
      throw new Error(`require rollback returned ${requireRollbackResponse.status}: ${requireRollbackBody}`)
    const required = JSON.parse(requireRollbackBody) as {
      mutationRecovery: { phase: string }
      inspection: { decision: string; observationDigest: string; rollbackAvailable: boolean } | null
    }
    expect(required.mutationRecovery.phase).toBe("rollback_required")
    expect(required.inspection).toMatchObject({ decision: "postimage_matches", rollbackAvailable: true })

    const staleRollbackResponse = await request(`${recoveryURL}/rollback`, workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transactionID: seeded.transactionID,
        expectedPhase: "rollback_required",
        observationDigest: createHash("sha256").update("stale-rollback-observation").digest("hex"),
        inspectedDecision: "postimage_matches",
        approval: "execute_rollback",
      }),
    })
    const staleRollbackBody = await staleRollbackResponse.text()
    expect(staleRollbackResponse.status).toBe(400)
    expect(staleRollbackBody).toContain("stale fingerprint")
    expect(await Bun.file(join(workspace.path, target)).text()).toBe(postimage)

    const rollbackResponse = await request(`${recoveryURL}/rollback`, workspace.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transactionID: seeded.transactionID,
        expectedPhase: "rollback_required",
        observationDigest: required.inspection?.observationDigest,
        inspectedDecision: "postimage_matches",
        approval: "execute_rollback",
      }),
    })
    const rollbackBody = await rollbackResponse.text()
    if (rollbackResponse.status !== 200)
      throw new Error(`artifact rollback returned ${rollbackResponse.status}: ${rollbackBody}`)
    const rolledBack = JSON.parse(rollbackBody) as {
      mutationRecovery: { phase: string; requiresReview: boolean }
      inspection: { decision: string } | null
    }
    expect(rolledBack.mutationRecovery).toMatchObject({ phase: "rolled_back", requiresReview: false })
    expect(rolledBack.inspection).toMatchObject({ decision: "preimage_matches" })
    expect(await Bun.file(join(workspace.path, target)).bytes()).toEqual(beforeBytes)
    expect(seeded.executions).toBe(1)
  })

  test("mixed session and control durable actions: session rows report, control rows never 500 or fabricate", async () => {
    await using workspace = await tmpdir()
    // Seed one session durable action and one control-plane durable action
    // through the real location gateway, exactly like production writes them.
    // The arforge test database is in-memory per location instance, so the
    // seed must run inside the same location service map the web handler
    // serves requests from (HttpApiApp.locationServiceMapV2).
    const seeded = (await AppRuntime.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationContext = yield* locations.contextEffect(
              Location.Ref.make({ directory: AbsolutePath.make(workspace.path) }),
            )
            return yield* Effect.provide(
              Effect.gen(function* () {
                const gateway = yield* ActionGateway.Service
                const authorizer = yield* Authorizer.Service
                // A real session action settles automatically at L0.
                const sessionID = SessionID.make("ses_runtime_mixed")
                const sessionMessageID = SessionMessage.ID.make("msg_runtime_mixed")
                const sessionActionID = ActionGateway.stableActionID({
                  sessionID,
                  assistantMessageID: sessionMessageID,
                  toolCallID: "call_runtime_mixed",
                })
                yield* gateway.execute(
                  {
                    sessionID,
                    assistantMessageID: sessionMessageID,
                    toolCallID: "call_runtime_mixed",
                    agent: AgentV2.ID.make("build"),
                    actionID: sessionActionID,
                    name: "read",
                    resources: [],
                    semantics: AgentRuntime.EffectSemantics.make({
                      riskTier: "L0",
                      authority: "automatic",
                      idempotency: "idempotent",
                      retryability: "safe",
                      reversibility: "not_applicable",
                      filesystemScope: [],
                      networkScope: [],
                      secretScope: [],
                      externalServices: [],
                      expectedArtifacts: [],
                      successCriteria: [],
                    }),
                    reasonSummary: "seed session action",
                    inputDigest: "digest-session",
                  },
                  { execute: () => Effect.succeed("ok") },
                )
                // A control-plane action persists its durable intent before the
                // fresh human approval; interrupting at awaiting_approval leaves
                // the proposed record in the location store.
                const subject = AgentRuntime.ControlPlaneSubject.make({
                  type: "control-plane",
                  id: AgentRuntime.ControlPlaneID.create(),
                  location: AbsolutePath.make(workspace.path),
                  project: Project.ID.global,
                  actor: "user",
                  principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
                  requestID: AgentRuntime.ControlPlaneRequestID.create(),
                })
                const controlActionID = ActionGateway.stableControlPlaneActionID({
                  subject,
                  name: "mcp.connect",
                  resources: ["server-a"],
                  inputDigest: "digest",
                  policyVersion: ActionGateway.POLICY_VERSION,
                })
                const fiber = yield* gateway
                  .execute(
                    {
                      kind: "control-plane",
                      controlPlane: subject,
                      actionID: controlActionID,
                      name: "mcp.connect",
                      resources: ["server-a"],
                      semantics: AgentRuntime.EffectSemantics.make({
                        riskTier: "L3",
                        authority: "human",
                        idempotency: "non_idempotent",
                        retryability: "never",
                        reversibility: "irreversible",
                        filesystemScope: [],
                        networkScope: [],
                        secretScope: [],
                        externalServices: [],
                        expectedArtifacts: [],
                        successCriteria: [],
                      }),
                      reasonSummary: "seed control action",
                      initiator: "user",
                      inputDigest: "digest",
                    },
                    {
                      authorization: { requests: [{ action: "mcp.connect", resources: ["server-a"] }] },
                      execute: () => Effect.succeed("connected"),
                      successSummary: () => "connected",
                    },
                  )
                  .pipe(Effect.forkScoped)
                yield* pollWithTimeout(
                  Effect.gen(function* () {
                    const list = yield* authorizer.list()
                    return list.find((item) => "subject" in item && item.subject.type === "control-plane")
                  }),
                  "control approval never became pending",
                )
                yield* Fiber.interrupt(fiber)
                return { sessionActionID, controlActionID, sessionID }
              }),
              locationContext,
            )
          }),
          HttpApiApp.locationServiceMapV2,
        ),
      ) as never,
    )) as { sessionActionID: AgentRuntime.ActionID; controlActionID: AgentRuntime.ActionID; sessionID: SessionID }

    const response = await request("/api/runtime-insight/snapshot?limit=100", workspace.path)
    const body = await response.text()
    if (response.status !== 200) throw new Error(`runtime insight returned ${response.status}: ${body}`)
    const snapshot = JSON.parse(body) as {
      durableActions: Array<{ actionID: string; sessionID: string; name: string }>
    }
    // The session row reports normally with its real sessionID.
    const sessionRow = snapshot.durableActions.find((row) => row.actionID === seeded.sessionActionID)
    expect(sessionRow).toBeDefined()
    expect(sessionRow?.sessionID).toBe(seeded.sessionID)
    expect(sessionRow?.name).toBe("read")
    // The control row is excluded: never fabricated into a sessionID, never
    // a 500. (A subject-aware control view arrives in a later batch.)
    expect(snapshot.durableActions.some((row) => row.actionID === seeded.controlActionID)).toBe(false)
  })
})
