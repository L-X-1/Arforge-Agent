import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, Model, Usage } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import * as TitleGeneration from "../src/session/title-generation"
import { createRequestEnvelope, rebuildRequest, requestEnvelopeJson } from "../src/session/request-envelope"
import { and, asc, eq } from "drizzle-orm"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { AgentV2 } from "@arforge-ai/core/agent"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Project } from "@arforge-ai/schema/project"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Global } from "@arforge-ai/core/global"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import * as MutationIntent from "@arforge-ai/core/runtime/mutation-intent"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"

const authorizationRequests: PermissionV2.AssertInput[] = []
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? PermissionV2.ID.create(), effect: "allow" }),
    assert: (input) =>
      Effect.sync(() => authorizationRequests.push(input)).pipe(
        Effect.andThen(
          input.action === "decline"
            ? Effect.die(new PermissionV2.DeclinedError())
            : input.action === "reject"
              ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
              : Effect.void,
        ),
      ),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)
const testSecrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(7), "test-authorization-aes-256-gcm")
const secretLayer = Layer.succeed(SecretProvider.Service, testSecrets)

const itEffect = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableAction.node,
      DurableRun.node,
      Authorizer.node,
      ActionGateway.node,
      ToolOutputStore.nodeWithoutConfig,
      FSUtil.node,
      Global.node,
    ]),
    [
      [PermissionV2.node, permissionLayer],
      [SecretProvider.node, secretLayer],
    ],
  ),
)

const semantics = (riskTier: AgentRuntime.RiskTier) =>
  AgentRuntime.EffectSemantics.make({
    riskTier,
    authority: ActionGateway.authorityFor(riskTier),
    idempotency: "idempotent",
    retryability: "safe",
    reversibility: "not_applicable",
    filesystemScope: [],
    networkScope: [],
    secretScope: [],
    externalServices: [],
    expectedArtifacts: [],
    successCriteria: ["operation returns"],
  })

const input = (riskTier: AgentRuntime.RiskTier) => {
  const context = {
    sessionID: SessionSchema.ID.create(),
    assistantMessageID: SessionMessage.ID.create(),
    toolCallID: `call-${riskTier}`,
  }
  return {
    ...context,
    actionID: ActionGateway.stableActionID(context),
    agent: AgentV2.ID.make("build"),
    name: `test_${riskTier}`,
    resources: ["test"],
    semantics: semantics(riskTier),
    reasonSummary: `test ${riskTier}`,
    inputDigest: `digest-${riskTier}`,
  }
}

describe("explicit approval refusal", () => {
  for (const tier of ["L2", "L3"] as const) {
    itEffect.effect(`preserves ${tier} human refusal and keeps its blocked action non-replayable`, () =>
      Effect.gen(function* () {
        authorizationRequests.length = 0
        const gateway = yield* ActionGateway.Service
        const durable = yield* DurableAction.Service
        const action = input(tier)
        let executions = 0
        const operation = {
          authorization: { requests: [{ action: "decline", resources: ["test"] }] },
          execute: () => Effect.sync(() => ++executions),
        }

        const refused = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) {
          expect(
            refused.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
            ),
          ).toBe(true)
        }
        const snapshot = yield* durable.load(action.actionID)
        expect(snapshot.action.status).toBe("blocked")
        expect(snapshot.action.budget.attemptsUsed).toBe(0)
        expect(snapshot.authorization).toBeUndefined()
        expect(snapshot.activeAttempt).toBeUndefined()
        expect(executions).toBe(0)
        expect(authorizationRequests).toHaveLength(1)

        const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(Exit.isFailure(replay)).toBe(true)
        expect(executions).toBe(0)
        expect(authorizationRequests).toHaveLength(1)
        expect((yield* durable.load(action.actionID)).action.status).toBe("blocked")
      }),
    )
  }

  itEffect.effect("keeps configured policy denial a typed blocked result", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const durable = yield* DurableAction.Service
      const action = input("L3")
      let executions = 0
      const error = yield* gateway
        .execute(action, {
          authorization: { requests: [{ action: "reject", resources: ["test"] }] },
          execute: () => Effect.sync(() => ++executions),
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ActionGateway.BlockedError)
      expect(executions).toBe(0)
      expect((yield* durable.load(action.actionID)).action.status).toBe("blocked")
    }),
  )
})

const sessionOf = (action: ActionGateway.Input) => ("sessionID" in action ? action.sessionID : undefined)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 1,
  maxDurationMs: 60_000,
  maxCostMicros: 0,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const sessionSubjectOf = (action: ActionGateway.Input) => {
  if (!("sessionID" in action)) throw new Error("expected a session input")
  return AgentRuntime.SessionSubject.make({
    type: "session",
    sessionID: action.sessionID,
    agent: action.agent.toString(),
    assistantMessageID: action.assistantMessageID,
    toolCallID: action.toolCallID,
  })
}

const seedPolicy = (action: ActionGateway.Input, decidedAt: DateTime.Utc) => {
  const subject = sessionSubjectOf(action)
  return {
    actionID: action.actionID,
    sessionID: sessionOf(action),
    subject,
    decision: AgentRuntime.PolicyDecision.make({
      actionID: action.actionID,
      subject,
      authority: action.semantics.authority,
      riskTier: action.semantics.riskTier,
      decision:
        action.semantics.authority === "forbidden"
          ? "deny"
          : action.semantics.authority === "automatic"
            ? "allow"
            : "ask",
      reason: action.reasonSummary,
      policyVersion: ActionGateway.POLICY_VERSION,
      decidedAt,
    }),
  }
}

const seededAction = (
  action: ActionGateway.Input,
  plan?: ActionGateway.AuthorizationPlan,
  actionBudget: AgentRuntime.Budget = budget,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    return AgentRuntime.SessionAction.make({
      id: action.actionID,
      ...(action.runID ? { runID: action.runID } : {}),
      ...(action.stepID ? { stepID: action.stepID } : {}),
      ...(action.parentActionID ? { parentActionID: action.parentActionID } : {}),
      sessionID: sessionOf(action)!,
      subject: sessionSubjectOf(action),
      name: action.name,
      status: "proposed" as const,
      semantics: action.semantics,
      resources: [...action.resources],
      idempotencyKey: action.actionID,
      intentDigest: ActionGateway.intentDigestOf(action, plan),
      initiator: "agent",
      authority: action.semantics.authority,
      riskTier: action.semantics.riskTier,
      reasonSummary: action.reasonSummary,
      budget: actionBudget,
      traceID: action.actionID,
      visibility: "details",
      time: { created: now, updated: now },
    })
  })

const seedExecuting = (
  action: ActionGateway.Input,
  plan?: ActionGateway.AuthorizationPlan,
  actionBudget: AgentRuntime.Budget = budget,
) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const now = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionProposed, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      action: yield* seededAction(action, plan, actionBudget),
    })
    yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, seedPolicy(action, now))
    for (const [from, to] of [
      ["proposed", "policy_evaluated"],
      ["policy_evaluated", "authorized"],
      ["authorized", "executing"],
    ] as const)
      yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
        actionID: action.actionID,
        sessionID: sessionOf(action),
        subject: sessionSubjectOf(action),
        from,
        to,
        reason: "simulated hard-crash boundary",
        changedAt: now,
      })
  })

const seedAutomaticWithPolicyVersion = (
  action: ActionGateway.Input,
  status: "authorized" | "executing",
  policyVersion: string,
) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const now = yield* DateTime.now
    const subject = sessionSubjectOf(action)
    yield* events.publish(AgentRuntime.Event.ActionProposed, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject,
      action: yield* seededAction(action),
    })
    yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject,
      decision: AgentRuntime.PolicyDecision.make({
        actionID: action.actionID,
        subject,
        authority: "automatic",
        riskTier: action.semantics.riskTier,
        decision: "allow",
        reason: "seed an action evaluated under an obsolete policy",
        policyVersion,
        decidedAt: now,
      }),
    })
    for (const [from, to] of [
      ["proposed", "policy_evaluated"],
      ["policy_evaluated", "authorized"],
      ...(status === "executing" ? ([["authorized", "executing"]] as const) : []),
    ] as const)
      yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
        actionID: action.actionID,
        sessionID: sessionOf(action),
        subject,
        from,
        to,
        reason: "seed recovery boundary",
        changedAt: now,
      })
  })

const seedAwaitingApproval = (action: ActionGateway.Input, plan?: ActionGateway.AuthorizationPlan) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const now = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionProposed, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      action: yield* seededAction(action, plan),
    })
    yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, seedPolicy(action, now))
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "proposed",
      to: "policy_evaluated",
      reason: "seed pending approval",
      changedAt: now,
    })
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "policy_evaluated",
      to: "awaiting_approval",
      reason: "seed pending approval",
      changedAt: now,
    })
  })

const reseedAuthorized = (
  action: ActionGateway.Input,
  grant: AgentRuntime.AuthorizationGrant,
  status: "awaiting_approval" | "authorized" | "executing",
  plan?: ActionGateway.AuthorizationPlan,
) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const now = yield* DateTime.now
    yield* events.remove(action.actionID)
    yield* events.publish(AgentRuntime.Event.ActionProposed, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      action: yield* seededAction(action, plan),
    })
    yield* events.publish(AgentRuntime.Event.ActionPolicyEvaluated, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      decision: AgentRuntime.PolicyDecision.make({
        actionID: action.actionID,
        subject: sessionSubjectOf(action),
        authority: action.semantics.authority,
        riskTier: action.semantics.riskTier,
        decision: "ask",
        reason: action.reasonSummary,
        policyVersion: ActionGateway.POLICY_VERSION,
        decidedAt: now,
      }),
    })
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "proposed",
      to: "policy_evaluated",
      reason: "seed recovery boundary",
      changedAt: now,
    })
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "policy_evaluated",
      to: "awaiting_approval",
      reason: "seed recovery boundary",
      changedAt: now,
    })
    yield* events.publish(AgentRuntime.Event.ActionAuthorizationGranted, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      grant,
    })
    if (status === "awaiting_approval") return
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "awaiting_approval",
      to: "authorized",
      reason: "seed recovery boundary",
      changedAt: now,
    })
    if (status === "authorized") return
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      actionID: action.actionID,
      sessionID: sessionOf(action),
      subject: sessionSubjectOf(action),
      from: "authorized",
      to: "executing",
      reason: "seed recovery boundary",
      changedAt: now,
    })
  })

const rebindGrantProof = (
  grant: AgentRuntime.AuthorizationGrant,
  mutate: (binding: Readonly<Record<string, unknown>>) => Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const plaintext = yield* testSecrets.unprotect(grant.proof)
    const parsed = JSON.parse(Buffer.from(plaintext).toString("utf8")) as Record<string, unknown>
    const { bindingDigest: _bindingDigest, issuedAt, expiresAt, ...binding } = parsed
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number")
      return yield* Effect.die(new Error("expected grant proof timestamps"))
    const changed = mutate(binding)
    const digest = createHash("sha256").update(JSON.stringify(changed)).digest("hex")
    const proof = yield* testSecrets.protect(
      Buffer.from(JSON.stringify({ ...changed, bindingDigest: digest, issuedAt, expiresAt }), "utf8"),
    )
    return AgentRuntime.AuthorizationGrant.make({ ...grant, bindingDigest: digest, proof })
  })

const replaceStoredGrant = (actionID: AgentRuntime.ActionID, grant: AgentRuntime.AuthorizationGrant) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({ id: EventTable.id, data: EventTable.data })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, actionID), eq(EventTable.type, "agent.action.authorization-granted.1")))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* Effect.die(new Error("expected durable authorization grant event"))
    const decoded = Schema.decodeUnknownSync(AgentRuntime.Event.ActionAuthorizationGranted.data)(row.data)
    const encoded = Schema.encodeSync(AgentRuntime.Event.ActionAuthorizationGranted.data)({ ...decoded, grant })
    yield* db.update(EventTable).set({ data: encoded }).where(eq(EventTable.id, row.id)).run().pipe(Effect.orDie)
  })

describe("ActionGateway", () => {
  itEffect.effect("model request binding rejects drift, stale contexts and tampered durable envelopes", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const model = Model.make({ id: "fixture-title", provider: "test", route: OpenAIChat.route })
      const envelope = TitleGeneration.prepare({ text: "Original title request", model, execution: {} })
      const changed = TitleGeneration.prepare({ text: "Changed title request", model, execution: {} })
      const action = { ...input("L0"), inputDigest: envelope.request_digest }
      let captured: ActionGateway.OperationExecutionContext | undefined
      yield* gateway.execute(action, {
        execute: (_, context) =>
          Effect.gen(function* () {
            if (!context) return yield* Effect.die("Missing Gateway context")
            captured = context
            yield* context.recordModelRequest(envelope)
            const before = yield* actions.load(action.actionID)
            expect(Exit.isFailure(yield* context.recordModelRequest(changed).pipe(Effect.exit))).toBe(true)
            expect((yield* actions.load(action.actionID)).lastSequence).toBe(before.lastSequence)
            return "done"
          }),
      })
      if (!captured) return yield* Effect.die("Missing captured context")
      const settled = yield* actions.load(action.actionID)
      expect(Exit.isFailure(yield* captured.recordModelRequest(envelope).pipe(Effect.exit))).toBe(true)
      expect((yield* actions.load(action.actionID)).lastSequence).toBe(settled.lastSequence)
      const row = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, action.actionID),
            eq(EventTable.type, "agent.action.model-request-prepared.1"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("Missing model request event")
      yield* db
        .update(EventTable)
        .set({ data: { ...row.data, envelope: requestEnvelopeJson(changed) } })
        .where(eq(EventTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
      const reloaded = yield* actions.load(action.actionID).pipe(Effect.exit)
      expect(Exit.isFailure(reloaded) && Cause.squash(reloaded.cause)).toMatchObject({
        _tag: "DurableAction.CorruptHistoryError",
      })
    }),
  )

  itEffect.effect("oversized model request is rejected before any request event or send", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const model = Model.make({ id: "fixture-title", provider: "test", route: OpenAIChat.route })
      const envelope = TitleGeneration.prepare({ text: "界".repeat(23_000), model, execution: {} })
      expect(requestEnvelopeJson(envelope).length).toBeLessThan(65_536)
      const action = { ...input("L0"), inputDigest: envelope.request_digest }
      let sends = 0
      const result = yield* gateway
        .execute(action, {
          execute: (_, context) =>
            Effect.gen(function* () {
              if (!context) return yield* Effect.die("Missing Gateway context")
              yield* context.recordModelRequest(envelope)
              sends++
            }),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(sends).toBe(0)
      expect((yield* actions.load(action.actionID)).modelRequest).toBeUndefined()
    }),
  )

  for (const titleText of ["Cache investigation", ""])
    itEffect.effect(
      `meters a real title component through Gateway for ${titleText ? "success" : "empty-output failure"}`,
      () =>
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const model = Model.make({
            id: "fixture-title",
            provider: "test",
            route: OpenAIChat.route.with({ endpoint: { baseURL: "https://fixture.invalid/v1" } }),
          })
          const common = TitleGeneration.prepare({ text: "Investigate cache invalidation", model, execution: {} })
          const request = rebuildRequest(common, model)
          const prepared = yield* LLMClient.prepare(request)
          const envelope = createRequestEnvelope({
            request,
            execution: common.execution,
            transmission: prepared.transmission,
          })
          const action = { ...input("L0"), inputDigest: envelope.request_digest }
          let reported: Usage | undefined
          let sends = 0
          const result = yield* gateway
            .execute(action, {
              estimatedTokens: 100,
              tokens: () => reported?.totalTokens,
              // Controlled in-memory provider fixture; explicitly known zero monetary cost.
              costMicros: () => 0,
              execute: (capability, context) =>
                TitleGeneration.generate({
                  envelope,
                  prepared,
                  model,
                  authorizeAndRecord: () =>
                    Effect.gen(function* () {
                      expect(ActionGateway.capabilityAuthority(capability)).toBe("automatic")
                      const before = yield* actions.load(action.actionID)
                      expect(before.action.status).toBe("executing")
                      expect(before.activeAttempt?.attempt).toBe(1)
                      if (!context) return yield* Effect.die("Missing Gateway execution context")
                      yield* context.recordModelRequest(envelope)
                      const recorded = yield* actions.load(action.actionID)
                      expect(recorded.modelRequest?.envelope).toBe(requestEnvelopeJson(envelope))
                      yield* context.recordModelRequest(envelope)
                      expect((yield* actions.load(action.actionID)).lastSequence).toBe(recorded.lastSequence)
                    }),
                  onUsage: (usage) => {
                    reported = usage
                  },
                  streamPrepared: () => {
                    sends++
                    return Stream.fromIterable([
                      LLMEvent.textDelta({ id: "title", text: titleText }),
                      LLMEvent.finish({ reason: "stop", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }),
                    ])
                  },
                }),
            })
            .pipe(Effect.exit)
          expect(Exit.isSuccess(result)).toBe(titleText.length > 0)
          const snapshot = yield* actions.load(action.actionID)
          expect(snapshot.action.budget.tokensUsed).toBe(15)
          expect(snapshot.action.budget.costMicrosUsed).toBe(0)
          expect(snapshot.observation?.status).toBe(titleText ? "succeeded" : "failed")
          expect(snapshot.activeAttempt).toBeUndefined()
          expect(sends).toBe(1)
        }),
    )

  it("keeps the exact legacy v1 intent fingerprint for read-only migration compatibility", () => {
    const action: ActionGateway.Input = {
      kind: "session",
      sessionID: SessionSchema.ID.make("ses_legacyfixture"),
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make("msg_legacyfixture"),
      toolCallID: "call-legacy",
      runID: AgentRuntime.RunID.make("run_legacyfixture"),
      stepID: AgentRuntime.StepID.make("stp_legacyfixture"),
      actionID: AgentRuntime.ActionID.make("act_legacyfixture"),
      name: "legacy.tool",
      resources: ["b", "a"],
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier: "L2",
        authority: "scoped_grant",
        idempotency: "idempotent",
        retryability: "safe",
        reversibility: "reversible",
        compensation: "undo",
        filesystemScope: ["/b", "/a"],
        networkScope: [],
        secretScope: [],
        externalServices: ["git"],
        expectedArtifacts: ["artifact"],
        successCriteria: ["ok"],
      }),
      reasonSummary: "legacy",
      inputDigest: "input-v1",
    }
    const plan: ActionGateway.AuthorizationPlan = {
      requests: [{ action: "edit", resources: ["b", "a"] }],
      metadata: { ignored: "v2-only" },
    }

    expect(ActionGateway.legacyIntentDigestV1Of(action, plan)).toBe(
      "c2da8b3df92835a64183b88f24dfeb0ba8f6480ea6512b7764300e7e4b3f298a",
    )
    expect(ActionGateway.legacyStableActionIDV1(action)).toBe(
      AgentRuntime.ActionID.make("act_2febebd38d1c32b17bb38b5652daa443"),
    )
    expect(ActionGateway.stableActionID(action)).not.toBe(ActionGateway.legacyStableActionIDV1(action))
    expect(ActionGateway.intentDigestOf(action, ActionGateway.canonicalPlan(plan))).not.toBe(
      ActionGateway.legacyIntentDigestV1Of(action, plan),
    )
  })

  itEffect.effect("cancels only an exact pending session action and never starts an attempt", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const action = input("L3")
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "bash", resources: ["opaque exact command"] }],
      }
      yield* seedAwaitingApproval(action, authorization)

      const mismatch = yield* gateway
        .cancelPendingAction(
          { ...action, assistantMessageID: SessionMessage.ID.create() },
          authorization,
          "mismatched caller must not cancel",
        )
        .pipe(Effect.exit)
      expect(String(mismatch)).toContain("ActionGateway.InvalidSubjectError")
      expect((yield* actions.load(action.actionID)).action.status).toBe("awaiting_approval")

      yield* gateway.cancelPendingAction(action, authorization, "user cancelled pending direct shell")
      expect((yield* actions.load(action.actionID)).action.status).toBe("cancelled")
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.some((row) => row.type === "agent.action.attempt-started.1")).toBe(false)
    }),
  )

  itEffect.effect("does not falsely cancel an executing action and blocks the authorized handoff from replay", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "bash", resources: ["opaque exact command"] }],
      }

      const executing = input("L0")
      yield* seedExecuting(executing, authorization)
      const tooLate = yield* gateway.cancelPendingAction(executing, authorization, "too late").pipe(Effect.exit)
      expect(String(tooLate)).toContain("ActionGateway.ActionInProgressError")
      expect((yield* actions.load(executing.actionID)).action.status).toBe("executing")

      const handoff = input("L0")
      yield* seedAwaitingApproval(handoff, authorization)
      const events = yield* EventV2.Service
      const now = yield* DateTime.now
      yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
        actionID: handoff.actionID,
        sessionID: sessionOf(handoff),
        subject: sessionSubjectOf(handoff),
        from: "awaiting_approval",
        to: "authorized",
        reason: "approval won cancellation race",
        changedAt: now,
      })
      const before = yield* gateway.cancelPendingAction(handoff, authorization, "too late").pipe(Effect.exit)
      expect(String(before)).toContain("ActionGateway.ActionInProgressError")
      yield* gateway.blockAuthorizedHandoff(handoff, authorization, "explicit cancel at uncertain handoff")
      expect((yield* actions.load(handoff.actionID)).action.status).toBe("blocked")
    }),
  )

  itEffect.effect("persists intent, policy, observation, and every state transition before settling", () =>
    Effect.gen(function* () {
      RuntimeInsight.reset()
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L0")

      const value = yield* gateway.execute(action, {
        execute: () => Effect.succeed("done"),
        successSummary: () => "test operation completed",
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(value).toBe("done")
      expect(rows.map((row) => row.type)).toEqual([
        "agent.action.proposed.1",
        "agent.action.lease-acquired.1",
        "agent.action.policy-evaluated.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.attempt-started.1",
        "agent.action.attempt-finished.1",
        "agent.action.observed.1",
        "agent.action.state-changed.1",
        "agent.action.state-changed.1",
        "agent.action.lease-released.1",
      ])
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      expect(RuntimeInsight.auditList(20).entries.some((entry) => entry.metadata.actionID === action.actionID)).toBe(
        true,
      )
    }),
  )

  itEffect.effect("hard-blocks L4 actions before their operation can run", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L4")
      let executed = false

      const exit = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(executed).toBe(false)
      expect(String(exit)).toContain("ActionGateway.BlockedError")
      expect(rows.findLast((row) => row.type === "agent.action.state-changed.1")?.data).toMatchObject({
        from: "policy_evaluated",
        to: "blocked",
      })
    }),
  )

  itEffect.effect("two live execute calls use one durable lease and only one reaches the executor", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const action = input("L0")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let executions = 0
      const operation = {
        execute: () =>
          Effect.sync(() => executions++).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as("done"),
          ),
      }
      const first = yield* gateway.execute(action, operation).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      const second = yield* gateway.execute(action, operation).pipe(Effect.exit)
      expect(second._tag).toBe("Failure")
      if (second._tag === "Failure") expect(String(second.cause)).toContain("ActionGateway.ActionInProgressError")
      expect(executions).toBe(1)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(first)).toBe("done")
    }),
  )

  itEffect.effect("blocks L2 and L3 operations that provide no enforceable permission gate", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      for (const tier of ["L2", "L3"] as const) {
        const action = input(tier)
        let executed = false
        const exit = yield* gateway
          .execute(action, {
            execute: () =>
              Effect.sync(() => {
                executed = true
              }),
          })
          .pipe(Effect.exit)

        expect(executed).toBe(false)
        expect(String(exit)).toContain("ActionGateway.BlockedError")
      }
    }),
  )

  itEffect.effect("rejects empty L2/L3 authorization plans before any durable event or permission request", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      let executions = 0
      const cases = [
        { action: input("L2"), authorization: { requests: [] } },
        {
          action: input("L3"),
          authorization: { requests: [{ action: "bash", resources: [] }] },
        },
      ] as const

      for (const item of cases) {
        const exit = yield* gateway
          .execute(item.action, {
            authorization: item.authorization,
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, item.action.actionID))
          .all()
          .pipe(Effect.orDie)

        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("ActionGateway.BlockedError")
        expect(rows).toHaveLength(0)
      }
      expect(authorizationRequests).toHaveLength(0)
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("never enters an L2 execution body when preflight authorization fails", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const action = input("L2")
      let executed = false

      const exit = yield* gateway
        .execute(action, {
          authorization: { requests: [{ action: "reject", resources: ["test"] }] },
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(executed).toBe(false)
      expect(String(exit)).toContain("ActionGateway.BlockedError")
      expect((yield* actions.load(action.actionID)).action.status).toBe("blocked")
      expect(rows.some((row) => row.type === "agent.action.attempt-started.1")).toBe(false)
      expect(RuntimeInsight.auditList(20).entries).toContainEqual(
        expect.objectContaining({
          action: "action.authorization.failed",
          metadata: expect.objectContaining({ actionID: action.actionID }),
        }),
      )
    }),
  )

  itEffect.effect("atomically preflights every request before any side effect starts", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L2")
      let executed = false

      const exit = yield* gateway
        .execute(action, {
          authorization: {
            requests: [
              { action: "edit", resources: ["alpha"] },
              { action: "reject", resources: ["beta"] },
            ],
          },
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      expect(executed).toBe(false)
      expect(String(exit)).toContain("ActionGateway.BlockedError")
      expect(rows.some((row) => row.type === "agent.action.attempt-started.1")).toBe(false)
      expect(authorizationRequests.map((request) => [request.action, request.resources])).toEqual([
        ["edit", ["alpha"]],
        ["reject", ["beta"]],
      ])
    }),
  )

  itEffect.effect("binds authorization identity and risk policy inside the gateway", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      let l2: ReturnType<typeof input> | undefined

      for (const tier of ["L2", "L3"] as const) {
        const action = input(tier)
        if (tier === "L2") l2 = action
        yield* gateway.execute(action, {
          authorization: {
            requests: [
              {
                action: tier === "L2" ? "edit" : "bash",
                resources: tier === "L2" ? ["zeta", "alpha", "zeta"] : ["scope-L3"],
              },
            ],
            metadata: { declaredBy: "test" },
          },
          execute: () => Effect.succeed("done"),
        })
      }

      expect(authorizationRequests).toHaveLength(2)
      expect(authorizationRequests[0]).toMatchObject({
        sessionID: expect.any(String),
        agent: "build",
        action: "edit",
        resources: ["alpha", "zeta"],
        save: ["alpha", "zeta"],
        metadata: { declaredBy: "test" },
        source: { type: "tool", callID: "call-L2" },
      })
      expect(authorizationRequests[0]?.forceAsk).toBeUndefined()
      expect(authorizationRequests[1]).toMatchObject({
        sessionID: expect.any(String),
        agent: "build",
        action: "bash",
        resources: ["scope-L3"],
        forceAsk: true,
        metadata: { declaredBy: "test" },
        source: { type: "tool", callID: "call-L3" },
      })
      expect(authorizationRequests[1]?.save).toBeUndefined()
      if (!l2) throw new Error("missing L2 action")
      const snapshot = yield* actions.load(l2.actionID)
      expect(snapshot.authorization).toMatchObject({
        actionID: l2.actionID,
        sessionID: l2.sessionID,
        agent: l2.agent,
        toolCallID: l2.toolCallID,
        toolName: l2.name,
        requests: [{ action: "edit", resources: ["alpha", "zeta"] }],
        policyVersion: ActionGateway.POLICY_VERSION,
        proofProvider: "test-authorization-aes-256-gcm",
      })
      expect(snapshot.authorization?.proof).not.toContain(l2.actionID)
      if (!snapshot.authorization) return yield* Effect.die(new Error("missing authorization grant"))
      const protectedBinding = JSON.parse(
        Buffer.from(yield* testSecrets.unprotect(snapshot.authorization.proof)).toString("utf8"),
      ) as Record<string, unknown>
      expect(protectedBinding.domain).toBe("arforge.authorization-grant/v2")
      expect(protectedBinding.intentDigest).toBe(
        ActionGateway.intentDigestOf(l2, {
          requests: [{ action: "edit", resources: ["alpha", "zeta"] }],
          metadata: { declaredBy: "test" },
        }),
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, l2.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const granted = rows.findIndex((row) => row.type === "agent.action.authorization-granted.1")
      const authorized = rows.findIndex(
        (row) => row.type === "agent.action.state-changed.1" && (row.data as { to?: string }).to === "authorized",
      )
      expect(granted).toBeGreaterThan(-1)
      expect(authorized).toBeGreaterThan(granted)
    }),
  )

  itEffect.effect("validates delegation parent identity and lifecycle without changing durable state", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const runID = AgentRuntime.RunID.make("run_delegation_parent_fixture")
      const action = { ...input("L0"), runID }
      const request = { actionID: action.actionID, runID, subject: sessionSubjectOf(action), toolName: action.name }
      yield* gateway.execute(action, {
        execute: () => gateway.validateDelegationParent(request).pipe(Effect.as("done")),
      })
      const before = yield* actions.load(action.actionID)
      yield* gateway.validateDelegationParent(request)
      for (const invalid of [
        { ...request, runID: AgentRuntime.RunID.make("run_other") },
        { ...request, toolName: "other" },
        { ...request, subject: { ...request.subject, toolCallID: "other" } },
        { ...request, subject: { ...request.subject, assistantMessageID: "msg_other" } },
      ]) {
        expect(Exit.isFailure(yield* gateway.validateDelegationParent(invalid).pipe(Effect.exit))).toBe(true)
      }
      expect(yield* actions.load(action.actionID)).toEqual(before)
      const failed = { ...input("L0"), runID }
      yield* gateway.execute(failed, { execute: () => Effect.fail("fixture failure") }).pipe(Effect.exit)
      expect(
        Exit.isFailure(
          yield* gateway
            .validateDelegationParent({
              actionID: failed.actionID,
              runID,
              subject: sessionSubjectOf(failed),
              toolName: failed.name,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const orphaned = { ...input("L0"), runID }
      yield* seedExecuting(orphaned)
      expect(
        Exit.isFailure(
          yield* gateway
            .validateDelegationParent({
              actionID: orphaned.actionID,
              runID,
              subject: sessionSubjectOf(orphaned),
              toolName: orphaned.name,
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  itEffect.effect("delegation parent revalidates the protected grant and refuses expiry", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const runID = AgentRuntime.RunID.make("run_granted_parent_fixture")
      const action = { ...input("L2"), runID }
      const request = { actionID: action.actionID, runID, subject: sessionSubjectOf(action), toolName: action.name }
      yield* gateway.execute(action, {
        authorization: { requests: [{ action: "read", resources: ["fixture"] }] },
        execute: () => gateway.validateDelegationParent(request).pipe(Effect.as("done")),
      })
      const snapshot = yield* actions.load(action.actionID)
      if (!snapshot.authorization) return yield* Effect.die("fixture grant was not created")
      yield* gateway.validateDelegationParent(request)
      const now = yield* DateTime.now
      yield* TestClock.adjust(
        DateTime.toEpochMillis(snapshot.authorization.expiresAt) - DateTime.toEpochMillis(now) + 1,
      )
      expect(Exit.isFailure(yield* gateway.validateDelegationParent(request).pipe(Effect.exit))).toBe(true)
      expect(yield* actions.load(action.actionID)).toEqual(snapshot)
    }),
  )

  itEffect.effect("does not consult permissions for automatic actions", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      yield* gateway.execute(input("L0"), {
        authorization: { requests: [{ action: "unexpected", resources: ["*"] }] },
        execute: () => Effect.succeed("done"),
      })
      expect(authorizationRequests).toHaveLength(0)
    }),
  )

  itEffect.effect("records token usage durably and does not charge a settled replay twice", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let calls = 0
      const operation = {
        estimatedTokens: 100,
        tokens: () => 58,
        execute: () =>
          Effect.sync(() => {
            calls++
            return "done"
          }),
        durableResult: {
          encode: (value: string) => value,
          decode: (value: unknown) => Schema.decodeUnknownSync(Schema.String)(value),
        },
      }
      yield* gateway.execute(action, operation)
      expect((yield* actions.load(action.actionID)).action.budget.tokensUsed).toBe(58)
      yield* gateway.execute(action, operation)
      expect((yield* actions.load(action.actionID)).action.budget.tokensUsed).toBe(58)
      expect(calls).toBe(1)
    }),
  )

  itEffect.effect("records usage after a failed operation without replacing its original failure", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      const failure = new Error("provider returned usage and failed")
      let measurements = 0
      const result = yield* gateway
        .execute(action, {
          tokens: () => {
            measurements++
            return 17
          },
          costMicros: () => 9,
          execute: () => Effect.fail(failure),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(failure)
      const snapshot = yield* actions.load(action.actionID)
      expect(snapshot.action.budget.tokensUsed).toBe(17)
      expect(snapshot.action.budget.costMicrosUsed).toBe(9)
      expect(snapshot.observation?.status).toBe("failed")
      expect(measurements).toBe(1)
    }),
  )

  itEffect.effect("records usage after interrupted cleanup while preserving interruption", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      const ready = yield* Deferred.make<void>()
      let cleaned = false
      const fiber = yield* gateway
        .execute(action, {
          tokens: () => {
            expect(cleaned).toBe(true)
            return 13
          },
          costMicros: () => 7,
          execute: () =>
            Deferred.succeed(ready, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            ),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
      const snapshot = yield* actions.load(action.actionID)
      expect({
        cleaned,
        budget: snapshot.action.budget,
        status: snapshot.action.status,
        observation: snapshot.observation?.status,
      }).toMatchObject({ cleaned: true, budget: { tokensUsed: 13 }, observation: "interrupted" })
      expect(snapshot.action.budget.costMicrosUsed).toBe(7)
      expect(snapshot.observation?.status).toBe("interrupted")
      expect(snapshot.activeAttempt).toBeUndefined()
    }),
  )

  itEffect.effect("blocks an action before execution when its token estimate exceeds budget", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let calls = 0
      const result = yield* gateway
        .execute(input("L0"), {
          estimatedTokens: AgentRuntime.DEFAULT_MAX_TOKENS + 1,
          execute: () =>
            Effect.sync(() => {
              calls++
            }),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toBe(0)
    }),
  )

  itEffect.effect("unknown failed-call cost stays absent and blocks reconciliation without hiding the failure", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const action = input("L0")
      const failure = new Error("fixture missing provider receipt")
      const result = yield* gateway
        .execute(action, {
          tokens: () => 8,
          costMicros: () => undefined,
          execute: () => Effect.fail(failure),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(failure)
      const snapshot = yield* actions.load(action.actionID)
      expect(snapshot.action.status).toBe("blocked")
      expect(snapshot.action.budget.tokensUsed).toBe(8)
      expect(snapshot.observation).toBeUndefined()
      const row = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(eq(EventTable.aggregate_id, action.actionID), eq(EventTable.type, "agent.action.attempt-finished.1")),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die("Missing persisted attempt finish")
      expect(Object.hasOwn(row.data, "costMicros")).toBe(false)
    }),
  )

  itEffect.effect("interrupted operation cleanup defects remain visible during usage settlement", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const action = input("L0")
      const ready = yield* Deferred.make<void>()
      const defect = new Error("fixture cleanup defect")
      const fiber = yield* gateway
        .execute(action, {
          tokens: () => 3,
          execute: () =>
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die(defect))),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(false)
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("fixture cleanup defect")
    }),
  )

  for (const estimate of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    itEffect.effect(`rejects invalid token estimate ${estimate} before execution`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        let calls = 0
        const result = yield* gateway
          .execute(input("L0"), {
            estimatedTokens: estimate,
            execute: () =>
              Effect.sync(() => {
                calls++
              }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(calls).toBe(0)
      }),
    )

  itEffect.effect("invalid measured token usage blocks replay instead of fabricating successful settlement", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let calls = 0
      const operation = {
        estimatedTokens: 100,
        tokens: () => NaN,
        execute: () =>
          Effect.sync(() => {
            calls++
            return "done"
          }),
      }
      expect(Exit.isFailure(yield* gateway.execute(action, operation).pipe(Effect.exit))).toBe(true)
      const snapshot = yield* actions.load(action.actionID)
      expect(snapshot.action.status).toBe("blocked")
      expect(snapshot.observation).toBeUndefined()
      expect(snapshot.activeAttempt).toBeUndefined()
      expect(Exit.isFailure(yield* gateway.execute(action, operation).pipe(Effect.exit))).toBe(true)
      expect(calls).toBe(1)
    }),
  )

  itEffect.effect("blocks an action before execution when its declared cost exceeds budget", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const action = input("L0")
      let executed = false

      const exit = yield* gateway
        .execute(action, {
          estimatedCostMicros: 1,
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)

      expect(executed).toBe(false)
      expect(String(exit)).toContain("ActionGateway.RecoveryRequiredError")
    }),
  )

  itEffect.effect("folds measured attempt duration and cost into the durable action budget", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")

      yield* gateway.execute(action, {
        execute: () =>
          Effect.sync(() => {
            const until = Date.now() + 2
            while (Date.now() < until) {
              // Keep the real clock moving so the durable duration fold can be asserted.
            }
            return "done"
          }),
        costMicros: () => 25,
      })
      const snapshot = yield* actions.load(action.actionID)

      expect(snapshot.action.budget.durationMsUsed).toBeGreaterThanOrEqual(0)
      expect(snapshot.action.budget.costMicrosUsed).toBe(25)
    }),
  )

  itEffect.effect("records failed observations and preserves the original typed failure", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L0")

      const exit = yield* gateway.execute(action, { execute: () => Effect.fail("expected failure") }).pipe(Effect.exit)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const observed = rows.find((row) => row.type === "agent.action.observed.1")

      expect(String(exit)).toContain("expected failure")
      expect(observed?.data).toMatchObject({ observation: { status: "failed" } })
      expect(rows.findLast((row) => row.type === "agent.action.state-changed.1")?.data).toMatchObject({
        from: "observed",
        to: "blocked",
      })
    }),
  )

  itEffect.effect("does not treat public permission events as authorization capabilities", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const action = input("L2")
      let executed = false

      yield* events.publish(PermissionV2.Event.Asked, {
        id: PermissionV2.ID.create(),
        sessionID: action.sessionID,
        action: "edit",
        resources: ["test"],
        source: { type: "tool", messageID: action.assistantMessageID, callID: action.toolCallID },
      })
      const exit = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)

      expect(executed).toBe(false)
      expect(String(exit)).toContain("ActionGateway.BlockedError")
    }),
  )

  itEffect.effect("records trusted authorization before the first side effect", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      let statusBeforeSideEffect: AgentRuntime.ActionStatus | undefined

      yield* gateway.execute(action, {
        authorization: { requests: [{ action: "edit", resources: ["test"] }] },
        execute: () =>
          Effect.gen(function* () {
            statusBeforeSideEffect = (yield* actions.load(action.actionID)).action.status
            return "done"
          }),
      })

      expect(statusBeforeSideEffect).toBe("executing")
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("recovers awaiting, authorized, and safely retryable executing actions with a valid grant", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "edit", resources: ["beta", "alpha", "beta"] }],
      }

      yield* gateway.execute(action, { authorization, execute: () => Effect.succeed("issued") })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) throw new Error("authorization grant was not persisted")

      for (const status of ["awaiting_approval", "authorized", "executing"] as const) {
        yield* reseedAuthorized(action, grant, status, authorization)
        let executions = 0
        const value = yield* gateway.execute(action, {
          authorization,
          execute: () =>
            Effect.sync(() => {
              executions += 1
              return status
            }),
        })
        expect(value).toBe(status)
        expect(executions).toBe(1)
        expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
      }

      const base = input("L2")
      const runID = AgentRuntime.RunID.create()
      const runBound = {
        ...base,
        runID,
        actionID: ActionGateway.stableActionID({ ...base, runID }),
      }
      yield* gateway.execute(runBound, { authorization, execute: () => Effect.succeed("issued") })
      const runGrant = (yield* actions.load(runBound.actionID)).authorization
      if (!runGrant) throw new Error("run-bound authorization grant was not persisted")
      yield* reseedAuthorized(runBound, runGrant, "authorized", authorization)
      const permissionCount = authorizationRequests.length
      let replayExecutions = 0
      const resumed = yield* gateway
        .execute(
          { ...runBound, assistantMessageID: SessionMessage.ID.create() },
          {
            authorization,
            execute: () =>
              Effect.sync(() => {
                replayExecutions += 1
              }),
          },
        )
        .pipe(Effect.exit)
      expect(String(resumed)).toContain("ActionGateway.ActionIntentMismatchError")
      expect(authorizationRequests).toHaveLength(permissionCount)
      expect(replayExecutions).toBe(0)
    }),
  )

  itEffect.effect("rejects expired, tampered, and cross-identity authorization grant replay", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "edit", resources: ["alpha", "beta"] }],
      }

      yield* gateway.execute(action, { authorization, execute: () => Effect.succeed("issued") })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) throw new Error("authorization grant was not persisted")

      const cases: ReadonlyArray<{
        readonly name: string
        readonly seededAction?: ReturnType<typeof input>
        readonly resumedInput?: ReturnType<typeof input>
        readonly resumedAuthorization?: ActionGateway.AuthorizationPlan
        readonly grant?: AgentRuntime.AuthorizationGrant
        readonly expect: string
      }> = [
        {
          name: "expired",
          grant: AgentRuntime.AuthorizationGrant.make({
            ...grant,
            expiresAt: DateTime.makeUnsafe(Date.now() - 1),
          }),
          expect: "RecoveryRequiredError",
        },
        {
          name: "policy-version",
          grant: AgentRuntime.AuthorizationGrant.make({ ...grant, policyVersion: "arforge-risk/obsolete" }),
          expect: "RecoveryRequiredError",
        },
        {
          name: "agent",
          resumedInput: { ...action, agent: AgentV2.ID.make("reviewer") },
          expect: "ActionIntentMismatchError",
        },
        {
          name: "assistant-message",
          resumedInput: { ...action, assistantMessageID: SessionMessage.ID.create() },
          expect: "ActionIntentMismatchError",
        },
        {
          name: "tool-call",
          resumedInput: { ...action, toolCallID: "call-replayed" },
          expect: "ActionIntentMismatchError",
        },
        {
          name: "permission-action",
          resumedAuthorization: { ...authorization, requests: [{ action: "bash", resources: ["alpha", "beta"] }] },
          expect: "ActionIntentMismatchError",
        },
        {
          name: "permission-resource",
          resumedAuthorization: { ...authorization, requests: [{ action: "edit", resources: ["alpha", "gamma"] }] },
          expect: "ActionIntentMismatchError",
        },
        {
          name: "action",
          seededAction: (() => {
            const next = input("L2")
            return { ...next, sessionID: action.sessionID, name: action.name }
          })(),
          expect: "RecoveryRequiredError",
        },
      ]

      for (const item of cases) {
        const seeded = item.seededAction ?? action
        yield* reseedAuthorized(seeded, item.grant ?? grant, "authorized", authorization)
        let executions = 0
        const exit = yield* gateway
          .execute(item.resumedInput ?? seeded, {
            authorization: item.resumedAuthorization ?? authorization,
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        expect(executions, item.name).toBe(0)
        expect(String(exit), item.name).toContain(
          item.name === "policy-version" || item.name === "action"
            ? "DurableAction.CorruptHistoryError"
            : `ActionGateway.${item.expect}`,
        )
      }
    }),
  )

  itEffect.effect("rejects automatic recovery evaluated under an obsolete policy before any new side effect", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service

      for (const status of ["authorized", "executing"] as const) {
        const action = input("L0")
        yield* seedAutomaticWithPolicyVersion(action, status, "arforge-risk/obsolete")
        const before = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, action.actionID))
          .all()
          .pipe(Effect.orDie)
        let executions = 0

        const exit = yield* gateway
          .execute(action, {
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        const after = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, action.actionID))
          .all()
          .pipe(Effect.orDie)

        expect(String(exit), status).toContain("ActionGateway.RecoveryRequiredError")
        expect(executions, status).toBe(0)
        expect(after, status).toHaveLength(before.length)
        expect(
          after.some((row) => row.type === "agent.action.attempt-started.1"),
          status,
        ).toBe(false)
      }
      expect(authorizationRequests).toHaveLength(0)
    }),
  )

  itEffect.effect("keeps the grant digest stable when canonical requests are reordered", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [
          { action: "bash", resources: ["npm test"] },
          { action: "edit", resources: ["src/a.ts"] },
        ],
      }
      yield* gateway.execute(action, { authorization, execute: () => Effect.succeed("issued") })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) throw new Error("authorization grant was not persisted")
      yield* reseedAuthorized(action, grant, "authorized", authorization)
      const resumed = yield* gateway.execute(action, {
        authorization: {
          requests: [
            { action: "edit", resources: ["src/a.ts"] },
            { action: "bash", resources: ["npm test"] },
          ],
        },
        execute: () => Effect.succeed("resumed"),
      })
      expect(resumed).toBe("resumed")
    }),
  )

  itEffect.effect("fails recovery when a canonical request is deleted, added, or mutated", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [
          { action: "edit", resources: ["alpha", "beta"] },
          { action: "bash", resources: ["cmd"] },
        ],
      }
      yield* gateway.execute(action, { authorization, execute: () => Effect.succeed("issued") })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) throw new Error("authorization grant was not persisted")

      const variants: ReadonlyArray<{ name: string; plan: ActionGateway.AuthorizationPlan }> = [
        { name: "deleted", plan: { requests: [{ action: "edit", resources: ["alpha", "beta"] }] } },
        {
          name: "added",
          plan: {
            requests: [
              { action: "edit", resources: ["alpha", "beta"] },
              { action: "bash", resources: ["cmd"] },
              { action: "webfetch", resources: ["*"] },
            ],
          },
        },
        {
          name: "mutated",
          plan: {
            requests: [
              { action: "edit", resources: ["alpha"] },
              { action: "bash", resources: ["cmd"] },
            ],
          },
        },
        { name: "replaced", plan: { requests: [{ action: "write", resources: ["alpha", "beta"] }] } },
      ]
      for (const variant of variants) {
        yield* reseedAuthorized(action, grant, "authorized", authorization)
        let executions = 0
        const exit = yield* gateway
          .execute(action, {
            authorization: variant.plan,
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        expect(executions, variant.name).toBe(0)
        // The changed canonical intent is rejected before recovery can
        // validate any grant: no permission request, no attempt, no replay.
        expect(String(exit), variant.name).toContain("ActionGateway.ActionIntentMismatchError")
      }
    }),
  )

  itEffect.effect("inherits a validated parent grant without a second permission request", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = input("L2")
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const parentGrant = (yield* actions.load(parent.actionID)).authorization
      if (!parentGrant) throw new Error("parent authorization grant was not persisted")
      expect(authorizationRequests).toHaveLength(1)

      const childInput = {
        ...input("L2"),
        sessionID: parent.sessionID,
        assistantMessageID: parent.assistantMessageID,
        actionID: ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: "github",
          tool: "list_issues",
          argsDigest: "abc",
          invocation: "call-1",
        }),
        parentActionID: parent.actionID,
        name: "github_list_issues",
        resources: ["github_list_issues", "github", "list_issues", "args:abc"],
      }
      const child = yield* gateway.execute(childInput, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () => Effect.succeed("child"),
      })
      expect(child).toBe("child")
      expect(authorizationRequests).toHaveLength(1)

      const snapshot = yield* actions.load(childInput.actionID)
      expect(snapshot.action.parentActionID).toBe(parent.actionID)
      expect(snapshot.authorization).toMatchObject({
        parentActionID: parent.actionID,
        parentGrantID: parentGrant.id,
        requests: [{ action: "github_list_issues", resources: ["*"] }],
      })

      yield* reseedAuthorized(childInput, snapshot.authorization!, "authorized", {
        requests: [{ action: "github_list_issues", resources: ["*"] }],
      })
      let executions = 0
      const resumed = yield* gateway.execute(childInput, {
        authorization: { requests: [{ action: "github_list_issues", resources: ["*"] }] },
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "resumed-child"
          }),
      })
      expect(resumed).toBe("resumed-child")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("revalidates child run capabilities at the ActionGateway boundary", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const durableRuns = yield* DurableRun.Service
      const parentInput = input("L0")
      const parent = yield* durableRuns.create({
        sessionID: parentInput.sessionID,
        initiator: "agent",
        authority: "automatic",
        riskTier: "L1",
        reasonSummary: "gateway child parent",
        budget,
        traceID: "gateway-child-parent",
        visibility: "details",
        project: Project.ID.global,
        location: AbsolutePath.make("E:/gateway-child"),
        delegableCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
      })
      yield* durableRuns.transition({ runID: parent.run.id, to: "preflight", reason: "gateway child preflight" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "queued", reason: "gateway child queued" })
      yield* durableRuns.transition({ runID: parent.run.id, to: "running", reason: "gateway child running" })
      const child = yield* durableRuns.createChild({
        parentRunID: parent.run.id,
        sessionID: parentInput.sessionID,
        idempotencyKey: "gateway-child",
        delegatedObjective: "read workspace",
        allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
        project: Project.ID.global,
        location: AbsolutePath.make("E:/gateway-child"),
        expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "gateway" },
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "gateway child",
        budget,
        traceID: "gateway-child",
        parentTraceID: parent.run.traceID,
        visibility: "details",
      })
      yield* durableRuns.transition({ runID: child.run.id, to: "preflight", reason: "gateway child preflight" })
      yield* durableRuns.transition({ runID: child.run.id, to: "queued", reason: "gateway child queued" })
      yield* durableRuns.transition({ runID: child.run.id, to: "running", reason: "gateway child running" })

      const read = {
        ...parentInput,
        runID: child.run.id,
        actionID: ActionGateway.stableActionID({
          runID: child.run.id,
          sessionID: parentInput.sessionID,
          assistantMessageID: parentInput.assistantMessageID,
          toolCallID: parentInput.toolCallID,
        }),
        name: "read",
        resources: ["workspace"],
      }
      expect(yield* gateway.execute(read, { execute: () => Effect.succeed("read") })).toBe("read")

      const write = {
        ...read,
        actionID: ActionGateway.stableActionID({
          runID: child.run.id,
          sessionID: parentInput.sessionID,
          assistantMessageID: parentInput.assistantMessageID,
          toolCallID: "call-child-write",
        }),
        toolCallID: "call-child-write",
        name: "write",
      }
      const blocked = yield* gateway
        .execute(write, {
          authorization: { requests: [{ action: "write", resources: ["workspace"] }] },
          execute: () => Effect.succeed("must not execute"),
        })
        .pipe(Effect.exit)
      expect(String(blocked)).toContain("ActionGateway.BlockedError")
    }),
  )

  itEffect.effect("runs its own atomic preflight when the child scope exceeds the parent grant", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = input("L2")
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "edit", resources: ["src"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const childInput = {
        ...input("L2"),
        sessionID: parent.sessionID,
        assistantMessageID: parent.assistantMessageID,
        actionID: ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: "local",
          tool: "edit",
          argsDigest: "def",
          invocation: "call-1",
        }),
        parentActionID: parent.actionID,
        name: "edit",
      }
      yield* gateway.execute(childInput, {
        authorization: { requests: [{ action: "edit", resources: ["src", "lib"] }] },
        execute: () => Effect.succeed("child"),
      })
      expect(authorizationRequests).toHaveLength(2)
      expect(authorizationRequests[1]).toMatchObject({ action: "edit", resources: ["lib", "src"] })
      expect((yield* actions.load(childInput.actionID)).authorization?.parentGrantID).toBeUndefined()
    }),
  )

  itEffect.effect("fails closed when the parent grant is expired, forged, or missing", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = input("L2")
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "edit", resources: ["src"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const parentGrant = (yield* actions.load(parent.actionID)).authorization
      if (!parentGrant) throw new Error("parent authorization grant was not persisted")

      const invalidVariants: ReadonlyArray<{ name: string; grant: AgentRuntime.AuthorizationGrant | undefined }> = [
        {
          name: "expired",
          grant: AgentRuntime.AuthorizationGrant.make({
            ...parentGrant,
            expiresAt: DateTime.makeUnsafe(Date.now() - 1),
          }),
        },
        {
          name: "forged",
          grant: AgentRuntime.AuthorizationGrant.make({ ...parentGrant, policyVersion: "arforge-risk/obsolete" }),
        },
        { name: "missing", grant: undefined },
      ]
      for (const variant of invalidVariants) {
        if (variant.grant)
          yield* reseedAuthorized(parent, variant.grant, "authorized", {
            requests: [{ action: "edit", resources: ["src"] }],
          })
        else
          yield* reseedAuthorized(parent, parentGrant, "authorized", {
            requests: [{ action: "edit", resources: ["src"] }],
          }).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const { db } = yield* Database.Service
                yield* db
                  .delete(EventTable)
                  .where(
                    and(
                      eq(EventTable.aggregate_id, parent.actionID),
                      eq(EventTable.type, EventV2.versionedType(AgentRuntime.Event.ActionAuthorizationGranted.type, 1)),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
              }),
            ),
          )
        const childInput = {
          ...input("L2"),
          sessionID: parent.sessionID,
          assistantMessageID: parent.assistantMessageID,
          actionID: ActionGateway.stableChildActionID({
            parentActionID: parent.actionID,
            server: "local",
            tool: "edit",
            argsDigest: variant.name,
            invocation: "call-1",
          }),
          parentActionID: parent.actionID,
          name: "edit",
        }
        let executed = false
        const exit = yield* gateway
          .execute(childInput, {
            authorization: { requests: [{ action: "edit", resources: ["src"] }] },
            execute: () =>
              Effect.sync(() => {
                executed = true
              }),
          })
          .pipe(Effect.exit)
        expect(executed, variant.name).toBe(false)
        expect(String(exit), variant.name).toContain("ActionGateway.BlockedError")
        if (variant.name === "forged" || variant.name === "missing") {
          const child = yield* actions.load(childInput.actionID).pipe(Effect.exit)
          expect(String(child)).toContain("DurableAction.NotFoundError")
        } else {
          expect((yield* actions.load(childInput.actionID)).action.status, variant.name).toBe("blocked")
        }
      }
      // The broken parent chain was never laundered: no child permission
      // request was created and no child executor ran.
      expect(authorizationRequests).toHaveLength(1)
    }),
  )

  itEffect.effect("rejects v1 and single-field-tampered parent proofs before child authorization or execution", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const parentAuthorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "edit", resources: ["src"] }],
      }
      const variants: ReadonlyArray<{
        readonly name: string
        readonly mutate: (binding: Readonly<Record<string, unknown>>) => Record<string, unknown>
      }> = [
        { name: "v1-domain", mutate: (binding) => ({ ...binding, domain: "arforge.authorization-grant/v1" }) },
        { name: "intent-digest", mutate: (binding) => ({ ...binding, intentDigest: "forged-intent" }) },
        {
          name: "assistant-message",
          mutate: (binding) => ({ ...binding, assistantMessageID: SessionMessage.ID.create() }),
        },
        {
          name: "protected-requests",
          mutate: (binding) => ({ ...binding, requests: [{ action: "edit", resources: ["other"] }] }),
        },
      ]

      for (const variant of variants) {
        const parent = input("L2")
        yield* gateway.execute(parent, {
          authorization: parentAuthorization,
          execute: () => Effect.succeed("parent"),
        })
        const parentGrant = (yield* actions.load(parent.actionID)).authorization
        if (!parentGrant) return yield* Effect.die(new Error("parent authorization grant was not persisted"))
        const forgedGrant = yield* rebindGrantProof(parentGrant, variant.mutate)
        yield* replaceStoredGrant(parent.actionID, forgedGrant)
        // The durable reducer deliberately treats the encrypted proof as
        // opaque. The gateway must authenticate and bind it before inheritance.
        expect((yield* actions.load(parent.actionID)).action.status, variant.name).toBe("settled")

        const childInput = {
          ...input("L2"),
          sessionID: parent.sessionID,
          assistantMessageID: parent.assistantMessageID,
          actionID: ActionGateway.stableChildActionID({
            parentActionID: parent.actionID,
            server: "local",
            tool: "edit",
            argsDigest: variant.name,
            invocation: "call-1",
          }),
          parentActionID: parent.actionID,
          name: "edit",
        }
        const permissionCount = authorizationRequests.length
        let executions = 0
        const exit = yield* gateway
          .execute(childInput, {
            authorization: parentAuthorization,
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        const childRows = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, childInput.actionID))
          .all()
          .pipe(Effect.orDie)

        expect(String(exit), variant.name).toContain("ActionGateway.BlockedError")
        expect(authorizationRequests, variant.name).toHaveLength(permissionCount)
        expect(
          childRows.some((row) => row.type === "agent.action.attempt-started.1"),
          variant.name,
        ).toBe(false)
        expect(executions, variant.name).toBe(0)
      }
    }),
  )

  itEffect.effect("revalidates the complete parent v2 contract before resuming an inherited child grant", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const authorization: ActionGateway.AuthorizationPlan = {
        requests: [{ action: "edit", resources: ["src"] }],
      }
      const variants: ReadonlyArray<{
        readonly name: string
        readonly mutate: (binding: Readonly<Record<string, unknown>>) => Record<string, unknown>
      }> = [
        { name: "v1-domain", mutate: (binding) => ({ ...binding, domain: "arforge.authorization-grant/v1" }) },
        { name: "tool-name", mutate: (binding) => ({ ...binding, toolName: "forged-parent-tool" }) },
      ]

      for (const variant of variants) {
        const parent = input("L2")
        yield* gateway.execute(parent, { authorization, execute: () => Effect.succeed("parent") })
        const childInput = {
          ...input("L2"),
          sessionID: parent.sessionID,
          assistantMessageID: parent.assistantMessageID,
          actionID: ActionGateway.stableChildActionID({
            parentActionID: parent.actionID,
            server: "local",
            tool: "edit",
            argsDigest: `resume-${variant.name}`,
            invocation: "call-1",
          }),
          parentActionID: parent.actionID,
          name: "edit",
        }
        yield* gateway.execute(childInput, { authorization, execute: () => Effect.succeed("child") })
        const parentGrant = (yield* actions.load(parent.actionID)).authorization
        const childGrant = (yield* actions.load(childInput.actionID)).authorization
        if (!parentGrant || !childGrant)
          return yield* Effect.die(new Error("expected parent and inherited child grants"))
        expect(childGrant.parentGrantID, variant.name).toBe(parentGrant.id)

        yield* replaceStoredGrant(parent.actionID, yield* rebindGrantProof(parentGrant, variant.mutate))
        yield* reseedAuthorized(childInput, childGrant, "authorized", authorization)
        const permissionCount = authorizationRequests.length
        let executions = 0
        const exit = yield* gateway
          .execute(childInput, {
            authorization,
            execute: () =>
              Effect.sync(() => {
                executions += 1
              }),
          })
          .pipe(Effect.exit)
        const childRows = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, childInput.actionID))
          .all()
          .pipe(Effect.orDie)

        expect(String(exit), variant.name).toContain("ActionGateway.RecoveryRequiredError")
        expect(authorizationRequests, variant.name).toHaveLength(permissionCount)
        expect(
          childRows.some((row) => row.type === "agent.action.attempt-started.1"),
          variant.name,
        ).toBe(false)
        expect(executions, variant.name).toBe(0)
      }
    }),
  )

  itEffect.effect("caps the child action budget at the parent's remaining allowance", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const parent = {
        ...input("L2"),
        semantics: AgentRuntime.EffectSemantics.make({
          ...input("L2").semantics,
          retryability: "never",
        }),
      }
      yield* gateway.execute(parent, {
        authorization: { requests: [{ action: "edit", resources: ["src"] }] },
        execute: () => Effect.succeed("parent"),
      })
      const parentSnapshot = yield* actions.load(parent.actionID)
      const childInput = {
        ...input("L0"),
        sessionID: parent.sessionID,
        assistantMessageID: parent.assistantMessageID,
        actionID: ActionGateway.stableChildActionID({
          parentActionID: parent.actionID,
          server: "local",
          tool: "edit",
          argsDigest: "budget",
          invocation: "call-1",
        }),
        parentActionID: parent.actionID,
        name: "edit",
      }
      yield* gateway.execute(childInput, { execute: () => Effect.succeed("child") })
      const childSnapshot = yield* actions.load(childInput.actionID)
      expect(parentSnapshot.action.budget.maxAttempts).toBe(1)
      expect(childSnapshot.action.budget.maxAttempts).toBe(1)
      expect(childSnapshot.action.budget.maxDurationMs).toBe(parentSnapshot.action.budget.maxDurationMs)
    }),
  )

  itEffect.effect("does not execute a settled durable action a second time", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "done"
          }),
      }

      yield* gateway.execute(action, operation)
      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)

      expect(executions).toBe(1)
      expect(String(replay)).toContain("ActionGateway.AlreadySettledError")
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("replays a durably observed tool result without repeating the side effect", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return { content: "durable result", count: 1 }
          }),
        durableResult: {
          encode: (value: { content: string; count: number }) => value,
          decode: (value: unknown) => value as { content: string; count: number },
        },
      }

      const first = yield* gateway.execute(action, operation)
      const replayed = yield* gateway.execute(action, operation)
      const snapshot = yield* actions.load(action.actionID)

      expect(first).toEqual({ content: "durable result", count: 1 })
      expect(replayed).toEqual(first)
      expect(executions).toBe(1)
      expect(snapshot.observation?.output?.encoding).toBe("json")
      expect(snapshot.observation?.output?.value).toEqual(first)
      expect(snapshot.observation?.outputDigest).toBe(snapshot.observation?.output?.digest)
      expect(RuntimeInsight.auditList(20).entries.some((entry) => entry.action === "action.result.replayed")).toBe(true)
    }),
  )

  for (const mode of ["success", "failure", "defect", "throw", "interrupt"] as const) {
    itEffect.effect(`post-success notification ${mode} preserves the original observation and is not replayed`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        let executions = 0
        let notifications = 0
        let hookState: string | undefined
        const expected = { content: "durable original" }
        const operation = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return expected
            }),
          afterSuccess: (value: typeof expected) => {
            notifications++
            if (mode === "throw") throw new Error("POSTPROCESS_SECRET")
            return Effect.gen(function* () {
              hookState = (yield* actions.load(action.actionID)).action.status
              value.content = "notification mutation"
              if (mode === "failure") return yield* Effect.fail(new Error("POSTPROCESS_SECRET"))
              if (mode === "defect") return yield* Effect.die(new Error("POSTPROCESS_SECRET"))
              if (mode === "interrupt") return yield* Effect.interrupt
            })
          },
          durableResult: {
            encode: (value: typeof expected) => value,
            decode: (value: unknown) => value as typeof expected,
          },
        }
        const first = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(notifications).toBe(1)
        if (mode !== "throw") expect(hookState).toBe("settled")
        if (mode === "success") expect(first).toEqual(Exit.succeed({ content: "durable original" }))
        else if (mode === "interrupt") expect(Exit.isFailure(first) && Cause.hasInterruptsOnly(first.cause)).toBe(true)
        else {
          expect(String(first)).toContain("ActionGateway.PostProcessingError")
          expect(String(first)).toContain("do not repeat the action")
          expect(String(first)).not.toContain("POSTPROCESS_SECRET")
        }
        const snapshot = yield* actions.load(action.actionID)
        expect(snapshot.action.status).toBe("settled")
        expect(snapshot.observation?.status).toBe("succeeded")
        expect(snapshot.observation?.output?.value).toEqual({ content: "durable original" })
        expect(snapshot.activeAttempt).toBeUndefined()
        expect(yield* gateway.execute(action, operation)).toEqual({ content: "durable original" })
        expect(executions).toBe(1)
        expect(notifications).toBe(1)
        expect((yield* actions.load(action.actionID)).lastSequence).toBe(snapshot.lastSequence)
      }),
    )
  }

  itEffect.effect("does not run a post-success notification for an unsuccessful or denied action", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let notifications = 0
      let executions = 0
      for (const permission of ["reject", "allow"]) {
        const action = input("L2")
        const result = yield* gateway
          .execute(action, {
            authorization: { requests: [{ action: permission, resources: ["test"] }] },
            execute: () =>
              Effect.sync(() => {
                executions++
              }).pipe(Effect.andThen(Effect.fail(new Error("failed")))),
            afterSuccess: () =>
              Effect.sync(() => {
                notifications++
              }),
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect(notifications).toBe(0)
      expect(executions).toBe(1)
    }),
  )

  for (const change of ["none", "input", "resource", "semantics", "subject", "authorization"] as const) {
    itEffect.effect(`postprocessing upgrade only replays an exact settled pre-projection intent (${change})`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = { ...input("L2"), inputDigest: canonicalHash({ value: "original" })! }
        const authorization = { requests: [{ action: "edit", resources: ["test"] }] }
        let executions = 0
        let hooks = 0
        const original: ActionGateway.Operation<string, never, never> = {
          authorization,
          execute: () =>
            Effect.sync(() => {
              executions++
              return "old final result"
            }),
          durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
        }
        expect(yield* gateway.execute(action, original)).toBe("old final result")
        const before = yield* actions.load(action.actionID)
        expect(before.action.resources).not.toContain(AgentRuntime.ActionPostProcessingResource)
        const presented = {
          ...action,
          ...(change === "input" ? { inputDigest: canonicalHash({ value: "changed" })! } : {}),
          ...(change === "resource" ? { resources: ["changed"] } : {}),
          ...(change === "semantics" ? { semantics: { ...action.semantics, retryability: "never" as const } } : {}),
          ...(change === "subject" ? { agent: AgentV2.ID.make("other") } : {}),
        }
        const replay = yield* gateway
          .execute(presented, {
            ...original,
            ...(change === "authorization"
              ? { authorization: { requests: [{ action: "edit", resources: ["other"] }] } }
              : {}),
            afterSuccessMode: "projection",
            afterSuccess: () =>
              Effect.sync(() => {
                hooks++
                return "must not run"
              }),
          })
          .pipe(Effect.exit)
        if (change === "none") expect(replay).toEqual(Exit.succeed("old final result"))
        else expect(String(replay)).toContain("ActionGateway.ActionIntentMismatchError")
        expect([executions, hooks]).toEqual([1, 0])
        expect(yield* actions.load(action.actionID)).toEqual(before)
      }),
    )
  }

  for (const state of ["settled", "proposed"] as const) {
    for (const newMessage of [false, true]) {
      itEffect.effect(
        `postprocessing upgrade preserves run identity for ${state} history (new message=${newMessage})`,
        () =>
          Effect.gen(function* () {
            const gateway = yield* ActionGateway.Service
            const actions = yield* DurableAction.Service
            const events = yield* EventV2.Service
            const base = input("L0")
            const runID = AgentRuntime.RunID.make(`run_post_history_${base.sessionID}`)
            const action = { ...base, runID, actionID: ActionGateway.stableActionID({ ...base, runID }) }
            let executions = 0
            let hooks = 0
            const operation: ActionGateway.Operation<string, never, never> = {
              execute: () =>
                Effect.sync(() => {
                  executions++
                  return "original"
                }),
              durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
            }
            if (state === "settled") yield* gateway.execute(action, operation)
            else
              yield* events.publish(AgentRuntime.Event.ActionProposed, {
                actionID: action.actionID,
                sessionID: action.sessionID,
                subject: sessionSubjectOf(action),
                action: yield* seededAction(action),
              })
            const before = yield* actions.load(action.actionID)
            const assistantMessageID = newMessage ? SessionMessage.ID.create() : action.assistantMessageID
            const replay = yield* gateway
              .execute(
                {
                  ...action,
                  assistantMessageID,
                  actionID: ActionGateway.stableActionID({ ...action, assistantMessageID }),
                },
                {
                  ...operation,
                  afterSuccessMode: "projection",
                  afterSuccess: () =>
                    Effect.sync(() => {
                      hooks++
                      return "must not run"
                    }),
                },
              )
              .pipe(Effect.exit)
            if (state === "settled") expect(replay).toEqual(Exit.succeed("original"))
            else expect(String(replay)).toContain("ActionGateway.ActionIntentMismatchError")
            expect([executions, hooks]).toEqual([state === "settled" ? 1 : 0, 0])
            expect(yield* actions.load(action.actionID)).toEqual(before)
            expect(yield* actions.list({ sessionID: action.sessionID, runID })).toHaveLength(1)
          }),
      )
    }
  }

  for (const largePhase of ["original", "display", "both"] as const) {
    itEffect.effect(`large durable tool results retain exact bytes and replay without effects (${largePhase})`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        const large = "中".repeat(400_000)
        const original = largePhase === "display" ? "original" : large
        const display = largePhase === "original" ? "display" : `${large} transformed`
        let executions = 0
        let hooks = 0
        const operation: ActionGateway.Operation<string, never, never> = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return original
            }),
          durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
          afterSuccessMode: "projection",
          afterSuccess: (value) =>
            Effect.sync(() => {
              hooks++
              expect(value).toBe(original)
              return display
            }),
        }
        expect(yield* gateway.execute(action, operation)).toBe(display)
        const before = yield* actions.load(action.actionID)
        expect(before.observation?.status).toBe("succeeded")
        expect(before.observation?.output?.encoding).toBe(largePhase === "display" ? "json" : "artifact")
        expect(before.postProcessing?.output?.encoding).toBe(largePhase === "original" ? "json" : "artifact")
        expect(yield* gateway.execute(action, operation)).toBe(display)
        expect([executions, hooks]).toEqual([1, 1])
        expect((yield* actions.load(action.actionID)).lastSequence).toBe(before.lastSequence)
      }),
    )
  }

  for (const phase of ["original", "projection"] as const) {
    for (const damage of ["bytes", "index", "owner", "digest", "size"] as const) {
      itEffect.live(`damaged large ${phase} receipt blocks replay without effects (${damage})`, () =>
        Effect.gen(function* () {
          const gateway = yield* ActionGateway.Service
          const actions = yield* DurableAction.Service
          const fs = yield* FSUtil.Service
          const global = yield* Global.Service
          const { db } = yield* Database.Service
          const action = input("L0")
          const value = "实".repeat(400_000)
          let executions = 0
          let hooks = 0
          const operation: ActionGateway.Operation<string, never, never> = {
            execute: () =>
              Effect.sync(() => {
                executions++
                return value
              }),
            durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
            ...(phase === "projection"
              ? {
                  afterSuccessMode: "projection" as const,
                  afterSuccess: () =>
                    Effect.sync(() => {
                      hooks++
                      return value + " display"
                    }),
                }
              : {}),
          }
          yield* gateway.execute(action, operation)
          const before = yield* actions.load(action.actionID)
          const output = phase === "original" ? before.observation?.output : before.postProcessing?.output
          if (output?.encoding !== "artifact") throw new Error("expected a managed exact result")
          const directory = path.join(global.data, ToolOutputStore.MANAGED_DIRECTORY)
          if (damage === "bytes")
            yield* fs.writeFileString(path.join(directory, output.value.retrievalHint.handle), "tampered")
          else if (damage === "index")
            yield* fs.remove(
              path.join(directory, ToolOutputStore.INDEX_DIRECTORY, `${output.value.retrievalHint.handle}.json`),
            )
          else {
            const type = phase === "original" ? "agent.action.observed.1" : "agent.action.postprocessing-recorded.1"
            const rows = yield* db
              .select({ id: EventTable.id, data: EventTable.data })
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, action.actionID), eq(EventTable.type, type)))
              .all()
              .pipe(Effect.orDie)
            const row = rows.find(
              (row) =>
                phase === "original" ||
                (row.data as { processing: { state: string } }).processing.state === "completed",
            )
            if (!row) throw new Error("missing result event")
            const corrupted = structuredClone(row.data) as {
              observation?: { output: { byteLength: number; digest: string; value: { owner: unknown } } }
              processing?: { output: { byteLength: number; digest: string; value: { owner: unknown } } }
            }
            const retained = phase === "original" ? corrupted.observation?.output : corrupted.processing?.output
            if (!retained) throw new Error("missing serialized output")
            if (damage === "owner") retained.value.owner = { scope: "session", id: "ses_foreign_artifact" }
            if (damage === "digest") retained.digest = "0".repeat(64)
            if (damage === "size") retained.byteLength++
            yield* db
              .update(EventTable)
              .set({ data: corrupted })
              .where(eq(EventTable.id, row.id))
              .run()
              .pipe(Effect.orDie)
          }
          const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
          expect(Exit.isFailure(replay)).toBe(true)
          expect([executions, hooks]).toEqual([1, phase === "projection" ? 1 : 0])
          if (damage === "bytes" || damage === "index") {
            if (!Exit.isFailure(replay)) throw new Error("expected failed recovery")
            const error = Cause.squash(replay.cause)
            expect(error).toBeInstanceOf(ActionGateway.RecoveryRequiredError)
            if (!(error instanceof ActionGateway.RecoveryRequiredError)) throw error
            expect(error.reason).toContain("durable result is unavailable or invalid")
            expect(error.reason).not.toContain(directory)
            const after = yield* actions.load(action.actionID)
            expect(after.observation?.status).toBe("succeeded")
            expect(after.lastSequence).toBe(before.lastSequence)
          } else expect(String(replay)).toContain("DurableAction.CorruptHistoryError")
        }),
      )
    }
  }

  for (const projected of ["display result", null] as const) {
    itEffect.effect(`durable projection replays ${String(projected)} with the correct audit identity`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        let executions = 0
        let hooks = 0
        const operation: ActionGateway.Operation<string | null, never, never> = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return "original"
            }),
          durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.NullOr(Schema.String)) },
          afterSuccessMode: "projection",
          afterSuccess: () =>
            Effect.gen(function* () {
              hooks++
              const snapshot = yield* actions.load(action.actionID)
              expect(snapshot.action.status).toBe("settled")
              expect(snapshot.postProcessing?.state).toBe("started")
              return projected
            }),
        }
        expect(yield* gateway.execute(action, operation)).toBe(projected)
        const snapshot = yield* actions.load(action.actionID)
        expect(snapshot.observation?.output?.value).toBe("original")
        expect(snapshot.postProcessing?.output?.value).toBe(projected)
        expect(snapshot.postProcessing?.observationID).toBe(snapshot.observation?.id)
        expect(snapshot.postProcessing?.state).toBe("completed")
        expect(yield* gateway.execute(action, operation)).toBe(projected)
        expect(executions).toBe(1)
        expect(hooks).toBe(1)
        expect((yield* actions.load(action.actionID)).lastSequence).toBe(snapshot.lastSequence)
        const replayAudit = RuntimeInsight.auditList(100).entries.findLast(
          (entry) => entry.action === "action.result.replayed" && entry.metadata?.actionID === action.actionID,
        )
        expect(replayAudit?.metadata?.outputDigest).toBe(snapshot.postProcessing?.output?.digest)
        expect(replayAudit?.metadata?.byteLength).toBe(snapshot.postProcessing?.output?.byteLength)
      }),
    )
  }

  for (const mode of ["failure", "defect", "throw", "interrupt", "oversized", "invalid"] as const) {
    itEffect.effect(`durable projection ${mode} preserves success and never repeats either phase`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        let executions = 0
        let hooks = 0
        const operation: ActionGateway.Operation<string, never, never> = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return "original"
            }),
          durableResult: {
            encode: (value) => (value === "invalid" ? { invalid: true } : value),
            decode: Schema.decodeUnknownSync(Schema.String),
          },
          afterSuccessMode: "projection",
          afterSuccess: () => {
            hooks++
            if (mode === "throw") throw new Error("PROJECTION_SECRET")
            if (mode === "failure") return Effect.fail(new Error("PROJECTION_SECRET"))
            if (mode === "defect") return Effect.die(new Error("PROJECTION_SECRET"))
            if (mode === "interrupt") return Effect.interrupt
            return Effect.succeed(
              mode === "oversized" ? "x".repeat(AgentRuntime.ManagedArtifactMaxBytes + 1) : "invalid",
            )
          },
        }
        const first = yield* gateway.execute(action, operation).pipe(Effect.exit)
        if (mode === "interrupt") expect(Exit.isFailure(first) && Cause.hasInterruptsOnly(first.cause)).toBe(true)
        else expect(String(first)).toContain("ActionGateway.PostProcessingError")
        expect(String(first)).not.toContain("PROJECTION_SECRET")
        const snapshot = yield* actions.load(action.actionID)
        expect(snapshot.action.status).toBe("settled")
        expect(snapshot.observation?.status).toBe("succeeded")
        expect(snapshot.observation?.output?.value).toBe("original")
        expect(snapshot.postProcessing?.state).toBe(mode === "interrupt" ? "interrupted" : "failed")
        expect(snapshot.postProcessing?.output).toBeUndefined()
        expect(snapshot.activeAttempt).toBeUndefined()
        const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(String(replay)).toContain("ActionGateway.PostProcessingError")
        expect(executions).toBe(1)
        expect(hooks).toBe(1)
        expect((yield* actions.load(action.actionID)).lastSequence).toBe(snapshot.lastSequence)
      }),
    )
  }

  for (const state of ["started", "completed", "failed", "interrupted"] as const) {
    for (const fault of ["defect", "interrupt"] as const) {
      itEffect.effect(
        `durable projection ${state} receipt ${fault} preserves the original effect and cancellation`,
        () =>
          Effect.gen(function* () {
            const gateway = yield* ActionGateway.Service
            const actions = yield* DurableAction.Service
            const events = yield* EventV2.Service
            const action = input("L0")
            let executions = 0
            let hooks = 0
            let failReceipt = true
            yield* events.project(AgentRuntime.Event.ActionPostProcessingRecorded, (event) => {
              if (!failReceipt || event.data.actionID !== action.actionID || event.data.processing.state !== state)
                return Effect.void
              const error = new Error("PRIVATE_RECEIPT_STORAGE_ERROR")
              return fault === "interrupt" ? Effect.interrupt : Effect.die(error)
            })
            const operation: ActionGateway.Operation<string, never, never> = {
              execute: () =>
                Effect.sync(() => {
                  executions++
                  return "original"
                }),
              durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
              afterSuccessMode: "projection",
              afterSuccess: () => {
                hooks++
                if (state === "interrupted") return Effect.interrupt
                if (state === "failed") return Effect.fail(new Error("PRIVATE_HOOK_ERROR"))
                return Effect.succeed("display")
              },
            }
            const result = yield* gateway.execute(action, operation).pipe(Effect.exit)
            if (state === "interrupted" || fault === "interrupt")
              expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
            else expect(String(result)).toContain("postprocessing receipt could not be confirmed")
            expect(String(result)).not.toContain("PRIVATE_RECEIPT_STORAGE_ERROR")
            expect(String(result)).not.toContain("PRIVATE_HOOK_ERROR")
            const snapshot = yield* actions.load(action.actionID)
            expect(snapshot.action.status).toBe("settled")
            expect(snapshot.observation?.status).toBe("succeeded")
            expect(snapshot.observation?.output?.value).toBe("original")
            expect(snapshot.postProcessing?.state).toBe(state === "started" ? undefined : "started")
            expect(snapshot.postProcessing?.output).toBeUndefined()
            expect(snapshot.activeAttempt).toBeUndefined()
            if (state === "interrupted") {
              const audit = RuntimeInsight.auditList(100).entries.findLast(
                (entry) =>
                  entry.action === "action.postprocessing.receipt.unconfirmed" &&
                  entry.metadata?.actionID === action.actionID,
              )
              expect(audit?.metadata?.interrupted).toBe(true)
              expect(audit?.reason).toContain("could not be confirmed")
              expect(JSON.stringify(audit)).not.toContain("PRIVATE_")
            }
            failReceipt = false
            const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
            expect(String(replay)).toContain("ActionGateway.PostProcessingError")
            expect([executions, hooks]).toEqual([1, state === "started" ? 0 : 1])
            expect(yield* actions.load(action.actionID)).toEqual(snapshot)
          }),
      )
    }
  }

  itEffect.effect(
    "durable projection blocks concurrent replay while pending then replays only the confirmed result",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let executions = 0
        let hooks = 0
        const operation: ActionGateway.Operation<string, never, never> = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return "original"
            }),
          durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
          afterSuccessMode: "projection",
          afterSuccess: () =>
            Effect.gen(function* () {
              hooks++
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return "display"
            }),
        }
        const running = yield* gateway.execute(action, operation).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        const pending = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(String(pending)).toContain("has no confirmed result")
        expect((yield* actions.load(action.actionID)).postProcessing?.state).toBe("started")
        expect([executions, hooks]).toEqual([1, 1])
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(running)).toBe("display")
        expect(yield* gateway.execute(action, operation)).toBe("display")
        expect([executions, hooks]).toEqual([1, 1])
      }),
  )

  itEffect.effect("durable projection cancellation joins cleanup before persisting interruption", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      const ready = yield* Deferred.make<void>()
      let cleaned = false
      const operation: ActionGateway.Operation<string, never, never> = {
        execute: () => Effect.succeed("original"),
        durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
        afterSuccessMode: "projection",
        afterSuccess: () =>
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                cleaned = true
              }),
            ),
          ),
      }
      const running = yield* gateway.execute(action, operation).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(running)
      expect(cleaned).toBe(true)
      const snapshot = yield* actions.load(action.actionID)
      expect(snapshot.action.status).toBe("settled")
      expect(snapshot.observation?.output?.value).toBe("original")
      expect(snapshot.postProcessing?.state).toBe("interrupted")
      expect(String(yield* gateway.execute(action, operation).pipe(Effect.exit))).toContain(
        "ActionGateway.PostProcessingError",
      )
    }),
  )

  for (const missing of ["codec", "processor"] as const) {
    itEffect.effect(`durable projection without ${missing} is rejected before proposal or execution`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const actions = yield* DurableAction.Service
        const action = input("L0")
        let executions = 0
        const result = yield* gateway
          .execute(action, {
            execute: () =>
              Effect.sync(() => {
                executions++
                return "original"
              }),
            afterSuccessMode: "projection",
            ...(missing === "processor" ? {} : { afterSuccess: () => Effect.succeed("display") }),
            ...(missing === "codec"
              ? {}
              : {
                  durableResult: { encode: (value: string) => value, decode: Schema.decodeUnknownSync(Schema.String) },
                }),
          })
          .pipe(Effect.exit)
        expect(String(result)).toContain("ActionGateway.BlockedError")
        expect(executions).toBe(0)
        expect(String(yield* actions.load(action.actionID).pipe(Effect.exit))).toContain("DurableAction.NotFoundError")
      }),
    )
  }

  for (const tamper of ["digest", "observation", "state", "missing-output", "timestamp"] as const) {
    itEffect.effect(`durable projection rejects a corrupted ${tamper} receipt without repeating effects`, () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const { db } = yield* Database.Service
        const action = input("L0")
        let executions = 0
        let hooks = 0
        const operation: ActionGateway.Operation<string, never, never> = {
          execute: () =>
            Effect.sync(() => {
              executions++
              return "original"
            }),
          durableResult: { encode: (value) => value, decode: Schema.decodeUnknownSync(Schema.String) },
          afterSuccessMode: "projection",
          afterSuccess: () =>
            Effect.sync(() => {
              hooks++
              return "display"
            }),
        }
        yield* gateway.execute(action, operation)
        const rows = yield* db
          .select({ id: EventTable.id, data: EventTable.data })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, action.actionID),
              eq(EventTable.type, "agent.action.postprocessing-recorded.1"),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const definition = AgentRuntime.Event.ActionPostProcessingRecorded.data
        const terminal = rows.find(
          (row) => Schema.decodeUnknownSync(definition)(row.data).processing.state === "completed",
        )
        if (!terminal) return yield* Effect.die(new Error("expected a completed projection receipt"))
        const payload = Schema.decodeUnknownSync(definition)(terminal.data)
        const record = payload.processing
        const corrupted = Schema.encodeSync(definition)({
          ...payload,
          processing: {
            ...record,
            ...(tamper === "digest" ? { output: { ...record.output!, digest: "0".repeat(64) } } : {}),
            ...(tamper === "observation" ? { observationID: AgentRuntime.ObservationID.create() } : {}),
            ...(tamper === "state" ? { state: "failed" as const } : {}),
            ...(tamper === "missing-output" ? { output: undefined } : {}),
            ...(tamper === "timestamp"
              ? { recordedAt: DateTime.makeUnsafe(DateTime.toEpochMillis(record.recordedAt) - 1) }
              : {}),
          },
        })
        yield* db
          .update(EventTable)
          .set({ data: corrupted })
          .where(eq(EventTable.id, terminal.id))
          .run()
          .pipe(Effect.orDie)
        const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
        expect(String(replay)).toContain("DurableAction.CorruptHistoryError")
        expect([executions, hooks]).toEqual([1, 1])
      }),
    )
  }

  itEffect.effect("durable projection cannot be bypassed by dropping the processor or its frozen intent marker", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () =>
          Effect.sync(() => {
            executions++
            return "original"
          }),
        durableResult: { encode: (value: string) => value, decode: Schema.decodeUnknownSync(Schema.String) },
      }
      yield* gateway.execute(action, {
        ...operation,
        afterSuccessMode: "projection",
        afterSuccess: () => Effect.succeed("display"),
      })
      expect(Exit.isFailure(yield* gateway.execute(action, operation).pipe(Effect.exit))).toBe(true)
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("rejects a tampered durable output before replaying or executing", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () => Effect.sync(() => ({ content: "authentic", executions: ++executions })),
        durableResult: {
          encode: (value: { content: string; executions: number }) => value,
          decode: (value: unknown) => value as { content: string; executions: number },
        },
      }
      yield* gateway.execute(action, operation)
      const row = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, action.actionID), eq(EventTable.type, "agent.action.observed.1")))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error("expected durable observation"))
      const observed = Schema.decodeUnknownSync(AgentRuntime.Event.ActionObserved.data)(row.data)
      if (!observed.observation.output || observed.observation.output.encoding !== "json")
        return yield* Effect.die(new Error("expected durable JSON output"))
      const tamperedObservation = Schema.encodeSync(AgentRuntime.Event.ActionObserved.data)({
        ...observed,
        observation: {
          ...observed.observation,
          output: { ...observed.observation.output, value: { content: "tampered", executions: 999 } },
        },
      })
      yield* db
        .update(EventTable)
        .set({ data: tamperedObservation })
        .where(eq(EventTable.id, row.id))
        .run()
        .pipe(Effect.orDie)

      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
      expect(String(replay)).toContain("DurableAction.CorruptHistoryError")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("keeps an exact legacy subjectless settled result readable without repeating its side effect", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const { db } = yield* Database.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () => Effect.sync(() => ({ value: ++executions })),
        durableResult: {
          encode: (value: { value: number }) => value,
          decode: (value: unknown) => value as { value: number },
        },
      }
      const first = yield* gateway.execute(action, operation)
      const proposalRow = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, action.actionID), eq(EventTable.type, "agent.action.proposed.1")))
        .get()
        .pipe(Effect.orDie)
      if (!proposalRow) return yield* Effect.die(new Error("expected durable proposal"))
      const proposal = Schema.decodeUnknownSync(AgentRuntime.Event.ActionProposed.data)(proposalRow.data)
      if (!("sessionID" in proposal.action)) return yield* Effect.die(new Error("expected session action"))
      const { subject: _legacySubject, ...subjectlessAction } = proposal.action
      const legacyAction = {
        ...subjectlessAction,
        intentDigest: ActionGateway.legacyIntentDigestV1Of(action, undefined),
      }
      const legacyProposal = Schema.encodeSync(AgentRuntime.Event.ActionProposed.data)({
        ...proposal,
        action: legacyAction,
      })
      yield* db
        .update(EventTable)
        .set({ data: legacyProposal })
        .where(eq(EventTable.id, proposalRow.id))
        .run()
        .pipe(Effect.orDie)

      const replayed = yield* gateway.execute(action, operation)
      expect(replayed).toEqual(first)
      expect(executions).toBe(1)
      let postHooks = 0
      expect(
        yield* gateway.execute(action, {
          ...operation,
          afterSuccessMode: "projection",
          afterSuccess: () =>
            Effect.sync(() => {
              postHooks++
              return { value: -1 }
            }),
        }),
      ).toEqual(first)
      expect([executions, postHooks]).toEqual([1, 0])
    }),
  )

  itEffect.effect("never resumes a nonterminal legacy-v1 intent without new preflight", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const events = yield* EventV2.Service
      const action = input("L0")
      const stored = yield* seededAction(action)
      yield* events.publish(AgentRuntime.Event.ActionProposed, {
        actionID: action.actionID,
        sessionID: action.sessionID,
        subject: sessionSubjectOf(action),
        action: AgentRuntime.SessionAction.make({
          ...stored,
          intentDigest: ActionGateway.legacyIntentDigestV1Of(action, undefined),
        }),
      })
      let executions = 0
      const resumed = yield* gateway
        .execute(action, {
          execute: () => Effect.sync(() => executions++).pipe(Effect.as("unexpected")),
        })
        .pipe(Effect.exit)

      expect(String(resumed)).toContain("ActionGateway.ActionIntentMismatchError")
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("settles safely when a tool result cannot be persisted and refuses an unsafe replay", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let executions = 0
      const operation = {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return 1n
          }),
        durableResult: {
          encode: (value: bigint) => value,
          decode: (value: unknown) => BigInt(String(value)),
        },
      }

      yield* gateway.execute(action, operation)
      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)

      expect(executions).toBe(1)
      expect((yield* actions.load(action.actionID)).observation?.output).toBeUndefined()
      expect(String(replay)).toContain("ActionGateway.AlreadySettledError")
      expect(RuntimeInsight.auditList(20).entries.some((entry) => entry.action === "action.result.not-persisted")).toBe(
        true,
      )
    }),
  )

  itEffect.effect("fails closed when the same actionID is presented with a different input intent", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      yield* gateway.execute(action, {
        authorization: { requests: [{ action: "edit", resources: ["src/a.ts"] }] },
        execute: () => Effect.succeed("first"),
      })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) throw new Error("authorization grant was not persisted")

      yield* reseedAuthorized(action, grant, "authorized", {
        requests: [{ action: "edit", resources: ["src/a.ts"] }],
      })
      let executions = 0
      const exit = yield* gateway
        .execute(
          {
            ...action,
            inputDigest: "digest-changed-content",
          },
          {
            authorization: { requests: [{ action: "edit", resources: ["src/a.ts"] }] },
            execute: () =>
              Effect.sync(() => {
                executions += 1
                return "second"
              }),
          },
        )
        .pipe(Effect.exit)

      expect(executions).toBe(0)
      expect(String(exit)).toContain("ActionGateway.ActionIntentMismatchError")
      // Same tool/path/scope but different input content never reaches a
      // permission request, an attempt, or the previous result.
      expect(authorizationRequests).toHaveLength(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("authorized")
    }),
  )

  itEffect.effect(
    "rejects structurally forged stored action fields even when the self-reported intent digest is unchanged",
    () =>
      Effect.gen(function* () {
        authorizationRequests.length = 0
        const gateway = yield* ActionGateway.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        let executions = 0
        for (const mutation of ["semantics", "resources", "run", "parent", "step", "policy", "name"] as const) {
          const action = input("L0")
          const stored = yield* seededAction(action)
          const forged = AgentRuntime.SessionAction.make({
            ...stored,
            ...(mutation === "semantics"
              ? {
                  semantics: AgentRuntime.EffectSemantics.make({
                    ...stored.semantics,
                    idempotency: "non_idempotent",
                    retryability: "never",
                  }),
                }
              : {}),
            ...(mutation === "resources" ? { resources: ["forged-resource"] } : {}),
            ...(mutation === "run" ? { runID: AgentRuntime.RunID.create() } : {}),
            ...(mutation === "parent" ? { parentActionID: AgentRuntime.ActionID.create() } : {}),
            ...(mutation === "step" ? { stepID: AgentRuntime.StepID.create() } : {}),
            ...(mutation === "policy" ? { authority: "human" as const, riskTier: "L3" as const } : {}),
            ...(mutation === "name" ? { name: "forged-name" } : {}),
          })
          yield* events.publish(AgentRuntime.Event.ActionProposed, {
            actionID: action.actionID,
            sessionID: action.sessionID,
            subject: sessionSubjectOf(action),
            action: forged,
          })

          const exit = yield* gateway
            .execute(action, {
              execute: () => Effect.sync(() => executions++).pipe(Effect.as("unexpected")),
            })
            .pipe(Effect.exit)
          expect(String(exit), mutation).toContain("ActionGateway.ActionIntentMismatchError")
          const rows = yield* db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, action.actionID))
            .all()
            .pipe(Effect.orDie)
          expect(
            rows.filter((event) => event.type === "agent.action.attempt-started.1"),
            mutation,
          ).toHaveLength(0)
        }
        expect(executions).toBe(0)
        expect(authorizationRequests).toHaveLength(0)
      }),
  )

  itEffect.effect("deep-snapshots authorization metadata and treats recovery metadata changes as a new intent", () =>
    Effect.gen(function* () {
      authorizationRequests.length = 0
      const gateway = yield* ActionGateway.Service
      const metadata = {
        z: { state: "original" },
        a: [1, { value: "frozen" }],
      }
      const action = input("L2")
      let executions = 0
      const authorization = {
        requests: [{ action: "edit", resources: ["src/metadata.ts"] }],
        metadata,
      }
      yield* gateway.execute(action, {
        authorization,
        execute: () =>
          Effect.sync(() => {
            executions += 1
            metadata.z.state = "mutated-after-approval"
            metadata.a[1] = { value: "mutated-after-approval" }
            return "done"
          }),
      })

      expect(authorizationRequests).toHaveLength(1)
      expect(authorizationRequests[0]?.metadata).toEqual({
        a: [1, { value: "frozen" }],
        z: { state: "original" },
      })
      const replay = yield* gateway
        .execute(action, {
          authorization,
          execute: () => Effect.sync(() => executions++).pipe(Effect.as("unexpected")),
        })
        .pipe(Effect.exit)
      expect(String(replay)).toContain("ActionGateway.ActionIntentMismatchError")
      expect(executions).toBe(1)
      expect(authorizationRequests).toHaveLength(1)
    }),
  )

  itEffect.effect(
    "rejects cyclic, executable, undefined, accessor, and oversized authorization metadata before events",
    () =>
      Effect.gen(function* () {
        authorizationRequests.length = 0
        const gateway = yield* ActionGateway.Service
        const { db } = yield* Database.Service
        const cyclic: Record<string, unknown> = {}
        cyclic.self = cyclic
        const accessor: Record<string, unknown> = {}
        Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "must-not-run" })
        const invalidMetadata: ReadonlyArray<Readonly<Record<string, unknown>>> = [
          cyclic,
          { executable: () => "not-json" },
          { missing: undefined },
          accessor,
          { oversized: "x".repeat(ActionGateway.MAX_AUTHORIZATION_METADATA_BYTES + 1) },
        ]
        let executions = 0
        for (const metadata of invalidMetadata) {
          const action = input("L2")
          const exit = yield* gateway
            .execute(action, {
              authorization: { requests: [{ action: "edit", resources: ["src/metadata.ts"] }], metadata },
              execute: () => Effect.sync(() => executions++).pipe(Effect.as("unexpected")),
            })
            .pipe(Effect.exit)
          expect(String(exit)).toContain("ActionGateway.BlockedError")
          const rows = yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, action.actionID))
            .all()
            .pipe(Effect.orDie)
          expect(rows).toHaveLength(0)
        }
        expect(executions).toBe(0)
        expect(authorizationRequests).toHaveLength(0)
      }),
  )

  itEffect.effect("revokes captured grant capabilities after the operation body and rejects transplanted tokens", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let captured: ActionGateway.AuthorizationGrantCapability | undefined
      const action = input("L0")
      yield* gateway.execute(action, {
        execute: (capability) =>
          Effect.sync(() => {
            captured = capability
            expect(ActionGateway.capabilityAuthority(capability)).toBe("automatic")
            const transplanted = { ...capability }
            expect(() => ActionGateway.capabilityAuthority(transplanted)).toThrow(
              "Invalid authorization grant capability",
            )
            return "done"
          }),
      })
      if (!captured) return yield* Effect.die(new Error("expected captured capability"))
      const retired = captured

      expect(() => ActionGateway.capabilityAuthority(retired)).toThrow("Invalid authorization grant capability")
      expect(() => ActionGateway.capabilityGrant(retired)).toThrow("Invalid authorization grant capability")
      expect(() => ActionGateway.capabilityRequests(retired)).toThrow("Invalid authorization grant capability")

      const second = input("L0")
      yield* gateway.execute(second, {
        execute: (current) =>
          Effect.sync(() => {
            expect(ActionGateway.capabilityAuthority(current)).toBe("automatic")
            expect(() => ActionGateway.capabilityAuthority(retired)).toThrow("Invalid authorization grant capability")
            return "done"
          }),
      })
    }),
  )

  itEffect.effect("replays a failed typed error as a clean message without stack leakage", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      const operation = {
        execute: () => Effect.fail(new Error("oldString must not be empty. Use write to create or overwrite a file.")),
      }

      yield* gateway.execute(action, operation).pipe(Effect.exit)
      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
      if (Exit.isSuccess(replay)) throw new Error("expected the replay to be blocked")

      const blocked = Cause.squash(replay.cause)
      expect(blocked).toBeInstanceOf(ActionGateway.BlockedError)
      expect((blocked as { reason: string }).reason).toBe(
        "oldString must not be empty. Use write to create or overwrite a file.",
      )
      expect((blocked as { reason: string }).reason).not.toContain("at ")
      const summary = (yield* actions.load(action.actionID)).observation?.summary ?? ""
      expect(summary).not.toContain("at ")
      expect(summary).not.toContain("action-gateway.ts")
    }),
  )

  itEffect.effect("replays an unexpected defect as a generic message with a correlation id", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      const operation = {
        execute: () => Effect.die(new Error("secret path C:\\private\\token.txt with stack")),
      }

      yield* gateway.execute(action, operation).pipe(Effect.exit)
      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
      if (Exit.isSuccess(replay)) throw new Error("expected the replay to be blocked")

      const blocked = Cause.squash(replay.cause)
      expect(blocked).toBeInstanceOf(ActionGateway.BlockedError)
      const reason = (blocked as { reason: string }).reason
      expect(reason).toContain("unexpected error (correlation:")
      expect(reason).not.toContain("C:\\private")
      expect(reason).not.toContain("token.txt")
      expect(reason).not.toContain("at ")
      const summary = (yield* actions.load(action.actionID)).observation?.summary ?? ""
      expect(summary).not.toContain("C:\\private")
      expect(summary).not.toContain("at ")
      // Full diagnostics remain in the protected audit log keyed by the correlation id.
      expect(
        RuntimeInsight.auditList(20).entries.some(
          (entry) => entry.action === "action.execution.failed" && entry.metadata.correlationID !== undefined,
        ),
      ).toBe(true)
    }),
  )

  itEffect.effect("blocks an uncertain guarded side effect after a hard-crash boundary", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const original = input("L0")
      const action = {
        ...original,
        semantics: AgentRuntime.EffectSemantics.make({
          ...original.semantics,
          idempotency: "conditional",
          retryability: "guarded",
          reversibility: "irreversible",
        }),
      }
      let executed = false
      const authorization = { requests: [{ action: "edit", resources: ["test"] }] }
      yield* seedExecuting(action, authorization)

      const recovered = yield* gateway
        .execute(action, {
          authorization,
          execute: () =>
            Effect.sync(() => {
              executed = true
            }),
        })
        .pipe(Effect.exit)

      expect(executed).toBe(false)
      expect(String(recovered)).toContain("ActionGateway.RecoveryRequiredError")
      const recoveryReason = Exit.isFailure(recovered)
        ? String((Cause.squash(recovered.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(recoveryReason).toContain("Tool outcome is unknown")
      expect(
        RuntimeInsight.auditList(30).entries.some(
          (entry) =>
            entry.action === "action.repair.required" &&
            entry.metadata.actionID === action.actionID &&
            entry.metadata.state === "outcome_unknown" &&
            entry.metadata.repairSource === "action-gateway-recovery",
        ),
      ).toBe(true)
      expect((yield* actions.load(action.actionID)).action.status).toBe("blocked")
    }),
  )

  itEffect.effect("persists an explicitly uncertain transport failure without fabricating an observation", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let executions = 0
      const first = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executions += 1
              throw new Error("transport disconnected after dispatch")
            }),
          outcomeUnknownOnFailure: (error) =>
            error instanceof Error && error.message.includes("transport disconnected"),
        })
        .pipe(Effect.exit)

      expect(String(first)).toContain("ActionGateway.RecoveryRequiredError")
      const snapshot = yield* actions.load(action.actionID)
      expect(snapshot.action.status).toBe("blocked")
      expect(snapshot.observation).toBeUndefined()
      expect(snapshot.activeAttempt).toBeUndefined()
      const recovery = yield* gateway.inspectRecovery!({ actionID: action.actionID })
      expect(recovery.state).toBe("outcome_unknown")
      expect(recovery.repair.required).toBe(true)

      const replay = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executions += 1
              return "must-not-run"
            }),
        })
        .pipe(Effect.exit)
      expect(String(replay)).toContain("ActionGateway.BlockedError")
      const replayReason = Exit.isFailure(replay)
        ? String((Cause.squash(replay.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(replayReason).toContain("Tool outcome is unknown")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("retries only a safely retryable idempotent action after a hard crash", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      const action = input("L0")
      let executions = 0
      yield* seedExecuting(action)

      const value = yield* gateway.execute(action, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "recovered"
          }),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .all()
        .pipe(Effect.orDie)

      expect(value).toBe("recovered")
      expect(executions).toBe(1)
      expect(rows.filter((row) => row.type === "agent.action.proposed.1")).toHaveLength(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("blocks a safe retry when a mutation intent survives the action crash boundary", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action)
      const now = yield* DateTime.now
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "test/recovery.txt",
          operation: "create",
          afterDigest: "a".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      yield* actions.recordMutationIntent({
        actionID: action.actionID,
        intent: AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: AgentRuntime.MutationTransactionID.create(),
          actionID: action.actionID,
          intentDigest: ActionGateway.intentDigestOf(action, undefined),
          idempotencyKey: action.actionID,
          phase: "prepared",
          entries,
          manifestDigest: MutationIntent.manifestDigest(entries)!,
          automaticRetryAllowed: false,
          createdAt: now,
          updatedAt: now,
          summary: "mutation journal prepared before a simulated crash",
        }),
      })
      expect(gateway.inspectRecovery).toBeDefined()
      const recoveryProjection = yield* gateway.inspectRecovery!({ actionID: action.actionID })
      expect(recoveryProjection).toMatchObject({
        actionID: action.actionID,
        actionStatus: "executing",
        state: "outcome_unknown",
        mutationRecovery: {
          phase: "prepared",
          decision: "inspect",
          automaticRetryAllowed: false,
        },
      })
      expect(recoveryProjection.mutationIntent?.entries[0]?.target).toBe("test/recovery.txt")
      expect(recoveryProjection.mutationIntent).not.toHaveProperty("summary")
      expect(JSON.stringify(recoveryProjection)).not.toContain("original-file-content")

      let executions = 0
      const recovered = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executions += 1
              return "must-not-run"
            }),
        })
        .pipe(Effect.exit)

      expect(executions).toBe(0)
      expect(String(recovered)).toContain("ActionGateway.RecoveryRequiredError")
      const reason = Exit.isFailure(recovered)
        ? String((Cause.squash(recovered.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(reason).toContain("Mutation recovery requires inspect")
      expect(reason).toContain("Automatic retry is blocked")
      expect((yield* actions.load(action.actionID)).action.status).toBe("blocked")
      expect(
        RuntimeInsight.auditList(30).entries.some(
          (entry) =>
            entry.action === "action.mutation.recovery.required" &&
            entry.metadata.actionID === action.actionID &&
            entry.metadata.mutationDecision === "inspect",
        ),
      ).toBe(true)
    }),
  )

  itEffect.effect("does not replay a settled action while its mutation transaction is still nonterminal", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let executions = 0
      yield* gateway.execute(action, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "settled-before-mutation-record"
          }),
      })

      const now = yield* DateTime.now
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "test/late-journal.txt",
          operation: "create",
          afterDigest: "b".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      yield* actions.recordMutationIntent({
        actionID: action.actionID,
        intent: AgentRuntime.MutationIntent.make({
          version: 1,
          transactionID: AgentRuntime.MutationTransactionID.create(),
          actionID: action.actionID,
          intentDigest: ActionGateway.intentDigestOf(action, undefined),
          idempotencyKey: action.actionID,
          phase: "prepared",
          entries,
          manifestDigest: MutationIntent.manifestDigest(entries)!,
          automaticRetryAllowed: false,
          createdAt: now,
          updatedAt: now,
          summary: "late nonterminal mutation record",
        }),
      })

      const replay = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executions += 1
              return "must-not-run"
            }),
        })
        .pipe(Effect.exit)

      expect(executions).toBe(1)
      expect(String(replay)).toContain("ActionGateway.RecoveryRequiredError")
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("does not retry an executing action even when mutation settlement precedes Action settlement", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action)
      const now = yield* DateTime.now
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "test/settlement-order.txt",
          operation: "create",
          afterDigest: "d".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      const transactionID = AgentRuntime.MutationTransactionID.create()
      let updatedAt = DateTime.toEpochMillis(now)
      for (const phase of ["prepared", "committed", "postprocessing", "settled"] as const) {
        updatedAt += 1
        yield* actions.recordMutationIntent({
          actionID: action.actionID,
          intent: AgentRuntime.MutationIntent.make({
            version: 1,
            transactionID,
            actionID: action.actionID,
            intentDigest: ActionGateway.intentDigestOf(action, undefined),
            idempotencyKey: action.actionID,
            phase,
            entries,
            manifestDigest: MutationIntent.manifestDigest(entries)!,
            automaticRetryAllowed: false,
            createdAt: now,
            updatedAt: DateTime.makeUnsafe(updatedAt),
            summary: "mutation settled before Action observation",
          }),
        })
      }

      let executions = 0
      const recovered = yield* gateway
        .execute(action, {
          execute: () =>
            Effect.sync(() => {
              executions += 1
              return "must-not-run"
            }),
        })
        .pipe(Effect.exit)

      expect(executions).toBe(0)
      expect(String(recovered)).toContain("ActionGateway.RecoveryRequiredError")
      const reason = Exit.isFailure(recovered)
        ? String((Cause.squash(recovered.cause) as { readonly reason?: unknown }).reason ?? "")
        : ""
      expect(reason).toContain("Mutation recovery is settled")
      expect(reason).toContain("Automatic retry is blocked")
      expect((yield* actions.load(action.actionID)).action.status).toBe("blocked")
    }),
  )

  itEffect.effect("blocks every nonterminal mutation recovery phase before executing a retry", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const phases = [
        ["committed", ["prepared", "committed"]],
        ["postprocessing", ["prepared", "committed", "postprocessing"]],
        ["outcome_unknown", ["prepared", "outcome_unknown"]],
        ["rollback_required", ["prepared", "rollback_required"]],
        ["rollback_blocked", ["prepared", "rollback_required", "rollback_blocked"]],
        ["rolled_back", ["prepared", "rollback_required", "rolled_back"]],
      ] as const
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "test/recovery-matrix.txt",
          operation: "create",
          afterDigest: "e".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      const manifestDigest = MutationIntent.manifestDigest(entries)!

      for (const [index, [terminalPhase, sequence]] of phases.entries()) {
        const action = (() => {
          const base = input("L0")
          const context = {
            sessionID: base.sessionID,
            assistantMessageID: base.assistantMessageID,
            toolCallID: `call-mutation-recovery-phase-${index}`,
          }
          return { ...base, ...context, actionID: ActionGateway.stableActionID(context) }
        })()
        yield* seedExecuting(action)
        const now = yield* DateTime.now
        const transactionID = AgentRuntime.MutationTransactionID.create()
        let updatedAt = DateTime.toEpochMillis(now)
        for (const phase of sequence) {
          updatedAt += 1
          yield* actions.recordMutationIntent({
            actionID: action.actionID,
            intent: AgentRuntime.MutationIntent.make({
              version: 1,
              transactionID,
              actionID: action.actionID,
              intentDigest: ActionGateway.intentDigestOf(action, undefined),
              idempotencyKey: action.actionID,
              phase,
              entries,
              manifestDigest,
              automaticRetryAllowed: false,
              createdAt: now,
              updatedAt: DateTime.makeUnsafe(updatedAt),
              summary: `mutation recovery phase ${terminalPhase}`,
            }),
          })
        }

        let executions = 0
        const result = yield* gateway
          .execute(action, {
            execute: () =>
              Effect.sync(() => {
                executions += 1
                return "must-not-run"
              }),
          })
          .pipe(Effect.exit)

        expect(executions).toBe(0)
        expect(String(result)).toContain("ActionGateway.RecoveryRequiredError")
        expect((yield* actions.load(action.actionID)).action.status).toBe("blocked")
      }
    }),
  )

  itEffect.effect("records only fingerprint-bound human mutation reviews without changing Action status", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      if (!gateway.recordMutationIntent || !gateway.reviewMutationIntent)
        throw new Error("mutation review gateway seams are unavailable")
      const entries: ReadonlyArray<AgentRuntime.MutationIntentEntry> = [
        {
          target: "test/human-review.txt",
          operation: "create",
          afterDigest: "f".repeat(64),
          afterByteLength: 1,
          recovery: "remove-if-matching",
        },
      ]
      const manifestDigest = MutationIntent.manifestDigest(entries)!
      const observationDigest = "a".repeat(64)
      const reviews = [
        {
          decision: "settle_postimage" as const,
          inspectedDecision: "postimage_matches" as const,
          phases: ["prepared", "committed"] as const,
          expectedPhase: "committed" as const,
          result: "settled" as const,
        },
        {
          decision: "require_rollback" as const,
          inspectedDecision: "postimage_matches" as const,
          phases: ["prepared"] as const,
          expectedPhase: "prepared" as const,
          result: "rollback_required" as const,
        },
        {
          decision: "confirm_rolled_back" as const,
          inspectedDecision: "preimage_matches" as const,
          phases: ["prepared", "rollback_required"] as const,
          expectedPhase: "rollback_required" as const,
          result: "rolled_back" as const,
        },
        {
          decision: "block_rollback" as const,
          inspectedDecision: "manual_review" as const,
          phases: ["prepared", "rollback_required"] as const,
          expectedPhase: "rollback_required" as const,
          result: "rollback_blocked" as const,
        },
      ]

      for (const [index, review] of reviews.entries()) {
        const base = input("L0")
        const context = {
          sessionID: base.sessionID,
          assistantMessageID: base.assistantMessageID,
          toolCallID: `call-human-mutation-review-${index}`,
        }
        const action = { ...base, ...context, actionID: ActionGateway.stableActionID(context) }
        yield* seedExecuting(action)
        const now = yield* DateTime.now
        const transactionID = AgentRuntime.MutationTransactionID.create()
        let updatedAt = DateTime.toEpochMillis(now)
        for (const phase of review.phases) {
          updatedAt += 1
          yield* gateway.recordMutationIntent({
            actionID: action.actionID,
            transactionID,
            phase,
            entries,
            manifestDigest,
            createdAt: now,
            updatedAt: DateTime.makeUnsafe(updatedAt),
            summary: "human review mutation fixture",
          })
        }
        const reviewedAt = DateTime.makeUnsafe(updatedAt + 1)
        const reviewed = yield* gateway.reviewMutationIntent({
          actionID: action.actionID,
          transactionID,
          expectedPhase: review.expectedPhase,
          decision: review.decision,
          inspectedDecision: review.inspectedDecision,
          observationDigest,
          reviewedAt,
        })
        expect(reviewed.mutationIntent?.phase, review.decision).toBe(review.result)
        expect(reviewed.action.status, review.decision).toBe("executing")
        expect(reviewed.mutationIntent?.automaticRetryAllowed, review.decision).toBe(false)
      }

      expect(
        RuntimeInsight.auditList(100).entries.some(
          (entry) =>
            entry.action === "action.mutation.reviewed" &&
            entry.metadata.decision === "settle_postimage" &&
            entry.metadata.inspectedDecision === "postimage_matches",
        ),
      ).toBe(true)
    }),
  )

  itEffect.effect("claims and completes a durable proposal left before policy evaluation", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const action = input("L0")
      const subject = sessionSubjectOf(action)
      let executions = 0

      // Simulate a hard crash after the unique proposal CAS, before a worker
      // acquired a lease or persisted its policy decision.
      yield* events.publish(
        AgentRuntime.Event.ActionProposed,
        {
          actionID: action.actionID,
          sessionID: action.sessionID,
          subject,
          action: yield* seededAction(action),
        },
        { expectedSequence: -1 },
      )

      const value = yield* gateway.execute(action, {
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "recovered-proposal"
          }),
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .all()
        .pipe(Effect.orDie)
      const snapshot = yield* actions.load(action.actionID)

      expect(value).toBe("recovered-proposal")
      expect(executions).toBe(1)
      expect(rows.filter((row) => row.type === "agent.action.proposed.1")).toHaveLength(1)
      expect(snapshot.action.status).toBe("settled")
      expect(snapshot.lease).toBeUndefined()
    }),
  )
})

describe("ActionGateway policy helpers", () => {
  it("maps all five risk tiers to their fixed authority boundary", () => {
    expect(["L0", "L1", "L2", "L3", "L4"].map((tier) => ActionGateway.authorityFor(tier as never))).toEqual([
      "automatic",
      "automatic",
      "scoped_grant",
      "human",
      "forbidden",
    ])
  })

  it("derives the same action ID for a replayed tool call", () => {
    const context = {
      sessionID: "ses_test",
      assistantMessageID: "msg_test",
      toolCallID: "call_test",
    }
    expect(ActionGateway.stableActionID(context)).toBe(ActionGateway.stableActionID(context))
    expect(ActionGateway.stableActionID({ ...context, toolCallID: "call_other" })).not.toBe(
      ActionGateway.stableActionID(context),
    )
  })

  it("binds every identity dimension: same tuple replays, any single difference never collides", () => {
    const base = {
      runID: AgentRuntime.RunID.create(),
      sessionID: "ses_test",
      assistantMessageID: "msg_first",
      toolCallID: "call_test",
    }
    // The same full tuple recomputes the same action ID.
    expect(ActionGateway.stableActionID(base)).toBe(ActionGateway.stableActionID(base))
    // A difference in any one dimension must produce a distinct action ID.
    expect(ActionGateway.stableActionID({ ...base, assistantMessageID: "msg_second" })).not.toBe(
      ActionGateway.stableActionID(base),
    )
    expect(ActionGateway.stableActionID({ ...base, toolCallID: "call_other" })).not.toBe(
      ActionGateway.stableActionID(base),
    )
    expect(ActionGateway.stableActionID({ ...base, sessionID: "ses_other" })).not.toBe(
      ActionGateway.stableActionID(base),
    )
    expect(ActionGateway.stableActionID({ ...base, runID: AgentRuntime.RunID.create() })).not.toBe(
      ActionGateway.stableActionID(base),
    )
    // The no-runID branch is preserved byte-for-byte: legacy recovery keeps
    // the same action ID for the same message-scoped tuple.
    const legacy = { sessionID: "ses_test", assistantMessageID: "msg_test", toolCallID: "call_test" }
    expect(ActionGateway.stableActionID(legacy)).toBe(ActionGateway.stableActionID(legacy))
  })

  it("never collides when a run reuses a provider-local tool call ID across assistant messages", () => {
    const runID = AgentRuntime.RunID.create()
    const first = ActionGateway.stableActionID({
      runID,
      sessionID: "ses_test",
      assistantMessageID: "msg_first",
      toolCallID: "tool_0",
    })
    const second = ActionGateway.stableActionID({
      runID,
      sessionID: "ses_test",
      assistantMessageID: "msg_second",
      toolCallID: "tool_0",
    })
    // The same run legitimately repeats a provider-local call ID in a later
    // turn; each turn's call must own a distinct durable action.
    expect(second).not.toBe(first)
    // The same turn's call remains recoverable: replaying the same tuple
    // reproduces the same action ID under the same run.
    expect(
      ActionGateway.stableActionID({
        runID,
        sessionID: "ses_test",
        assistantMessageID: "msg_second",
        toolCallID: "tool_0",
      }),
    ).toBe(second)
  })

  it("derives a stable child action ID from parent, server, tool, argument digest, and invocation", () => {
    const parentActionID = AgentRuntime.ActionID.create()
    const identity = { parentActionID, server: "github", tool: "list_issues", argsDigest: "abc", invocation: "call/1" }
    expect(ActionGateway.stableChildActionID(identity)).toBe(ActionGateway.stableChildActionID(identity))
    expect(ActionGateway.stableChildActionID({ ...identity, argsDigest: "abd" })).not.toBe(
      ActionGateway.stableChildActionID(identity),
    )
    expect(ActionGateway.stableChildActionID({ ...identity, parentActionID: AgentRuntime.ActionID.create() })).not.toBe(
      ActionGateway.stableChildActionID(identity),
    )
    // Two intentional identical calls get distinct child actions via the invocation key.
    expect(ActionGateway.stableChildActionID({ ...identity, invocation: "call/2" })).not.toBe(
      ActionGateway.stableChildActionID(identity),
    )
  })

  it("derives a control-plane action ID from every identity dimension", () => {
    const subject = () =>
      AgentRuntime.ControlPlaneSubject.make({
        type: "control-plane",
        id: AgentRuntime.ControlPlaneID.create(),
        location: AbsolutePath.make("/project"),
        project: Project.ID.global,
        actor: "user",
        principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
        requestID: AgentRuntime.ControlPlaneRequestID.create(),
      })
    const identity = {
      subject: subject(),
      name: "mcp.connect",
      resources: ["server-a"],
      inputDigest: "digest",
      policyVersion: ActionGateway.POLICY_VERSION,
    }
    expect(ActionGateway.stableControlPlaneActionID(identity)).toBe(ActionGateway.stableControlPlaneActionID(identity))
    const variants: Array<[string, Partial<typeof identity>]> = [
      ["subject kind", { subject: subject() }],
      ["subject ID", { subject: { ...subject(), id: AgentRuntime.ControlPlaneID.create() } }],
      ["location", { subject: { ...subject(), location: AbsolutePath.make("/other") } }],
      ["project", { subject: { ...subject(), project: Project.ID.global } }],
      ["request identity", { subject: { ...subject(), requestID: AgentRuntime.ControlPlaneRequestID.create() } }],
      [
        "principal reference",
        { subject: { ...subject(), principalRef: AgentRuntime.ControlPrincipalRef.make("prn_other") } },
      ],
      ["action name", { name: "mcp.connect:other" }],
      ["scope", { resources: ["server-b"] }],
      ["input digest", { inputDigest: "digest-2" }],
      ["policy version", { policyVersion: "policy-v2" }],
    ]
    for (const [label, override] of variants) {
      expect(ActionGateway.stableControlPlaneActionID({ ...identity, ...override }), label).not.toBe(
        ActionGateway.stableControlPlaneActionID(identity),
      )
    }
    // A session identity can never derive a control-plane action ID.
    expect(
      ActionGateway.stableActionID({ sessionID: "ses_x", assistantMessageID: "msg_x", toolCallID: "call_x" }),
    ).not.toBe(ActionGateway.stableControlPlaneActionID(identity))
  })
})

const crashMatrixBudget = AgentRuntime.Budget.make({
  ...budget,
  maxAttempts: 2,
})

const crashMatrixPlan: ActionGateway.AuthorizationPlan = {
  requests: [{ action: "edit", resources: ["crash-matrix"] }],
}

const crashMatrixIdentity = (action: ActionGateway.Input) => ({
  actionID: action.actionID,
  subject: sessionSubjectOf(action),
  ...(sessionOf(action) ? { sessionID: sessionOf(action) } : {}),
})

const seedCrashMatrixAttemptStarted = (action: ActionGateway.Input, attempt = 1) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const startedAt = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionAttemptStarted, {
      ...crashMatrixIdentity(action),
      attempt,
      startedAt,
    })
  })

const seedCrashMatrixAttemptFinished = (action: ActionGateway.Input, attempt = 1) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const finishedAt = yield* DateTime.now
    yield* events.publish(AgentRuntime.Event.ActionAttemptFinished, {
      ...crashMatrixIdentity(action),
      attempt,
      outcome: "succeeded",
      durationMs: 0,
      costMicros: 0,
      finishedAt,
    })
  })

const seedCrashMatrixObservation = (action: ActionGateway.Input, status: "observed" | "verifying") =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const observedAt = yield* DateTime.now
    const value = { marker: "crash-matrix-replay" }
    const serialized = JSON.stringify(value)
    const output = AgentRuntime.ActionOutput.make({
      encoding: "json",
      value,
      digest: createHash("sha256").update(serialized).digest("hex"),
      byteLength: Buffer.byteLength(serialized, "utf8"),
    })
    const observation = AgentRuntime.Observation.make({
      id: AgentRuntime.ObservationID.create(),
      actionID: action.actionID,
      status: "succeeded",
      summary: "Crash matrix observation",
      output,
      outputDigest: output.digest,
      artifactIDs: [],
      observedAt,
    })
    yield* events.publish(AgentRuntime.Event.ActionObserved, {
      ...crashMatrixIdentity(action),
      observation,
    })
    yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
      ...crashMatrixIdentity(action),
      from: "executing",
      to: "observed",
      reason: "Crash matrix observation persisted before verification",
      changedAt: observedAt,
    })
    if (status === "verifying")
      yield* events.publish(AgentRuntime.Event.ActionStateChanged, {
        ...crashMatrixIdentity(action),
        from: "observed",
        to: "verifying",
        reason: "Crash matrix verification persisted before settlement",
        changedAt: observedAt,
      })
  })

const crashMatrixReplayableOperation = (state: { executorCalls: number; sideEffects: number; committed: boolean }) => ({
  execute: () =>
    Effect.sync(() => {
      state.executorCalls += 1
      if (!state.committed) {
        state.committed = true
        state.sideEffects += 1
      }
      return { marker: "crash-matrix-replay" }
    }),
  durableResult: {
    encode: (value: { marker: string }) => value,
    decode: (value: unknown) => value as { marker: string },
  },
})

describe("V2 Step 2.11 crash injection matrix", () => {
  itEffect.effect("1 intent persist前：无历史时重试只产生一个 canonical action 和副作用", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      let sideEffects = 0
      const value = yield* gateway.execute(action, {
        execute: () => Effect.sync(() => `effect-${++sideEffects}`),
      })
      const snapshot = yield* actions.load(action.actionID)
      expect(value).toBe("effect-1")
      expect(sideEffects).toBe(1)
      expect(snapshot.action.status).toBe("settled")
      expect(snapshot.lastSequence).toBeGreaterThan(0)
    }),
  )

  itEffect.effect("2 intent persist后、approval前：沿同一 action 恢复审批并执行一次", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      yield* seedAwaitingApproval(action, crashMatrixPlan)
      let sideEffects = 0
      yield* gateway.execute(action, {
        authorization: crashMatrixPlan,
        execute: () => Effect.sync(() => ++sideEffects),
      })
      expect(sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("3 approval后、lease前：复用已验证 grant，不重新生成 action", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L2")
      yield* gateway.execute(action, {
        authorization: crashMatrixPlan,
        execute: () => Effect.succeed("seeded"),
      })
      const grant = (yield* actions.load(action.actionID)).authorization
      if (!grant) return yield* Effect.die(new Error("crash matrix grant was not persisted"))
      yield* reseedAuthorized(action, grant, "authorized", crashMatrixPlan)
      let sideEffects = 0
      yield* gateway.execute(action, {
        authorization: crashMatrixPlan,
        execute: () => Effect.sync(() => ++sideEffects),
      })
      expect(sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("4 lease后、attempt前：过期 lease 可被唯一恢复 worker 接管", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action)
      yield* actions.acquireLease({ actionID: action.actionID, ownerID: "crash-matrix-worker", ttlMs: 1 })
      yield* TestClock.adjust("2 millis")
      let sideEffects = 0
      yield* gateway.execute(action, {
        execute: () => Effect.sync(() => ++sideEffects),
      })
      expect(sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("5 side effect前：attempt 尚未开始时恢复只执行一次", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action)
      const state = { executorCalls: 0, sideEffects: 0, committed: false }
      yield* gateway.execute(action, crashMatrixReplayableOperation(state))
      expect(state.executorCalls).toBe(1)
      expect(state.sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("恢复重放新 assistant message 时仍复用同一 Run 的 durable Action", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const runID = AgentRuntime.RunID.create()
      const base = input("L0")
      const makeAction = () => {
        const action = { ...base, runID, assistantMessageID: SessionMessage.ID.create() }
        return {
          ...action,
          actionID: ActionGateway.stableActionID({
            runID,
            sessionID: action.sessionID,
            assistantMessageID: action.assistantMessageID,
            toolCallID: action.toolCallID,
          }),
        }
      }
      const first = makeAction()
      const replay = makeAction()
      expect(replay.actionID).not.toBe(first.actionID)
      yield* seedExecuting(first, undefined, crashMatrixBudget)
      yield* seedCrashMatrixAttemptStarted(first)
      const state = { executorCalls: 0, sideEffects: 1, committed: true }
      yield* gateway.execute(replay, crashMatrixReplayableOperation(state))
      expect(state.executorCalls).toBe(1)
      expect(state.sideEffects).toBe(1)
      expect((yield* actions.list({ sessionID: first.sessionID, runID, limit: 10 })).length).toBe(1)
      expect((yield* actions.load(first.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("6 side effect中：已发生的幂等副作用不被恢复重复提交", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action, undefined, crashMatrixBudget)
      yield* seedCrashMatrixAttemptStarted(action)
      const state = { executorCalls: 0, sideEffects: 1, committed: true }
      yield* gateway.execute(action, crashMatrixReplayableOperation(state))
      expect(state.executorCalls).toBe(1)
      expect(state.sideEffects).toBe(1)
      expect(
        RuntimeInsight.auditList(50).entries.some(
          (entry) =>
            entry.action === "action.execution.interrupted" && String(entry.reason).includes("previous active attempt"),
        ),
      ).toBe(true)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("7 side effect后、observation前：幂等键阻止恢复重复副作用", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action, undefined, crashMatrixBudget)
      yield* seedCrashMatrixAttemptStarted(action)
      yield* seedCrashMatrixAttemptFinished(action)
      const state = { executorCalls: 0, sideEffects: 1, committed: true }
      yield* gateway.execute(action, crashMatrixReplayableOperation(state))
      expect(state.executorCalls).toBe(1)
      expect(state.sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("8 observation后、verification前：恢复 replay observation 而不执行副作用", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action, undefined, crashMatrixBudget)
      yield* seedCrashMatrixAttemptStarted(action)
      yield* seedCrashMatrixAttemptFinished(action)
      yield* seedCrashMatrixObservation(action, "observed")
      const state = { executorCalls: 0, sideEffects: 1, committed: true }
      const replayed = yield* gateway.execute(action, crashMatrixReplayableOperation(state))
      expect(replayed).toEqual({ marker: "crash-matrix-replay" })
      expect(state.executorCalls).toBe(0)
      expect(state.sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("9 verification后、settlement前：验证态恢复到 settled 且只 replay", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const actions = yield* DurableAction.Service
      const action = input("L0")
      yield* seedExecuting(action, undefined, crashMatrixBudget)
      yield* seedCrashMatrixAttemptStarted(action)
      yield* seedCrashMatrixAttemptFinished(action)
      yield* seedCrashMatrixObservation(action, "verifying")
      const state = { executorCalls: 0, sideEffects: 1, committed: true }
      const replayed = yield* gateway.execute(action, crashMatrixReplayableOperation(state))
      expect(replayed).toEqual({ marker: "crash-matrix-replay" })
      expect(state.executorCalls).toBe(0)
      expect(state.sideEffects).toBe(1)
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )
})

describe("ActionGateway control-plane subject", () => {
  const controlSubject = () =>
    AgentRuntime.ControlPlaneSubject.make({
      type: "control-plane",
      id: AgentRuntime.ControlPlaneID.create(),
      location: AbsolutePath.make("/project"),
      project: Project.ID.global,
      actor: "user",
      principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
      requestID: AgentRuntime.ControlPlaneRequestID.create(),
    })

  const controlInput = (
    overrides: {
      actionID?: AgentRuntime.ActionID
      runID?: AgentRuntime.RunID
      name?: string
      resources?: ReadonlyArray<string>
      semantics?: AgentRuntime.EffectSemantics
      reasonSummary?: string
      inputDigest?: string
    } = {},
  ): ActionGateway.Input & { kind: "control-plane" } => {
    const subject = controlSubject()
    return {
      kind: "control-plane" as const,
      controlPlane: subject,
      actionID:
        overrides.actionID ??
        ActionGateway.stableControlPlaneActionID({
          subject,
          name: overrides.name ?? "mcp.connect",
          resources: overrides.resources ?? ["server-a"],
          inputDigest: overrides.inputDigest ?? "digest",
          policyVersion: ActionGateway.POLICY_VERSION,
        }),
      name: overrides.name ?? "mcp.connect",
      resources: overrides.resources ?? ["server-a"],
      semantics: overrides.semantics ?? semantics("L3"),
      reasonSummary: overrides.reasonSummary ?? "connect local MCP server",
      initiator: "user" as const,
      inputDigest: overrides.inputDigest ?? "digest",
      ...(overrides.runID ? { runID: overrides.runID } : {}),
    }
  }

  const waitForControlAsked = () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const asked = yield* Deferred.make<AgentRuntime.ControlRequest>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === AgentRuntime.ControlEvent.Asked.type
          ? Deferred.succeed(asked, event.data as AgentRuntime.ControlRequest).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      return asked
    })

  const observeControlExecutionEvents = () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const published: string[] = []
      const tracked = new Set<string>([
        AgentRuntime.Event.ActionProposed.type,
        AgentRuntime.ControlEvent.Asked.type,
        AgentRuntime.Event.ActionAuthorizationGranted.type,
        AgentRuntime.Event.ActionAttemptStarted.type,
      ])
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (tracked.has(event.type)) published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      return published
    })

  const controlOperation = <A>(execute: () => Effect.Effect<A, never, never>) => ({
    authorization: { requests: [{ action: "mcp.connect", resources: ["server-a"] }] },
    execute,
    successSummary: () => "connected",
  })

  const boundControlRun = (riskTier: AgentRuntime.RiskTier = "L3") => {
    const input = controlInput({ semantics: semantics(riskTier) })
    const payload = { server: "server-a", operation: "connect" }
    const payloadDigest = canonicalHash(payload)
    if (!payloadDigest) throw new Error("control run payload must be canonical")
    const generation = 0
    const claimDigest = "claim-mcp-connect-server-a"
    const operationID = DurableRun.controlOperationID({
      subject: input.controlPlane,
      claimDigest,
      generation,
    })
    if (!operationID) throw new Error("control operation identity must be canonical")
    const unboundOperation = AgentRuntime.ControlOperationSnapshot.make({
      version: 1,
      id: operationID,
      kind: "mcp.connect",
      generation,
      policyVersion: ActionGateway.POLICY_VERSION,
      claimDigest,
      authorizationDigest: "unbound",
      inputDigest: input.inputDigest,
      actionID: input.actionID,
      resources: [...input.resources],
      semantics: input.semantics,
      payload,
      payloadDigest,
    })
    const baseRun: DurableRun.ControlCreateInput = {
      subject: input.controlPlane,
      operation: unboundOperation,
      initiator: "user",
      authority: ActionGateway.authorityFor(riskTier),
      riskTier,
      reasonSummary: input.reasonSummary,
      budget,
      traceID: input.actionID,
      visibility: "details",
    }
    const runID = DurableRun.controlRunID(baseRun)
    if (!runID) throw new Error("control run identity must be canonical")
    const boundInput = { ...input, runID }
    const authorization = { requests: [{ action: "mcp.connect", resources: ["server-a"] }] }
    return {
      input: boundInput,
      authorization,
      run: {
        ...baseRun,
        operation: AgentRuntime.ControlOperationSnapshot.make({
          ...unboundOperation,
          authorizationDigest: ActionGateway.intentDigestOf(boundInput, authorization),
        }),
      } satisfies DurableRun.ControlCreateInput,
    }
  }

  const prepareBoundControlRun = (
    bound: ReturnType<typeof boundControlRun>,
    status: AgentRuntime.RunStatus = "awaiting_authorization",
    run: DurableRun.ControlCreateInput = bound.run,
    ttlMs = 60_000,
  ) =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const claim = yield* runs.claimControl(run)
      const leased = yield* runs.acquireControlLease({
        runID: claim.snapshot.run.id,
        ownerID: "control-coordinator",
        ttlMs,
      })
      const path: ReadonlyArray<AgentRuntime.RunStatus> =
        status === "draft"
          ? []
          : status === "preflight"
            ? ["preflight"]
            : status === "awaiting_authorization"
              ? ["preflight", "awaiting_authorization"]
              : status === "queued"
                ? ["preflight", "queued"]
                : status === "paused"
                  ? ["preflight", "awaiting_authorization", "paused"]
                  : status === "running"
                    ? ["preflight", "queued", "running"]
                    : status === "recovering"
                      ? ["preflight", "queued", "running", "recovering"]
                      : status === "verifying"
                        ? ["preflight", "queued", "running", "verifying"]
                        : status === "completed"
                          ? ["preflight", "queued", "running", "verifying", "completed"]
                          : status === "failed"
                            ? ["preflight", "failed"]
                            : ["cancelled"]
      for (const to of path)
        yield* runs.transitionControl(leased.capability, {
          runID: claim.snapshot.run.id,
          to,
          reason: `test transition to ${to}`,
        })
      return {
        ...bound,
        claim,
        input: { ...bound.input, runLease: leased.capability },
      }
    })

  itEffect.effect("control L3: pending before approval with execute 0, exactly one execution after allow", () =>
    Effect.gen(function* () {
      RuntimeInsight.reset()
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      let executions = 0
      const asked = yield* waitForControlAsked()
      const action = controlInput()
      const fiber = yield* gateway
        .execute(
          action,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.subject.type).toBe("control-plane")
      expect("sessionID" in request).toBe(false)
      // Durable intent is persisted (awaiting approval) before any execution.
      expect(executions).toBe(0)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(fiber)).toBe("connected")
      expect(executions).toBe(1)
      const approvalWait = RuntimeInsight.metrics().find((metric) => metric.name === "approval.wait")
      expect(approvalWait).toMatchObject({
        name: "approval.wait",
        unit: "milliseconds",
        attributes: expect.objectContaining({ actionID: action.actionID, status: "granted" }),
      })
      expect(approvalWait?.value).toBeGreaterThanOrEqual(0)
    }),
  )

  itEffect.effect("control deny keeps execute at 0 and blocks the action", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      let executions = 0
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway
        .execute(
          controlInput(),
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ActionGateway.BlockedError)
      }
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("interrupting the pending control approval keeps execute at 0", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let executions = 0
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway
        .execute(
          controlInput(),
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("terminal supersession wins over a late approval without starting an attempt", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const actions = yield* DurableAction.Service
      const { db } = yield* Database.Service
      let executions = 0
      const action = controlInput()
      const operation = controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected")))
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway.execute(action, operation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)

      yield* gateway.settleSupersededAction(action, operation.authorization, "configuration was replaced")
      expect(yield* authorizer.get(request.id)).toBeUndefined()
      expect((yield* authorizer.list()).some((item) => item.id === request.id)).toBe(false)
      const lateReply = yield* authorizer.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
      expect(lateReply._tag).toBe("Failure")
      if (lateReply._tag === "Failure") expect(Cause.squash(lateReply.cause)).toBeInstanceOf(PermissionV2.NotFoundError)
      const exit = yield* Fiber.await(fiber)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, action.actionID))
        .all()
        .pipe(Effect.orDie)
      const snapshot = yield* actions.load(action.actionID)

      expect(exit._tag).toBe("Failure")
      expect(executions).toBe(0)
      expect(snapshot.action.status).toBe("cancelled")
      expect(rows.filter((row) => row.type === "agent.action.attempt-started.1")).toHaveLength(0)
      expect(rows.filter((row) => row.type === "agent.action.authorization-granted.1")).toHaveLength(0)

      const replay = yield* gateway.execute(action, operation).pipe(Effect.exit)
      expect(replay._tag).toBe("Failure")
      if (replay._tag === "Failure") expect(Cause.squash(replay.cause)).toBeInstanceOf(ActionGateway.BlockedError)
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("execution handoff wins honestly: supersession cannot record a false cancellation", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const actions = yield* DurableAction.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let executions = 0
      const action = controlInput()
      const operation = controlOperation(() =>
        Effect.sync(() => {
          executions += 1
        }).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Deferred.await(release)),
          Effect.as("connected"),
        ),
      )
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway.execute(action, operation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      yield* Deferred.await(entered)

      const cancellation = yield* gateway
        .settleSupersededAction(action, operation.authorization, "too late to cancel honestly")
        .pipe(Effect.exit)
      expect(cancellation._tag).toBe("Failure")
      if (cancellation._tag === "Failure")
        expect(Cause.squash(cancellation.cause)).toBeInstanceOf(ActionGateway.ActionInProgressError)
      expect((yield* actions.load(action.actionID)).action.status).toBe("executing")
      expect(executions).toBe(1)

      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(fiber)).toBe("connected")
      expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
    }),
  )

  itEffect.effect("supersession rejects a changed authorization intent and leaves the original approval pending", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const actions = yield* DurableAction.Service
      let executions = 0
      const action = controlInput()
      const operation = controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected")))
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway.execute(action, operation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)

      const forged = yield* gateway
        .settleSupersededAction(
          action,
          { requests: [{ action: "mcp.connect", resources: ["server-b"] }] },
          "forged cancellation",
        )
        .pipe(Effect.exit)
      expect(forged._tag).toBe("Failure")
      if (forged._tag === "Failure") {
        expect(Cause.squash(forged.cause)).toBeInstanceOf(ActionGateway.ActionIntentMismatchError)
      }
      expect((yield* actions.load(action.actionID)).action.status).toBe("awaiting_approval")
      expect(executions).toBe(0)

      yield* authorizer.reply({ requestID: request.id, reply: "reject" })
      yield* Fiber.await(fiber)
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect(
    "an awaiting-approval control action with a dead ask is re-presented under the SAME identity, never a new project action",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const authorizer = yield* Authorizer.Service
        const actions = yield* DurableAction.Service
        let executions = 0
        const firstAsked = yield* waitForControlAsked()
        const action = controlInput()

        // First presentation asks and waits.
        const firstFiber = yield* gateway
          .execute(
            action,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.forkScoped)
        const firstRequest = yield* Deferred.await(firstAsked)
        // The pending ask is dropped by interrupting the attempt (simulates a
        // runtime rebuild abandoning the ask without ever approving it).
        yield* Fiber.interrupt(firstFiber)
        expect(executions).toBe(0)

        // Re-presenting the SAME durable identity re-asks under the same
        // action (no duplicate durable action), and the authorizer binds the
        // same request identity through the re-presented control subject.
        const secondAsked = yield* waitForControlAsked()
        const secondFiber = yield* gateway
          .execute(
            action,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.forkScoped)
        const secondRequest = yield* Deferred.await(secondAsked)
        expect(secondRequest.id).not.toBe(firstRequest.id)
        expect(secondRequest.subject.type).toBe("control-plane")
        const secondRequestID =
          secondRequest.subject.type === "control-plane" ? secondRequest.subject.requestID : undefined
        const firstRequestID =
          firstRequest.subject.type === "control-plane" ? firstRequest.subject.requestID : undefined
        expect(secondRequestID).toBe(firstRequestID)
        const listed = yield* actions.list({ limit: 200 })
        expect(listed.filter(({ action: a }) => a.name === action.name)).toHaveLength(1)
        expect(listed[0]!.action.id).toBe(action.actionID)

        yield* Fiber.interrupt(secondFiber)

        // After the third re-presentation the fresh approval settles the SAME
        // action and the body runs exactly once.
        const thirdAsked = yield* waitForControlAsked()
        const thirdFiber = yield* gateway
          .execute(
            action,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.forkScoped)
        const thirdRequest = yield* Deferred.await(thirdAsked)
        yield* authorizer.reply({ requestID: thirdRequest.id, reply: "once" })
        expect(yield* Fiber.join(thirdFiber)).toBe("connected")
        expect(executions).toBe(1)
        expect((yield* actions.load(action.actionID)).action.status).toBe("settled")
        expect((yield* actions.list({ limit: 200 })).filter(({ action: a }) => a.name === action.name)).toHaveLength(1)
      }),
  )

  itEffect.live("large control results bind the full frozen subject and replay without new approval or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const actions = yield* DurableAction.Service
      const store = yield* ToolOutputStore.Service
      const action = controlInput()
      const asked = yield* waitForControlAsked()
      const value = "控".repeat(400_000)
      let executions = 0
      const operation = {
        ...controlOperation(() =>
          Effect.sync(() => {
            executions++
            return value
          }),
        ),
        durableResult: { encode: (value: string) => value, decode: Schema.decodeUnknownSync(Schema.String) },
      }
      const pending = yield* gateway.execute(action, operation).pipe(Effect.forkScoped)
      yield* authorizer.reply({ requestID: (yield* Deferred.await(asked)).id, reply: "once" })
      expect(yield* Fiber.join(pending)).toBe(value)
      const before = yield* actions.load(action.actionID)
      const output = before.observation?.output
      if (output?.encoding !== "artifact") throw new Error("expected a large control result")
      expect(output.value.owner).toEqual({ scope: "profile", id: `control_${canonicalHash(action.controlPlane)}` })
      expect(JSON.stringify(output.value.owner)).not.toContain(String(action.controlPlane.location))
      const forbidden = yield* store
        .read({ reference: output.value, owner: { scope: "profile", id: "control_foreign" } })
        .pipe(Effect.exit)
      expect(Exit.isFailure(forbidden)).toBe(true)
      expect(yield* gateway.execute(action, operation)).toBe(value)
      expect(executions).toBe(1)
      expect((yield* actions.load(action.actionID)).lastSequence).toBe(before.lastSequence)
    }),
  )

  itEffect.effect("a settled control action never re-asks or re-executes", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      let executions = 0
      const action = controlInput()
      const asked = yield* waitForControlAsked()
      const first = yield* gateway
        .execute(
          action,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(first)).toBe("connected")
      expect(executions).toBe(1)
      // The same durable identity is already settled: replay fails closed with
      // AlreadySettledError instead of asking again or running a second side
      // effect. (A2 binds a durableResult so a recoverable result can replay.)
      const replay = yield* gateway
        .execute(
          action,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)
      expect(replay._tag).toBe("Failure")
      if (replay._tag === "Failure") {
        const error = Cause.squash(replay.cause)
        expect(error).toBeInstanceOf(ActionGateway.AlreadySettledError)
      }
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("replays a completed control run only from its settled durable result", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const runs = yield* DurableRun.Service
      let executions = 0
      const bound = yield* prepareBoundControlRun(boundControlRun(), "awaiting_authorization")
      const operation = {
        authorization: bound.authorization,
        durableResult: {
          encode: (value: string) => value,
          decode: (value: unknown) => {
            if (typeof value !== "string") throw new Error("invalid control replay result")
            return value
          },
        },
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "connected"
          }),
        successSummary: () => "connected",
      }
      const asked = yield* waitForControlAsked()
      const first = yield* gateway.execute(bound.input, operation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(first)).toBe("connected")
      expect(executions).toBe(1)

      const lease = bound.input.runLease
      if (!lease) throw new Error("expected a bound control lease")
      yield* runs.transitionControl(lease, {
        runID: bound.input.runID!,
        to: "queued",
        reason: "test replay queue",
      })
      yield* runs.transitionControl(lease, {
        runID: bound.input.runID!,
        to: "running",
        reason: "test replay running",
      })
      yield* runs.transitionControl(lease, {
        runID: bound.input.runID!,
        to: "verifying",
        reason: "test replay verifying",
      })
      yield* runs.transitionControl(lease, {
        runID: bound.input.runID!,
        to: "completed",
        reason: "test replay completed",
      })

      const replayed = yield* gateway.execute({ ...bound.input, allowSettledReplay: true }, operation)
      expect(replayed).toBe("connected")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("does not replay a completed control run when the Action has no durable result", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      const actions = yield* DurableAction.Service
      const runs = yield* DurableRun.Service
      let executions = 0
      const bound = yield* prepareBoundControlRun(boundControlRun(), "awaiting_authorization")
      const operation = {
        authorization: bound.authorization,
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "connected"
          }),
        successSummary: () => "connected",
      }
      const asked = yield* waitForControlAsked()
      const first = yield* gateway.execute(bound.input, operation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(first)).toBe("connected")
      expect(executions).toBe(1)
      expect((yield* actions.load(bound.input.actionID)).observation?.output).toBeUndefined()

      const lease = bound.input.runLease
      if (!lease) throw new Error("expected a bound control lease")
      for (const to of ["queued", "running", "verifying", "completed"] as const)
        yield* runs.transitionControl(lease, {
          runID: bound.input.runID!,
          to,
          reason: `test missing-result replay ${to}`,
        })

      const replay = yield* gateway
        .execute(
          { ...bound.input, allowSettledReplay: true },
          {
            ...operation,
            durableResult: {
              encode: (value: string) => value,
              decode: (value: unknown) => {
                if (typeof value !== "string") throw new Error("invalid control replay result")
                return value
              },
            },
          },
        )
        .pipe(Effect.exit)
      expect(replay._tag).toBe("Failure")
      if (replay._tag === "Failure") expect(Cause.squash(replay.cause)).toBeInstanceOf(ActionGateway.BlockedError)
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("allows only an explicitly marked safely recoverable control run to resume", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let executions = 0
      const bound = yield* prepareBoundControlRun(boundControlRun("L1"), "running")
      const operation = {
        authorization: bound.authorization,
        execute: () =>
          Effect.sync(() => {
            executions += 1
            return "recovered"
          }),
        successSummary: () => "recovered",
      }
      const rejected = yield* gateway.execute(bound.input, operation).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
      if (rejected._tag === "Failure") expect(Cause.squash(rejected.cause)).toBeInstanceOf(ActionGateway.BlockedError)
      const fiber = yield* gateway
        .execute({ ...bound.input, allowControlRecovery: true }, operation)
        .pipe(Effect.forkScoped)
      expect(yield* Fiber.join(fiber)).toBe("recovered")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("a fresh control request identity asks afresh even after an earlier allow", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const authorizer = yield* Authorizer.Service
      let executions = 0
      for (let attempt = 0; attempt < 2; attempt++) {
        const asked = yield* waitForControlAsked()
        const fiber = yield* gateway
          .execute(
            controlInput(),
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.forkScoped)
        const request = yield* Deferred.await(asked)
        yield* authorizer.reply({ requestID: request.id, reply: "once" })
        yield* Fiber.join(fiber)
      }
      // Both fresh requests executed exactly once each; no saved allow
      // shortcut existed between them.
      expect(executions).toBe(2)
    }),
  )

  itEffect.effect("forged control identity fails closed before any approval or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let executions = 0
      const exit = yield* gateway
        .execute(
          controlInput({
            actionID: AgentRuntime.ActionID.create(),
          }),
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      }
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("unbound L1 and unsupported control tiers fail closed", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let executions = 0
      for (const tier of ["L0", "L1", "L2", "L4"] as const) {
        const exit = yield* gateway
          .execute(
            controlInput({ semantics: semantics(tier) }),
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.exit)
        expect(exit._tag, tier).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error, tier).toBeInstanceOf(ActionGateway.BlockedError)
        }
      }
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("an unknown control run fails closed before approval or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      let executions = 0
      const exit = yield* gateway
        .execute(
          controlInput({ runID: AgentRuntime.RunID.create() }),
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      }
      expect(executions).toBe(0)
    }),
  )

  itEffect.effect("a matching durable control run binds approval, action, and execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const runs = yield* DurableRun.Service
      const authorizer = yield* Authorizer.Service
      const bound = boundControlRun()
      const prepared = yield* prepareBoundControlRun(bound)
      let executions = 0
      const asked = yield* waitForControlAsked()
      const fiber = yield* gateway
        .execute(
          prepared.input,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.subject).toEqual(prepared.claim.snapshot.run.subject)
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      expect(yield* Fiber.join(fiber)).toBe("connected")
      expect(executions).toBe(1)
    }),
  )

  itEffect.effect("draft and paused control runs fail before proposal, approval, attempt, or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const published = yield* observeControlExecutionEvents()
      let executions = 0

      for (const status of ["draft", "paused"] as const) {
        const prepared = yield* prepareBoundControlRun(boundControlRun(), status)
        const exit = yield* gateway
          .execute(
            prepared.input,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.exit)
        expect(exit._tag, status).toBe("Failure")
        if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(ActionGateway.BlockedError)
      }

      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect("a lease capability from another control run cannot authorize this run", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const first = yield* prepareBoundControlRun(boundControlRun())
      const second = yield* prepareBoundControlRun(boundControlRun())
      const published = yield* observeControlExecutionEvents()
      let executions = 0

      const exit = yield* gateway
        .execute(
          { ...first.input, runLease: second.input.runLease },
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect("an expired old-generation run lease fails before proposal, approval, attempt, or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const runs = yield* DurableRun.Service
      const prepared = yield* prepareBoundControlRun(boundControlRun(), "awaiting_authorization", undefined, 1_000)
      yield* TestClock.adjust("1001 millis")
      yield* runs.acquireControlLease({
        runID: prepared.claim.snapshot.run.id,
        ownerID: "replacement-coordinator",
        ttlMs: 1_000,
      })
      const published = yield* observeControlExecutionEvents()
      let executions = 0

      const exit = yield* gateway
        .execute(
          prepared.input,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect("lease takeover after an approval ask prevents grant, attempt, and execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const runs = yield* DurableRun.Service
      const authorizer = yield* Authorizer.Service
      const prepared = yield* prepareBoundControlRun(boundControlRun(), "awaiting_authorization", undefined, 1_000)
      const published = yield* observeControlExecutionEvents()
      const asked = yield* waitForControlAsked()
      let executions = 0
      const fiber = yield* gateway
        .execute(
          prepared.input,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)

      yield* TestClock.adjust("1001 millis")
      yield* runs.acquireControlLease({
        runID: prepared.claim.snapshot.run.id,
        ownerID: "replacement-coordinator",
        ttlMs: 1_000,
      })
      yield* authorizer.reply({ requestID: request.id, reply: "once" })
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      expect(executions).toBe(0)
      expect(published).toContain(AgentRuntime.Event.ActionProposed.type)
      expect(published).toContain(AgentRuntime.ControlEvent.Asked.type)
      expect(published).not.toContain(AgentRuntime.Event.ActionAuthorizationGranted.type)
      expect(published).not.toContain(AgentRuntime.Event.ActionAttemptStarted.type)
    }),
  )

  itEffect.effect("a control run with a different frozen authorization intent fails before approval or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const runs = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const bound = boundControlRun()
      const forged: DurableRun.ControlCreateInput = {
        ...bound.run,
        operation: AgentRuntime.ControlOperationSnapshot.make({
          ...bound.run.operation,
          authorizationDigest: "forged-authorization-intent",
        }),
      }
      const prepared = yield* prepareBoundControlRun(bound, "awaiting_authorization", forged)
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            event.type === AgentRuntime.Event.ActionProposed.type ||
            event.type === AgentRuntime.ControlEvent.Asked.type ||
            event.type === AgentRuntime.Event.ActionAttemptStarted.type
          )
            published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      let executions = 0

      const exit = yield* gateway
        .execute(
          prepared.input,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect(
    "a bound control run rejects project, location, request, and action forgeries before permission",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const runs = yield* DurableRun.Service
        const events = yield* EventV2.Service
        const bound = boundControlRun()
        const prepared = yield* prepareBoundControlRun(bound)
        const published: string[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (
              event.type === AgentRuntime.Event.ActionProposed.type ||
              event.type === AgentRuntime.ControlEvent.Asked.type ||
              event.type === AgentRuntime.Event.ActionAttemptStarted.type
            )
              published.push(event.type)
          }).pipe(Effect.asVoid),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        let executions = 0
        const forgedInputs: ReadonlyArray<ActionGateway.Input> = [
          {
            ...prepared.input,
            controlPlane: { ...prepared.input.controlPlane, project: Project.ID.make("pr_other-project") },
          },
          {
            ...prepared.input,
            controlPlane: { ...prepared.input.controlPlane, location: AbsolutePath.make("/other-project") },
          },
          {
            ...prepared.input,
            controlPlane: {
              ...prepared.input.controlPlane,
              requestID: AgentRuntime.ControlPlaneRequestID.create(),
            },
          },
          { ...prepared.input, actionID: AgentRuntime.ActionID.create() },
        ]
        for (const forged of forgedInputs) {
          const exit = yield* gateway
            .execute(
              forged,
              controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
            )
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure")
            expect(Cause.squash(exit.cause)).toBeInstanceOf(ActionGateway.InvalidSubjectError)
        }
        expect(executions).toBe(0)
        expect(published).toEqual([])
      }),
  )

  itEffect.effect("a terminal or corrupt control run fails closed before approval or execution", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const runs = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const terminal = yield* prepareBoundControlRun(boundControlRun(), "completed")
      const corrupt = yield* prepareBoundControlRun(boundControlRun())
      const beforeCorrupt = yield* runs.load(corrupt.claim.snapshot.run.id)
      yield* events.publish(
        AgentRuntime.Event.RunStateChanged,
        {
          runID: corrupt.claim.snapshot.run.id,
          sessionID: SessionSchema.ID.create(),
          from: "draft",
          to: "preflight",
          reason: "forged session event",
          changedAt: DateTime.makeUnsafe(1),
        },
        { expectedSequence: beforeCorrupt.lastSequence },
      )
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            event.type === AgentRuntime.Event.ActionProposed.type ||
            event.type === AgentRuntime.ControlEvent.Asked.type ||
            event.type === AgentRuntime.Event.ActionAttemptStarted.type
          )
            published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      let executions = 0
      for (const action of [terminal.input, corrupt.input]) {
        const exit = yield* gateway
          .execute(
            action,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect(
    "runtime-forged control input carrying session fields fails closed before any event or execution",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const events = yield* EventV2.Service
        let executions = 0
        const published: string[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (
              event.type === AgentRuntime.Event.ActionProposed.type ||
              event.type === AgentRuntime.ControlEvent.Asked.type ||
              event.type === AgentRuntime.Event.ActionAttemptStarted.type
            )
              published.push(event.type)
          }).pipe(Effect.asVoid),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        // TypeScript unions are not a runtime boundary: forge a control input
        // that also carries every session identity field.
        const forged = {
          ...controlInput(),
          sessionID: SessionSchema.ID.create(),
          agent: AgentV2.ID.make("build"),
          assistantMessageID: SessionMessage.ID.create(),
          toolCallID: "call-forged",
        } as unknown as ActionGateway.Input
        const exit = yield* gateway
          .execute(
            forged,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(ActionGateway.InvalidSubjectError)
        }
        expect(executions).toBe(0)
        expect(published).toEqual([])
      }),
  )

  itEffect.effect("runtime-forged session input carrying a control-plane subject fails closed", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const events = yield* EventV2.Service
      let executions = 0
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            event.type === AgentRuntime.Event.ActionProposed.type ||
            event.type === AgentRuntime.ControlEvent.Asked.type ||
            event.type === AgentRuntime.Event.ActionAttemptStarted.type
          )
            published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const forged = {
        ...input("L3"),
        controlPlane: controlSubject(),
      } as unknown as ActionGateway.Input
      const exit = yield* gateway
        .execute(
          forged,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      }
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect("runtime-forged session input missing the agent fails closed", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const events = yield* EventV2.Service
      let executions = 0
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            event.type === AgentRuntime.Event.ActionProposed.type ||
            event.type === AgentRuntime.ControlEvent.Asked.type ||
            event.type === PermissionV2.Event.Asked.type ||
            event.type === AgentRuntime.Event.ActionAttemptStarted.type
          )
            published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const forged = { ...input("L3") }
      delete (forged as { agent?: unknown }).agent
      const exit = yield* gateway
        .execute(
          forged as unknown as ActionGateway.Input,
          controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(ActionGateway.InvalidSubjectError)
      }
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect("runtime-forged session input with an unknown discriminator fails closed", () =>
    Effect.gen(function* () {
      const gateway = yield* ActionGateway.Service
      const events = yield* EventV2.Service
      let executions = 0
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (
            event.type === AgentRuntime.Event.ActionProposed.type ||
            event.type === AgentRuntime.ControlEvent.Asked.type ||
            event.type === PermissionV2.Event.Asked.type ||
            event.type === AgentRuntime.Event.ActionAttemptStarted.type
          )
            published.push(event.type)
        }).pipe(Effect.asVoid),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      for (const kind of ["forged", null]) {
        const forged = { ...input("L3"), kind } as unknown as ActionGateway.Input
        const exit = yield* gateway
          .execute(
            forged,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.exit)
        expect(exit._tag, String(kind)).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          expect(error, String(kind)).toBeInstanceOf(ActionGateway.InvalidSubjectError)
        }
      }
      expect(executions).toBe(0)
      expect(published).toEqual([])
    }),
  )

  itEffect.effect(
    "control durable action, grant, and events never carry session identity and bind the full subject",
    () =>
      Effect.gen(function* () {
        const gateway = yield* ActionGateway.Service
        const authorizer = yield* Authorizer.Service
        const durable = yield* DurableAction.Service
        const events = yield* EventV2.Service
        let executions = 0
        const recorded: Array<{ type: string; data: unknown }> = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (
              event.type === AgentRuntime.Event.ActionProposed.type ||
              event.type === AgentRuntime.Event.ActionAuthorizationGranted.type
            )
              recorded.push({ type: event.type, data: event.data })
          }).pipe(Effect.asVoid),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const action = controlInput()
        const asked = yield* waitForControlAsked()
        const fiber = yield* gateway
          .execute(
            action,
            controlOperation(() => Effect.sync(() => executions++).pipe(Effect.as("connected"))),
          )
          .pipe(Effect.forkScoped)
        const request = yield* Deferred.await(asked)
        yield* authorizer.reply({ requestID: request.id, reply: "once" })
        expect(yield* Fiber.join(fiber)).toBe("connected")
        const snapshot = yield* durable.load(action.actionID)
        // The durable action carries only the control-plane subject.
        if ("sessionID" in snapshot.action || "agent" in snapshot.action)
          throw new Error("control durable action must never carry session identity fields")
        expect(snapshot.action.subject).toEqual(action.controlPlane)
        // The durable grant carries only the control-plane subject, exactly
        // matching the input subject.
        if (!snapshot.authorization) throw new Error("expected a durable grant")
        if (
          "sessionID" in snapshot.authorization ||
          "agent" in snapshot.authorization ||
          "assistantMessageID" in snapshot.authorization ||
          "toolCallID" in snapshot.authorization
        )
          throw new Error("control durable grant must never carry session identity fields")
        expect(snapshot.authorization.subject).toEqual(action.controlPlane)
        // Events carry the subject and never a sessionID field.
        for (const { type, data } of recorded) {
          const payload = data as Record<string, unknown>
          expect("sessionID" in payload, type).toBe(false)
          if (type === AgentRuntime.Event.ActionProposed.type) {
            const inner = payload.action as Record<string, unknown>
            if ("sessionID" in inner || "agent" in inner || "assistantMessageID" in inner || "toolCallID" in inner)
              throw new Error("control proposed event action must never carry session identity fields")
            expect(inner.subject).toEqual(action.controlPlane)
          }
          if (type === AgentRuntime.Event.ActionAuthorizationGranted.type) {
            const inner = payload.grant as Record<string, unknown>
            if ("sessionID" in inner || "agent" in inner || "assistantMessageID" in inner || "toolCallID" in inner)
              throw new Error("control granted event grant must never carry session identity fields")
            expect(inner.subject).toEqual(action.controlPlane)
          }
        }
      }),
  )
})
