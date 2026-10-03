// Test-only fresh process. Reuses the original credential, model, event and
// transport owners; this is not a product recovery dispatcher.
const [directory, endpoint, mode] = Bun.argv.slice(2)
if (!directory || !endpoint || !["seed", "unchanged", "replace", "remove", "new-id"].includes(mode ?? ""))
  throw new Error("Invalid request rebuild fixture arguments")
if (new URL(endpoint).hostname !== "127.0.0.1") throw new Error("Only the local fixture provider is allowed")
process.env.ARFORGE_HOME = directory
process.env.ARFORGE_TEST_HOME = directory
process.env.ARFORGE_DB = `${directory}/requests.sqlite`
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""

const { Effect, Layer, DateTime, Schema, Stream, Exit, Cause } = await import("effect")
const { LLM, LLMClient, LLMEvent } = await import("@arforge-ai/llm")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { LayerNodePlatform } = await import("@arforge-ai/core/effect/app-node-platform")
const { Database } = await import("@arforge-ai/core/database/database")
const { Credential } = await import("@arforge-ai/core/credential")
const { SecretProvider } = await import("@arforge-ai/core/secret-provider")
const { Catalog } = await import("@arforge-ai/core/catalog")
const { Integration } = await import("@arforge-ai/core/integration")
const { ModelV2 } = await import("@arforge-ai/core/model")
const { ProviderV2 } = await import("@arforge-ai/core/provider")
const { Location } = await import("@arforge-ai/core/location")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { ProjectID } = await import("@arforge-ai/schema/project-id")
const { SessionSchema } = await import("@arforge-ai/core/session/schema")
const { SessionRunnerModel } = await import("@arforge-ai/core/session/runner/model")
const { EventV2 } = await import("@arforge-ai/core/event")
const { EventTable } = await import("@arforge-ai/core/event/sql")
const { SessionEvent } = await import("@arforge-ai/core/session/event")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const {
  createRequestEnvelope,
  requestEnvelopeJson,
  parseRequestEnvelopeJson,
  rebuildRequest,
  assertPreparedRequestEnvelope,
} = await import("@arforge-ai/core/session/request-envelope")
const { eq } = await import("drizzle-orm")

const workspace = AbsolutePath.make(directory)
const providerID = ProviderV2.ID.make("cold-fixture")
const integrationID = Integration.ID.make("cold-fixture")
const modelID = ModelV2.ID.make("cold-model")
const sessionID = SessionSchema.ID.make("ses_cold_request_fixture")
const runID = AgentRuntime.RunID.make("run_cold_request_fixture")
// Actual AES sealing with a public test-only root key, identical in each
// process. No system keychain or user credential is read.
const secrets = SecretProvider.makeAes256Gcm(new Uint8Array(32).fill(43), "request-rebuild-fixture")
const layer = AppNodeBuilder.build(
  LayerNode.group([
    SessionRunnerModel.node,
    Catalog.node,
    Integration.node,
    Credential.node,
    EventV2.node,
    Database.node,
    LayerNodePlatform.llmClient,
  ]),
  [
    [Database.node, Database.layerFromPath(`${directory}/requests.sqlite`)],
    [SecretProvider.node, Layer.succeed(SecretProvider.Service, secrets)],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of({ directory: workspace, project: { id: ProjectID.make("global"), directory: workspace } }),
      ),
    ],
  ],
)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const models = yield* SessionRunnerModel.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    yield* integrations.transform((editor) =>
      editor.update(integrationID, (draft) => {
        draft.name = "Cold fixture"
      }),
    )
    yield* catalog.transform((editor) => {
      editor.provider.update(providerID, (draft) => {
        draft.integrationID = integrationID
        draft.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: endpoint }
      })
      editor.model.update(providerID, modelID, (draft) => {
        draft.api = { id: modelID, type: "aisdk", package: "@ai-sdk/openai-compatible", url: endpoint }
        draft.enabled = true
        draft.capabilities = { tools: true, input: ["text"], output: ["text"] }
        draft.request = { headers: {}, body: { fixture_overlay: "original" } }
      })
    })
    const session = SessionSchema.Info.make({
      id: sessionID,
      projectID: ProjectID.make("global"),
      title: "Cold fixture",
      model: { id: modelID, providerID },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: { directory: workspace },
    })
    if (mode === "seed") {
      const credential = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "fixture-original-key" }),
      })
      const model = yield* models.resolve(session)
      const identity = SessionRunnerModel.credentialIdentity(model)
      if (identity?.id !== credential.id || identity.version !== credential.version)
        throw new Error("Seed model did not bind the actual stored credential")
      const request = LLM.request({
        model,
        prompt: "Keep this exact cold request",
        generation: { temperature: 0.2, maxTokens: 64 },
        http: { body: { fixture_request: "original" } },
      })
      const prepared = yield* LLMClient.prepare(request)
      const envelope = createRequestEnvelope({
        request,
        transmission: prepared.transmission,
        execution: { run_id: runID, turn_step: 1, attempt: 1, credential_identity: identity },
      })
      yield* events.project(SessionEvent.RequestEnvelopePrepared, () => Effect.void)
      const receipt = yield* events.publish(SessionEvent.RequestEnvelopePrepared, {
        sessionID,
        timestamp: DateTime.makeUnsafe(0),
        runID,
        turnStep: 1,
        attempt: 1,
        schemaVersion: "1.0",
        requestDigest: envelope.request_digest,
        envelope: requestEnvelopeJson(envelope),
      })
      const committed = yield* EventV2.readCommitted(db, SessionEvent.RequestEnvelopePrepared, receipt)
      const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(committed.data)
      return { pid: process.pid, seeded: true, eventID: committed.id, envelope: data.envelope }
    }

    const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
    if (rows.length !== 1 || rows[0].type !== EventV2.versionedType(SessionEvent.RequestEnvelopePrepared.type, 1))
      throw new Error("Expected exactly one committed request event")
    const row = rows[0]
    const data = Schema.decodeUnknownSync(SessionEvent.RequestEnvelopePrepared.data)(row.data)
    const envelope = parseRequestEnvelopeJson(data.envelope)
    if (data.requestDigest !== envelope.request_digest || data.runID !== envelope.execution.run_id)
      throw new Error("Committed event does not bind the original request")
    const original = envelope.execution.credential_identity
    if (!original) throw new Error("Missing seed identity")
    const originalID = Credential.ID.make(original.id)
    if (mode === "replace")
      yield* credentials.update(originalID, { value: Credential.Key.make({ type: "key", key: "fixture-new-key" }) })
    if (mode === "remove") yield* credentials.remove(originalID)
    if (mode === "new-id")
      yield* credentials.create({ integrationID, value: Credential.Key.make({ type: "key", key: "fixture-new-key" }) })
    let resolvedIdentity: { readonly id: string; readonly version: string } | undefined
    const rebuilt = yield* Effect.gen(function* () {
      const model = yield* models.resolve(session)
      resolvedIdentity = SessionRunnerModel.credentialIdentity(model)
      yield* SessionRunnerModel.validateCredential(model)
      const request = rebuildRequest(envelope, model, resolvedIdentity)
      const prepared = yield* LLMClient.prepare(request)
      assertPreparedRequestEnvelope(envelope, prepared)
      yield* SessionRunnerModel.validateCredential(model)
      const output = yield* LLMClient.streamPrepared(prepared).pipe(Stream.runCollect)
      return output
        .filter(LLMEvent.is.textDelta)
        .map((event) => event.text)
        .join("")
    }).pipe(Effect.exit)
    const after = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
    return {
      pid: process.pid,
      eventID: row.id,
      eventUnchanged: JSON.stringify(after) === JSON.stringify(rows),
      envelope: data.envelope,
      resolvedIdentity,
      success: Exit.isSuccess(rebuilt),
      ...(Exit.isSuccess(rebuilt) ? { answer: rebuilt.value } : { error: Cause.pretty(rebuilt.cause) }),
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
process.stdout.write(JSON.stringify(result))
