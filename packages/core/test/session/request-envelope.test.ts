import { expect, test } from "bun:test"

import { LLM, Model as LLMModel } from "@arforge-ai/llm"
import {
  assertRequestEnvelope,
  createRequestEnvelope,
  parseRequestEnvelopeJson,
  parseActionRequestEnvelope,
  rebuildRequest,
  requestEnvelopeJson,
  assertPreparedRequestEnvelope,
} from "../../src/session/request-envelope"

import { PreparedRequest, RouteID } from "@arforge-ai/llm"
import { Auth, LLMClient } from "@arforge-ai/llm/route"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import { Effect } from "effect"

const model = LLMModel.make({
  id: "model-a",
  provider: "provider-a",
  route: {
    id: "route-a",
    protocol: "openai-chat",
    endpoint: { baseURL: "https://provider.example/v1", query: { region: "test" } },
  } as never,
})

const makeRequest = (overrides: Record<string, unknown> = {}, requestModel = model) =>
  LLM.request({
    model: requestModel,
    system: "You are a careful assistant.",
    messages: [{ role: "user", content: "keep the request deterministic" }],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    providerOptions: { openai: { promptCacheKey: "cache-key-1" } },
    generation: { maxTokens: 512, temperature: 0 },
    metadata: { surface: "test", revision: 1 },
    ...overrides,
  })

test("final transmission is durable and independently checked against the preparation", () => {
  const request = makeRequest()
  const prepared = new PreparedRequest({
    id: "prepared-test",
    model,
    route: RouteID.make(model.route.id),
    protocol: model.route.protocol,
    body: { preview: true },
    transmission: {
      transport: "http",
      endpoint: { url: "https://provider.example/v1/chat", exact: true },
      body: { messages: [{ role: "user", content: "original" }], overlay: true },
    },
  })
  const envelope = createRequestEnvelope({ request, transmission: prepared.transmission })
  const restored = parseRequestEnvelopeJson(requestEnvelopeJson(envelope))
  expect(prepared.transmission).toEqual(restored.request.transmission)
  expect(assertPreparedRequestEnvelope(restored, prepared)).toBe(true)
  expect(assertRequestEnvelope(restored, rebuildRequest(restored, model))).toBe(true)
  const changed = new PreparedRequest({
    ...prepared,
    transmission: { ...prepared.transmission!, body: { overlay: false } },
  })
  expect(() => assertPreparedRequestEnvelope(restored, changed)).toThrow("preparation differs")
  const changedEnvelope = createRequestEnvelope({ request, transmission: changed.transmission })
  expect(changedEnvelope.request_digest).not.toBe(envelope.request_digest)
  const wrongRoute = new PreparedRequest({ ...prepared, route: RouteID.make("different-route") })
  expect(() => assertPreparedRequestEnvelope(restored, wrongRoute)).toThrow("preparation differs")
  expect(() => assertPreparedRequestEnvelope(createRequestEnvelope({ request }), prepared)).toThrow("missing")
})

test("unsafe or incomplete final transmission is rejected rather than silently downgraded", () => {
  for (const transmission of [
    { transport: "http", body: {}, endpoint: { url: "https://provider.example/", exact: false } },
    { transport: "http", body: {} },
    {
      transport: "http",
      body: { apiKey: "fixture-value" },
      endpoint: { url: "https://provider.example/", exact: true },
    },
    { transport: "http", body: {}, endpoint: { url: "https://provider.example/?key=fixture-value", exact: true } },
  ]) {
    expect(() => createRequestEnvelope({ request: makeRequest(), transmission })).toThrow("cannot be persisted")
    const legacy = createRequestEnvelope({ request: makeRequest() })
    const forged = { ...legacy, request: { ...legacy.request, transmission } }
    expect(() => parseRequestEnvelopeJson(JSON.stringify(forged))).toThrow("cannot be persisted")
  }
})

test("a real provider preparation round-trips its final overlay and rejects later recompilation drift", async () => {
  const actualModel = OpenAIChat.route
    .with({
      endpoint: { baseURL: "https://fixture.invalid/v1" },
      auth: Auth.bearer("nonfunctional-auth-fixture"),
    })
    .model({ id: "fixture-model" })
  const request = LLM.request({ model: actualModel, prompt: "fixture", http: { body: { custom: "original" } } })
  const prepared = await Effect.runPromise(LLMClient.prepare(request))
  const envelope = createRequestEnvelope({ request, transmission: prepared.transmission })
  const serialized = requestEnvelopeJson(envelope)
  expect(serialized).not.toContain("nonfunctional-auth-fixture")
  const restored = parseRequestEnvelopeJson(serialized)
  expect(restored.request.transmission?.body).toMatchObject({ custom: "original" })
  expect(assertPreparedRequestEnvelope(restored, prepared)).toBe(true)
  const changed = LLM.request({ model: actualModel, prompt: "fixture", http: { body: { custom: "changed" } } })
  const recompiled = await Effect.runPromise(LLMClient.prepare(changed))
  expect(() => assertPreparedRequestEnvelope(restored, recompiled)).toThrow("preparation differs")
})

test("request envelope rebuilds the exact normalized model request", () => {
  const request = makeRequest()
  const envelope = createRequestEnvelope({
    request,
    execution: {
      run_id: "run-1",
      turn_step: 2,
      prompt_digest: "prompt-digest",
      context_digest: "context-digest",
      compiler_revision: "compiler-v1",
      tool_set_revision: "tools-v1",
      route_config_revision: "route-v1",
      skill_snapshot_digest: "b".repeat(64),
      credential_identity: { id: "credential-1", version: "3" },
    },
  })
  const rebuilt = rebuildRequest(envelope, model, { id: "credential-1", version: "3" })
  expect(assertRequestEnvelope(envelope, rebuilt)).toBe(true)
  const serialized = requestEnvelopeJson(envelope)
  expect(serialized).toContain("credential-1")
  expect(serialized).toContain("skill_snapshot_digest")
  expect(assertRequestEnvelope(parseRequestEnvelopeJson(serialized), rebuilt)).toBe(true)
  expect(envelope.request_digest).toMatch(/^[a-f0-9]{64}$/)
})

test("skill snapshot identity is canonical, durable, and part of the request digest", () => {
  const first = createRequestEnvelope({
    request: makeRequest(),
    execution: { skill_snapshot_digest: "a".repeat(64) },
  })
  const second = createRequestEnvelope({
    request: makeRequest(),
    execution: { skill_snapshot_digest: "b".repeat(64) },
  })
  expect(first.request_digest).not.toBe(second.request_digest)
  expect(parseRequestEnvelopeJson(requestEnvelopeJson(first)).execution.skill_snapshot_digest).toBe("a".repeat(64))
  for (const value of ["skill-v1", "A".repeat(64), "0".repeat(63)])
    expect(() =>
      createRequestEnvelope({ request: makeRequest(), execution: { skill_snapshot_digest: value } }),
    ).toThrow("skill snapshot digest")
})

test("request reconstruction requires the resolved credential to match the durable identity", () => {
  const identity = { id: "credential-original", version: "encrypted-revision-original" }
  const envelope = parseRequestEnvelopeJson(
    requestEnvelopeJson(
      createRequestEnvelope({ request: makeRequest(), execution: { credential_identity: identity } }),
    ),
  )
  for (const resolved of [
    undefined,
    { ...identity, id: "credential-other" },
    { ...identity, version: "encrypted-revision-replacement" },
  ])
    expect(() => rebuildRequest(envelope, model, resolved)).toThrow("credential identity")

  expect(assertRequestEnvelope(envelope, rebuildRequest(envelope, model, { ...identity }))).toBe(true)
  expect(envelope.execution.credential_identity).toEqual(identity)
})

test("action request requires its original input digest and matching run binding", () => {
  const envelope = createRequestEnvelope({ request: makeRequest(), execution: { run_id: "run-1" } })
  const serialized = requestEnvelopeJson(envelope)
  expect(parseActionRequestEnvelope(serialized, { inputDigest: envelope.request_digest, runID: "run-1" })).toEqual(
    envelope,
  )
  for (const action of [
    { inputDigest: envelope.request_digest, runID: "run-2" },
    { inputDigest: envelope.request_digest },
    { runID: "run-1" },
    { inputDigest: "0".repeat(64), runID: "run-1" },
  ])
    expect(() => parseActionRequestEnvelope(serialized, action)).toThrow()
})

test("a meaningful request field change changes the durable digest", () => {
  const first = createRequestEnvelope({ request: makeRequest() })
  const second = createRequestEnvelope({ request: makeRequest({ generation: { maxTokens: 513, temperature: 0 } }) })
  expect(second.request_digest).not.toBe(first.request_digest)
  expect(() => assertRequestEnvelope(first, makeRequest({ generation: { maxTokens: 513, temperature: 0 } }))).toThrow(
    "differs from durable envelope",
  )
})

test("request-level secrets are rejected instead of being written to an envelope", () => {
  expect(() =>
    createRequestEnvelope({ request: makeRequest({ providerOptions: { openai: { apiKey: "secret" } } }) }),
  ).toThrow("cannot be persisted")
})

for (const endpoint of [
  { baseURL: "https://fixture-user:fixture-password@provider.example/v1" },
  { baseURL: "https://provider.example/v1?key=fixture-value" },
  { baseURL: "https://provider.example/v1#fixture-value" },
  { path: "/chat?sig=fixture-value" },
  { path: "//fixture-user:fixture-password@provider.example/chat" },
  { query: { key: "fixture-value" } },
]) {
  test(`endpoint credentials cannot enter or reenter an envelope: ${JSON.stringify(Object.keys(endpoint))} ${JSON.stringify(endpoint)}`, () => {
    const unsafeModel = LLMModel.make({
      id: model.id,
      provider: model.provider,
      route: { ...model.route, endpoint: { ...model.route.endpoint, ...endpoint } },
    })
    expect(() => createRequestEnvelope({ request: makeRequest({}, unsafeModel) })).toThrow("cannot be persisted")
    const envelope = createRequestEnvelope({ request: makeRequest() })
    const forged = {
      ...envelope,
      request: {
        ...envelope.request,
        model: {
          ...envelope.request.model,
          endpoint: {
            ...envelope.request.model.endpoint,
            ...(endpoint.baseURL ? { base_url: endpoint.baseURL } : {}),
            ...(endpoint.path ? { path: endpoint.path, path_mode: "static" as const } : {}),
            ...(endpoint.query ? { query: endpoint.query } : {}),
          },
        },
      },
    }
    expect(() => requestEnvelopeJson(forged)).toThrow("cannot be persisted")
    expect(() => parseRequestEnvelopeJson(JSON.stringify(forged))).toThrow("cannot be persisted")
  })
}

test("safe endpoint components round-trip verbatim without treating ordinary content as an endpoint", () => {
  const safeModel = LLMModel.make({
    id: model.id,
    provider: model.provider,
    route: {
      ...model.route,
      endpoint: {
        baseURL: "https://provider.example/v1?region=test",
        path: "/chat?api-version=2026-01",
        query: { region: "test" },
      },
    },
  })
  const request = makeRequest({ metadata: { reference: "https://docs.example/#section" } }, safeModel)
  const envelope = createRequestEnvelope({ request })
  const restored = parseRequestEnvelopeJson(requestEnvelopeJson(envelope))
  expect(restored.request.model.endpoint).toEqual(envelope.request.model.endpoint)
  expect(assertRequestEnvelope(restored, rebuildRequest(restored, safeModel))).toBe(true)
})

test("schema field names that describe secret references round-trip without weakening value checks", () => {
  const request = makeRequest({
    tools: [
      {
        name: "inspect_trigger",
        description: "Inspect a trigger profile without resolving its credentials",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          $defs: {
            Profile: {
              type: "object",
              properties: {
                clientSecretEnvironment: { type: "string" },
              },
            },
          },
          properties: { profile: { $ref: "#/$defs/Profile" } },
        },
      },
    ],
  })
  const envelope = createRequestEnvelope({ request })
  const rebuilt = rebuildRequest(parseRequestEnvelopeJson(requestEnvelopeJson(envelope)), model)

  expect(assertRequestEnvelope(envelope, rebuilt)).toBe(true)
  expect(JSON.stringify(rebuilt.tools)).toContain("clientSecretEnvironment")
})

test("secret-bearing values nested inside a schema remain rejected", () => {
  expect(() =>
    createRequestEnvelope({
      request: makeRequest({
        tools: [
          {
            name: "unsafe_schema",
            description: "Unsafe fixture",
            inputSchema: {
              type: "object",
              properties: {},
              default: { apiKey: "must-not-persist" },
            },
          },
        ],
      }),
    }),
  ).toThrow("cannot be persisted")
})

test("rebuild fails closed when the route identity is not the recorded route", () => {
  const envelope = createRequestEnvelope({ request: makeRequest() })
  const otherModel = LLMModel.make({
    id: model.id,
    provider: model.provider,
    route: { ...model.route, id: "route-b" } as never,
  })
  expect(() => rebuildRequest(envelope, otherModel)).toThrow("route/protocol identity")
})

test("rebuild fails closed when a static endpoint path drifts", () => {
  const staticModel = LLMModel.make({
    id: model.id,
    provider: model.provider,
    route: {
      ...model.route,
      endpoint: { ...model.route.endpoint, path: "/chat" },
    } as never,
  })
  const envelope = createRequestEnvelope({ request: makeRequest({}, staticModel) })
  const driftedModel = LLMModel.make({
    id: staticModel.id,
    provider: staticModel.provider,
    route: {
      ...staticModel.route,
      endpoint: { ...staticModel.route.endpoint, path: "/responses" },
    } as never,
  })
  expect(() => rebuildRequest(envelope, driftedModel)).toThrow("endpoint identity")
})

test("a tampered envelope digest is rejected before provider reconstruction", () => {
  const envelope = createRequestEnvelope({ request: makeRequest() })
  const tampered = { ...envelope, request_digest: "0".repeat(64) }
  expect(() => assertRequestEnvelope(tampered, makeRequest())).toThrow("internally inconsistent")
})

test("persisted envelope rejects secret-bearing header keys even with a forged digest", () => {
  const envelope = createRequestEnvelope({ request: makeRequest() })
  const parsed = JSON.parse(requestEnvelopeJson(envelope)) as Record<string, unknown>
  const request = parsed.request as Record<string, unknown>
  request.http = { headers: { "x-token": "secret" } }
  const forged = {
    ...parsed,
    request,
    request_digest: envelope.request_digest,
  }
  expect(() => parseRequestEnvelopeJson(JSON.stringify(forged))).toThrow("cannot be persisted")
})
