import { describe, expect, it } from "bun:test"
import { DateTime, Schema } from "effect"
import { A2A } from "@arforge-ai/schema/a2a"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DurableEventManifest } from "@arforge-ai/schema/durable-event-manifest"

const versioned = (definition: { readonly type: string; readonly durable?: { readonly version: number } }) =>
  `${definition.type}.${definition.durable?.version}`

describe("Durable event manifest", () => {
  it("round-trips managed Action output through the canonical opaque receipt and keeps the inline limit", () => {
    const digest = "1".repeat(64)
    const output = AgentRuntime.ActionOutput.make({
      encoding: "artifact",
      value: AgentRuntime.OpaqueArtifactRef.make({
        version: 1,
        artifactID: AgentRuntime.ArtifactID.make(`art_${digest}`),
        digest,
        kind: "action_output",
        mime: "application/json",
        sizeBytes: AgentRuntime.ActionOutputMaxBytes + 1,
        owner: { scope: "session", id: "ses_schema_artifact" },
        retention: { mode: "durable" },
        retrievalHint: { kind: "managed", handle: "artifact_schema_contract" },
        createdAt: DateTime.makeUnsafe(1),
      }),
      digest,
      byteLength: AgentRuntime.ActionOutputMaxBytes + 1,
    })
    const encoded = Schema.encodeSync(AgentRuntime.ActionOutput)(output)
    expect(Schema.decodeUnknownSync(AgentRuntime.ActionOutput)(JSON.parse(JSON.stringify(encoded)))).toEqual(output)
    expect(encoded.encoding).toBe("artifact")
    if (encoded.encoding !== "artifact") throw new Error("expected artifact contract")
    expect(encoded.value.createdAt).toBe(1)
    expect(Object.hasOwn(encoded.value, "label")).toBe(false)
    expect(Object.hasOwn(encoded.value.retention, "expiresAt")).toBe(false)
    expect(() =>
      Schema.decodeUnknownSync(AgentRuntime.ActionOutput)({
        ...encoded,
        byteLength: AgentRuntime.ManagedArtifactMaxBytes + 1,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(AgentRuntime.ActionOutput)({
        ...encoded,
        value: { ...encoded.value, retrievalHint: { kind: "managed", handle: "../outside" } },
      }),
    ).toThrow()
    expect(() => Schema.decodeUnknownSync(AgentRuntime.ActionOutput)({ ...encoded, encoding: "json" })).toThrow()
  })

  it("stores postprocessing in the original Action family with omitted optional fields and bounded output", () => {
    const definition = AgentRuntime.Event.ActionPostProcessingRecorded
    expect(AgentRuntime.Event.ActionDefinitions.filter((item) => item === definition)).toHaveLength(1)
    expect(DurableEventManifest.AgentActionDurable.definitions.get(versioned(definition))).toBe(definition)
    const encoded = Schema.encodeSync(definition.data)({
      actionID: AgentRuntime.ActionID.create(),
      sessionID: undefined,
      subject: undefined,
      processing: {
        observationID: AgentRuntime.ObservationID.create(),
        state: "started",
        output: undefined,
        recordedAt: DateTime.makeUnsafe(1),
      },
    })
    expect(Object.hasOwn(encoded, "sessionID")).toBe(false)
    expect(Object.hasOwn(encoded, "subject")).toBe(false)
    expect(Object.hasOwn(encoded.processing, "output")).toBe(false)
    expect(() =>
      Schema.decodeUnknownSync(AgentRuntime.ActionOutput)({
        encoding: "json",
        value: "oversized",
        digest: "0".repeat(64),
        byteLength: AgentRuntime.ActionOutputMaxBytes + 1,
      }),
    ).toThrow()
  })

  it("keeps the Run and Action family boundaries explicit", () => {
    const runTypes = AgentRuntime.Event.RunDefinitions.map((definition) => definition.type)
    const actionTypes = AgentRuntime.Event.ActionDefinitions.map((definition) => definition.type)

    expect(runTypes.slice(0, 2)).toEqual(["agent.run.created", "agent.run.state-changed"])
    expect(runTypes).toContain("agent.control-run.created")
    expect(actionTypes[0]).toBe("agent.action.proposed")
    expect(new Set(runTypes).size).toBe(runTypes.length)
    expect(new Set(actionTypes).size).toBe(actionTypes.length)
    expect(
      runTypes.every(
        (type) =>
          type.startsWith("agent.run.") || type.startsWith("agent.child-run.") || type.startsWith("agent.control-run."),
      ),
    ).toBe(true)
    expect(actionTypes.every((type) => type.startsWith("agent.action."))).toBe(true)
  })

  it("registers every AgentRuntime definition under its explicit versioned key", () => {
    const definitions = [...AgentRuntime.Event.ActionDefinitions, ...AgentRuntime.Event.RunDefinitions]
    const keys = definitions.map(versioned)

    expect(definitions.every((definition) => definition.durable !== undefined)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect([...DurableEventManifest.AgentActionDurable.definitions.keys()]).toEqual(
      AgentRuntime.Event.ActionDefinitions.map(versioned),
    )
    expect([...DurableEventManifest.AgentRunDurable.definitions.keys()]).toEqual(
      AgentRuntime.Event.RunDefinitions.map(versioned),
    )
  })

  it("keeps the combined durable manifest free of duplicate versioned keys", () => {
    const keys = [
      ...DurableEventManifest.AgentActionDurable.definitions.keys(),
      ...DurableEventManifest.AgentRunDurable.definitions.keys(),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("registers the private A2A aggregate definitions in the global manifest", () => {
    const keys = A2A.Event.Definitions.map(versioned)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((key) => DurableEventManifest.Durable.has(key))).toBe(true)
  })
})
