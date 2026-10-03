import { describe, expect, test } from "bun:test"
import { DateTime, Option, Schema } from "effect"
import { AgentRuntime } from "../src/agent-runtime"
import { Permission } from "../src/permission"
import { SessionID } from "../src/session-id"
import { ProjectID } from "../src/project-id"

const epoch = DateTime.makeUnsafe("1970-01-01T00:00:00Z")

const controlSubject = () =>
  AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: AgentRuntime.ControlPlaneID.create(),
    location: Schema.decodeSync(AgentRuntime.ControlPlaneSubject.fields.location)("/project"),
    project: ProjectID.global,
    actor: "user",
    principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
    requestID: AgentRuntime.ControlPlaneRequestID.create(),
  })

const sessionSubject = () =>
  AgentRuntime.SessionSubject.make({
    type: "session",
    sessionID: SessionID.create(),
    agent: "build",
    assistantMessageID: "msg_test",
    toolCallID: "call_test",
  })

const common = (riskTier: "L1" | "L3") => ({
  id: AgentRuntime.ActionID.create(),
  name: riskTier === "L3" ? "mcp.connect" : "read",
  status: "proposed" as const,
  semantics: AgentRuntime.EffectSemantics.make({
    riskTier,
    authority: riskTier === "L3" ? ("human" as const) : ("automatic" as const),
    idempotency: riskTier === "L3" ? ("non_idempotent" as const) : ("idempotent" as const),
    retryability: riskTier === "L3" ? ("never" as const) : ("safe" as const),
    reversibility: riskTier === "L3" ? ("irreversible" as const) : ("not_applicable" as const),
    filesystemScope: [],
    networkScope: [],
    secretScope: [],
    externalServices: [],
    expectedArtifacts: [],
    successCriteria: [],
  }),
  resources: [],
  idempotencyKey: "k",
  initiator: "agent" as const,
  authority: riskTier === "L3" ? ("human" as const) : ("automatic" as const),
  riskTier,
  reasonSummary: "test",
  budget: AgentRuntime.Budget.make({
    maxAttempts: 1,
    maxDurationMs: 1,
    maxCostMicros: 0,
    maxTokens: 1_000_000,
    attemptsUsed: 0,
    durationMsUsed: 0,
    costMicrosUsed: 0,
    tokensUsed: 0,
  }),
  traceID: "t",
  visibility: "details" as const,
  time: { created: epoch, updated: epoch },
})

describe("AgentRuntime subject contract", () => {
  test("control-plane subject binds location, project, principal, actor, and request identity", () => {
    const subject = controlSubject()
    expect(subject.type).toBe("control-plane")
    expect(subject.actor).toBe("user")
    expect(subject.principalRef).toStartWith("prn_")
    expect(subject.id).toStartWith("ctl_")
    expect(subject.requestID).toStartWith("cpr_")
    expect(String(subject.location)).toBe("/project")
    expect(subject.project).toBe(ProjectID.global)
  })

  test("control-plane principal reference is required and branded", () => {
    const subject = controlSubject()
    const encoded = Schema.encodeSync(AgentRuntime.ControlPlaneSubject)(subject) as Record<string, unknown>
    delete encoded.principalRef
    expect(Option.isNone(Schema.decodeUnknownOption(AgentRuntime.ControlPlaneSubject)(encoded))).toBe(true)
    expect(Option.isSome(Schema.decodeUnknownOption(AgentRuntime.ControlPrincipalRef)(subject.principalRef))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(AgentRuntime.ControlPrincipalRef)("ctl_wrong"))).toBe(true)
  })

  test("control-plane identity brands are distinct from session identity", () => {
    // A control-plane ID can never decode as a SessionID and vice versa.
    const forged = controlSubject()
    expect(Option.isSome(Schema.decodeUnknownOption(AgentRuntime.ControlPlaneID)(forged.id))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(SessionID)(forged.id))).toBe(true)
  })

  test("subject roundtrip preserves the discriminated variant", () => {
    const control = controlSubject()
    expect(Schema.decodeUnknownSync(AgentRuntime.Subject)(Schema.encodeSync(AgentRuntime.Subject)(control))).toEqual(
      control,
    )
    const session = sessionSubject()
    expect(Schema.decodeUnknownSync(AgentRuntime.Subject)(Schema.encodeSync(AgentRuntime.Subject)(session))).toEqual(
      session,
    )
  })

  test("control subject never appears in a sessionID field", () => {
    const action = AgentRuntime.SessionAction.make({
      ...common("L1"),
      sessionID: sessionSubject().sessionID,
      subject: sessionSubject(),
    })
    expect("sessionID" in action).toBe(true)
    expect(action.sessionID).toStartWith("ses_")
    // The control-plane variant has no sessionID field at all.
    const controlAction = AgentRuntime.ControlAction.make({
      ...common("L3"),
      subject: controlSubject(),
    })
    expect("sessionID" in controlAction).toBe(false)
    expect(controlAction.subject.type).toBe("control-plane")
  })

  test("a session action carrying a control-plane subject fails decode", () => {
    const forged = {
      ...common("L1"),
      sessionID: sessionSubject().sessionID,
      subject: controlSubject(),
    }
    expect(Option.isNone(Schema.decodeUnknownOption(AgentRuntime.SessionAction)(forged))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(AgentRuntime.Action)(forged))).toBe(true)
  })

  test("legacy session actions and grants decode unchanged without a subject", () => {
    const legacyAction = {
      ...common("L1"),
      sessionID: SessionID.create(),
      time: { created: 0, updated: 0 },
    }
    const decoded = Schema.decodeUnknownSync(AgentRuntime.Action)(legacyAction)
    if (!("sessionID" in decoded)) throw new Error("legacy action must decode as a session action")
    expect(decoded.sessionID).toBe(legacyAction.sessionID)
    expect(decoded.subject).toBeUndefined()

    const legacyGrant = {
      id: AgentRuntime.AuthorizationGrantID.create(),
      actionID: AgentRuntime.ActionID.create(),
      sessionID: SessionID.create(),
      agent: "build",
      assistantMessageID: "msg_test",
      toolCallID: "call_test",
      toolName: "read",
      requests: [{ action: "read", resources: ["a"] }],
      authority: "human",
      riskTier: "L3",
      policyVersion: "v1",
      bindingDigest: "d",
      proofProvider: "p",
      proof: "proof",
      issuedAt: 0,
      expiresAt: 1,
    }
    const grant = Schema.decodeUnknownSync(AgentRuntime.AuthorizationGrant)(legacyGrant)
    if (!("sessionID" in grant)) throw new Error("legacy grant must decode as a session grant")
    expect(grant.sessionID).toBe(legacyGrant.sessionID)
    expect(grant.subject).toBeUndefined()
  })

  test("legacy session permission requests decode unchanged", () => {
    const legacyRequest = {
      id: Permission.ID.create(),
      sessionID: SessionID.create(),
      action: "read",
      resources: ["a"],
    }
    const decoded = Schema.decodeUnknownSync(Permission.Request)(legacyRequest)
    expect(decoded.sessionID).toBe(legacyRequest.sessionID)
  })

  test("control request contract carries only the control-plane subject", () => {
    const request = AgentRuntime.ControlRequest.make({
      id: Permission.ID.create(),
      subject: controlSubject(),
      action: "mcp.connect",
      resources: ["server"],
    })
    expect("sessionID" in request).toBe(false)
    expect(Schema.decodeUnknownSync(AgentRuntime.ControlRequest)(request)).toEqual(request)
    // A control request can never be decoded as a legacy session permission request.
    expect(Option.isNone(Schema.decodeUnknownOption(Permission.Request)(request))).toBe(true)
  })

  test("control run freezes a versioned JSON-only operation snapshot in the @2 event family", () => {
    const subject = controlSubject()
    const operation = AgentRuntime.ControlOperationSnapshot.make({
      version: 1,
      id: AgentRuntime.ControlOperationID.create(),
      kind: "worktree.create",
      generation: 0,
      policyVersion: "arforge-risk/1",
      claimDigest: "claim-digest",
      authorizationDigest: "authorization-digest",
      inputDigest: "input-digest",
      actionID: AgentRuntime.ActionID.create(),
      resources: ["filesystem", "git"],
      semantics: common("L3").semantics,
      payload: { commit: "abc123", target: "sandbox" },
      payloadDigest: "payload-digest",
    })
    const run = AgentRuntime.ControlRun.make({
      id: AgentRuntime.RunID.create(),
      subject,
      operation,
      status: "preflight",
      initiator: "user",
      authority: "human",
      riskTier: "L3",
      reasonSummary: "Create an approved worktree",
      budget: common("L3").budget,
      traceID: "control-trace",
      visibility: "details",
      time: { created: epoch, updated: epoch },
    })

    expect("sessionID" in run).toBe(false)
    expect(Schema.decodeUnknownSync(AgentRuntime.Run)(Schema.encodeSync(AgentRuntime.Run)(run))).toEqual(run)
    expect(AgentRuntime.Event.ControlRunCreated.durable?.version).toBe(2)
    expect(AgentRuntime.Event.ControlRunCreated.durable?.aggregate).toBe("runID")
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(AgentRuntime.ControlOperationSnapshot)({
          ...operation,
          payload: () => "not JSON",
        }),
      ),
    ).toBe(true)
  })
})
