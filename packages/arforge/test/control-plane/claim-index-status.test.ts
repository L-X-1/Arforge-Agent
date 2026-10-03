import { describe, expect } from "bun:test"
import { AbsolutePath } from "@arforge-ai/core/schema"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { Effect } from "effect"
import { ClaimIndexStatus } from "../../src/control-plane/claim-index-status"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, ControlClaimIndex.node]),
)
const it = testEffect(runtimeLayer)

const principal = {
  tenantID: "ten_status",
  userID: "usr_status",
  email: "status@example.test",
  role: "owner" as const,
  sessionID: "ses_status",
}

const subject = AgentRuntime.ControlPlaneSubject.make({
  type: "control-plane",
  id: ControlPrincipal.controlPlaneID(principal, {
    location: "/claim-index-status",
    projectID: ProjectID.global,
    action: "worktree.create",
  }),
  location: AbsolutePath.make("/claim-index-status"),
  project: ProjectID.global,
  actor: "user",
  principalRef: ControlPrincipal.principalRef(principal),
  requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_status"),
})

const input: ControlClaimIndex.ClaimInput = {
  subject,
  gateway: {
    kind: "control-plane",
    name: "worktree.create",
    resources: ["filesystem:/claim-index-status"],
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L3",
      authority: "human",
      idempotency: "idempotent",
      retryability: "safe",
      reversibility: "irreversible",
      filesystemScope: ["/claim-index-status"],
      networkScope: [],
      secretScope: [],
      externalServices: ["git"],
      expectedArtifacts: [],
      successCriteria: ["created"],
    }),
    reasonSummary: "create worktree",
  },
  authorization: {
    requests: [{ action: "worktree.create", resources: ["filesystem:/claim-index-status"] }],
  },
  input: { name: "status" },
  operation: { kind: "worktree.create", payload: { name: "status" } },
  run: {
    initiator: "user",
    authority: "human",
    riskTier: "L3",
    reasonSummary: "create worktree",
    budget: AgentRuntime.Budget.make({
      maxAttempts: 1,
      maxDurationMs: 60_000,
      maxCostMicros: 0,
      maxTokens: 1_000_000,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    }),
    traceID: "claim-index-status",
    visibility: "details",
  },
}

describe("ClaimIndexStatus", () => {
  it.effect("binds the request identity context into ClaimIndex and returns only a display DTO", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const claimed = yield* claims
        .claim(input)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const status = yield* ClaimIndexStatus.lookup({ subject, operation: "worktree.create" }).pipe(
        Effect.provideService(IdentityContext.Current, principal),
      )

      expect(status).toEqual({
        runID: claimed.snapshot.run.id,
        actionID: claimed.snapshot.run.operation.actionID,
        requestID: subject.requestID,
        operation: "worktree.create",
        phase: "preparing",
        recovery: "resume",
        canApprove: false,
      })
      expect(status).not.toHaveProperty("payload")
      expect(status).not.toHaveProperty("checkpoint")
    }),
  )

  it.effect("fails closed when the authenticated principal cannot resolve the alias", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      yield* claims.claim(input).pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const exit = yield* ClaimIndexStatus.lookup({ subject, operation: "worktree.create" })
        .pipe(
          Effect.provideService(IdentityContext.Current, { ...principal, tenantID: "ten_other", userID: "usr_other" }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("ControlClaimIndex.NotFoundError")
    }),
  )
})
