import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { ControlClaimIndex } from "@arforge-ai/core/runtime"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SubagentControlClaim } from "@arforge-ai/core/runtime"
import { SubagentControlRecovery } from "@arforge-ai/core/runtime"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, DurableRun.node, ControlClaimIndex.node]),
)
const it = testEffect(runtimeLayer)

const principal: ControlClaimIndex.Principal = {
  tenantID: "ten_subagent_claim",
  userID: "usr_subagent_claim",
}

const subject = (requestID: string) =>
  AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: ControlPrincipal.controlPlaneID(principal, {
      location: "/subagent-claim",
      projectID: ProjectID.global,
      action: "subagent.control.steer",
    }),
    location: AbsolutePath.make("/subagent-claim"),
    project: ProjectID.global,
    actor: "user",
    principalRef: ControlPrincipal.principalRef(principal),
    requestID: AgentRuntime.ControlPlaneRequestID.make(requestID),
  })

const ids = {
  parent: AgentRuntime.RunID.make("run_subagent_claim_parent"),
  child: AgentRuntime.RunID.make("run_subagent_claim_child"),
  session: SessionSchema.ID.make("ses_subagent_claim_child"),
  message: SessionMessage.ID.make("msg_subagent_claim_message"),
}

const steerInput = (requestID: string): SubagentControlClaim.Input => ({
  operation: "steer",
  subject: subject(requestID),
  parentRunID: ids.parent,
  childRunID: ids.child,
  sessionID: ids.session,
  requestID: AgentRuntime.ControlPlaneRequestID.make(requestID),
  messageID: ids.message,
  promptDigest: "a".repeat(64),
  delivery: "steer",
})

describe("SubagentControlClaim", () => {
  it.effect("seals one metadata-only ActionGateway claim and preserves the exact envelope", () =>
    Effect.gen(function* () {
      const material = SubagentControlClaim.make(steerInput("cpr_subagent_claim_first"))
      const claims = yield* ControlClaimIndex.Service
      const claimed = yield* claims
        .claim(material.claim)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const durable = yield* DurableRun.Service
      const loaded = yield* durable.load(claimed.snapshot.run.id)
      if (!("subject" in loaded.run)) throw new Error("expected a control run")

      expect(claimed.kind).toBe("claimed")
      expect(loaded.run.operation.actionID).toBe(material.actionID)
      expect(loaded.run.operation.kind).toBe("subagent.control.steer")
      expect(JSON.stringify(loaded.run.operation.payload)).toBe(JSON.stringify(material.envelope))
      expect(JSON.stringify(loaded.run.operation.payload)).not.toContain("private prompt")
      expect(loaded.run.operation.payload).not.toHaveProperty("prompt")
      expect(loaded.run.operation.payload).not.toHaveProperty("reason")
      expect(loaded.run.operation.inputDigest).toBe(material.inputDigest)
      expect(loaded.run.operation.authorizationDigest).toBe(
        ActionGateway.intentDigestOf(
          {
            ...material.gateway,
            runID: loaded.run.id,
          },
          material.authorization,
        ),
      )
    }),
  )

  it.effect("replays the same request and separates a different request identity", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const first = SubagentControlClaim.make(steerInput("cpr_subagent_claim_replay"))
      const replay = SubagentControlClaim.make(steerInput("cpr_subagent_claim_replay"))
      const second = SubagentControlClaim.make(steerInput("cpr_subagent_claim_second"))

      const one = yield* claims
        .claim(first.claim)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const same = yield* claims
        .claim(replay.claim)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const two = yield* claims
        .claim(second.claim)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))

      expect(one.kind).toBe("claimed")
      expect(same.kind).toBe("existing")
      expect(same.snapshot.run.id).toBe(one.snapshot.run.id)
      expect(two.kind).toBe("claimed")
      expect(two.snapshot.run.id).not.toBe(one.snapshot.run.id)
      expect(first.envelope.envelopeDigest).toBe(replay.envelope.envelopeDigest)
      expect(first.actionID).toBe(replay.actionID)
      expect(first.actionID).not.toBe(second.actionID)
    }),
  )

  it.effect("rebuilds only the exact persisted envelope and rejects payload drift", () =>
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const material = SubagentControlClaim.make(steerInput("cpr_subagent_claim_recovery"))
      const claimed = yield* claims
        .claim(material.claim)
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      const durable = yield* DurableRun.Service
      const loaded = yield* durable
        .load(claimed.snapshot.run.id)
        .pipe(Effect.map((snapshot) => ("subject" in snapshot.run ? snapshot.run : undefined)))
      if (!loaded) throw new Error("expected a persisted control run")

      const rebuilt = SubagentControlRecovery.rebuildMaterial(loaded)
      expect(rebuilt.envelope).toEqual(material.envelope)
      expect(rebuilt.actionID).toBe(material.actionID)
      expect(rebuilt.inputDigest).toBe(material.inputDigest)

      const drifted = {
        ...loaded,
        operation: {
          ...loaded.operation,
          payload: { ...material.envelope, prompt: "raw prompt must never be replayed" },
        },
      }
      expect(() => SubagentControlRecovery.rebuildMaterial(drifted)).toThrow("immutable operation binding")
    }),
  )

  it.effect("rejects a claim that would smuggle prompt or cancellation bytes into durable control material", () =>
    Effect.gen(function* () {
      const base = steerInput("cpr_subagent_claim_invalid")
      const invalid = {
        ...base,
        promptDigest: undefined,
        prompt: "raw prompt",
      } as unknown as SubagentControlClaim.Input
      let invalidError: unknown
      try {
        SubagentControlClaim.make(invalid)
      } catch (error) {
        invalidError = error
      }
      expect(invalidError).toBeInstanceOf(SubagentControlClaim.InvalidClaimRequestError)
      expect((invalidError as SubagentControlClaim.InvalidClaimRequestError).reason).toContain("promptDigest")

      const cancel = {
        ...base,
        operation: "cancel" as const,
        messageID: undefined,
        promptDigest: undefined,
        delivery: undefined,
        reasonDigest: "b".repeat(64),
        prompt: "must not be accepted",
      } as unknown as SubagentControlClaim.Input
      const material = SubagentControlClaim.make(cancel)
      expect(material.envelope).not.toHaveProperty("prompt")
      expect(material.envelope).not.toHaveProperty("reason")
    }),
  )
})
