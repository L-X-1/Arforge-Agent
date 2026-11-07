import { expect, test } from "bun:test"
import {
  createSavedModelTest,
  createWorkspaceSave,
  WorkspaceCredentialPending,
  workspacePatch,
  type WorkspaceDetail,
} from "./provider-workspace-operations"
import { applyModelResolution, editModelField } from "../custom-provider-model-autofill"
import { modelConfiguration, modelRow } from "../dialog-custom-provider-form"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { applyModelDefaultChoice, createModelEditorReset } from "../provider-model-editor-state"

test("saved-model tests are explicit, abort the owned request and suppress same-name ABA completions", async () => {
  let owner = "source-a/provider/model/r1",
    current = true,
    calls = 0,
    finish!: (value: string) => void,
    signal: AbortSignal | undefined
  const states: { id: string; status: string; result?: string }[] = []
  const operation = createSavedModelTest({
    owner: () => owner,
    isCurrent: () => current,
    run: async (_id, abort) => {
      calls++
      signal = abort
      return new Promise<string>((done) => {
        finish = done
      })
    },
    publish: (id, state) => states.push({ id, ...state }),
  })
  expect(calls).toBe(0)
  const first = operation.start("wire-id")
  expect(states).toEqual([{ id: "wire-id", status: "pending" }])
  owner = "source-b/provider/model/r1"
  operation.cancel()
  owner = "source-a/provider/model/r1"
  expect(signal?.aborted).toBe(true)
  finish("retired result")
  await first
  expect(states.map((state) => state.status)).toEqual(["pending", "cancelled"])
  const second = operation.start("wire-id")
  finish("current result")
  await second
  expect(states.at(-1)).toEqual({ id: "wire-id", status: "done", result: "current result" })
  const closing = operation.start("wire-id")
  current = false
  operation.cancel()
  finish("detached result")
  await closing
  expect(states.at(-1)?.status).toBe("pending")
  expect(calls).toBe(3)
})

test("ordinary metadata edits and blank-key flow omit auth/adapter; real disable/delete are explicit revision patches", () => {
  const saved: WorkspaceDetail = {
    providerID: "relay",
    revision: "r1",
    name: "Relay",
    baseURL: "https://relay.invalid/v1",
    apiFormat: "openai-chat",
    adapter: { type: "aisdk", package: "@ai-sdk/openai-compatible" },
    authentication: "required",
    disabled: false,
    canWrite: true,
    credential: { configured: true, reconnectRequired: false, source: "stored" },
    models: [],
  }
  const patch = workspacePatch(saved, {
    models: [{ id: "original-wire", name: "Renamed", limit: { context: 12345, output: 123 } }],
  })
  expect(patch).toEqual({
    providerID: "relay",
    revision: "r1",
    name: "Relay",
    models: [{ id: "original-wire", name: "Renamed", limit: { context: 12345, output: 123 } }],
  })
  expect(patch.authentication).toBeUndefined()
  expect(patch.apiFormat).toBeUndefined()
  expect(workspacePatch(saved, { disabled: true })).toMatchObject({ disabled: true, models: [], revision: "r1" })
  expect(workspacePatch(saved, { models: [{ id: "wire", name: "Name", disabled: true }] }).models[0]).toMatchObject({
    disabled: true,
  })
  expect(workspacePatch(saved, { deletedModelIDs: ["last-model"] })).toMatchObject({
    models: [],
    deletedModelIDs: ["last-model"],
    revision: "r1",
  })
  expect(workspacePatch(saved, { apiFormat: "anthropic-messages" }).apiFormat).toBe("anthropic-messages")
})

test("new recognized name fills actual verified maximum values, one lower override and explicit off survive", () => {
  const preset: ModelPreset.Preset = {
    origin: { vendorID: "fixture", modelID: "known" },
    name: "Known",
    aliases: [],
    status: "active",
    provenance: [{ source: "bundled", sourceID: "fixture" }],
    limit: { context: 16384, input: 12000, output: 4096 },
    capabilities: { tools: true, input: ["text", "image", "custom-future-mode"], output: ["text"] },
  }
  const row = applyModelResolution(
    { ...modelRow(), id: "known" },
    { status: "matched", preset, revision: "verified-fixture" },
  )
  expect(modelConfiguration(row)).toMatchObject({
    id: "known",
    name: "Known",
    limit: { context: 16384, input: 12000, output: 4096 },
    preset: { origin: preset.origin, revision: "verified-fixture" },
  })
  const manual = editModelField({ ...row, defaultVariant: "off" }, "output", "512")
  const changed = applyModelResolution(manual, {
    status: "matched",
    preset: { ...preset, limit: { context: 32768, input: 24000, output: 8192 } },
    revision: "next",
  })
  expect(modelConfiguration(changed)).toMatchObject({
    limit: { context: 32768, input: 24000, output: 512 },
    defaultVariant: "off",
  })
  expect(changed.capabilities?.input).toContain("custom-future-mode")
  expect(row.defaultVariant).toBeUndefined() // Core owns verified executable highest-tier lowering; App sends no fabricated body/variant.
})

test("credential-only retry does not duplicate committed configuration or retain the entered secret in its fingerprint", async () => {
  let saves = 0,
    credentials = 0,
    fail = true,
    active = true
  const location = {
    directory: "E:/fixtures/workspace",
    project: { id: "fixture", directory: "E:/fixtures/workspace" },
  }
  const save = createWorkspaceSave(
    {
      save: async () => {
        saves++
        return { location, data: { providerID: "relay", revision: "r2", disabled: false } }
      },
      credential: async (input) => {
        credentials++
        expect(input.revision).toBe("r2")
        if (fail) throw Error("private fixture failure")
        return { location, data: { providerID: "relay", revision: "r2", disabled: false } }
      },
    },
    () => active,
  )
  const input = { providerID: "relay", revision: "r1", name: "Name", baseURL: "https://fixture.invalid", models: [] }
  const failure = await save(input, "synthetic-owned-key").catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(WorkspaceCredentialPending)
  fail = false
  await save(input, "synthetic-owned-key")
  expect([saves, credentials]).toEqual([1, 2])
  active = false
  await save(input, "another-owned-key").catch(() => {})
  expect([saves, credentials]).toEqual([1, 2])
})

test("untouched automatic, explicit model default, off and actual auto variants remain distinct", () => {
  const model = { id: "wire", name: "Name" }
  expect(applyModelDefaultChoice(model, { type: "untouched" }, ["off", "auto"])).toEqual(model)
  expect(applyModelDefaultChoice(model, { type: "model-default" }, ["off", "auto"])).toEqual({
    ...model,
    defaultVariant: null,
  })
  expect(applyModelDefaultChoice(model, { type: "variant", id: "off" }, ["off", "auto"]).defaultVariant).toBe("off")
  expect(applyModelDefaultChoice(model, { type: "variant", id: "auto" }, ["off", "auto"]).defaultVariant).toBe("auto")
  expect(() => applyModelDefaultChoice(model, { type: "variant", id: "invented-max" }, ["off", "auto"])).toThrow()
  expect(applyModelDefaultChoice({ ...model, defaultVariant: "off" }, { type: "untouched" }, ["off"])).toMatchObject({
    defaultVariant: "off",
  })
})

test("reset restores captured manual model values and cannot reset a replacement source", () => {
  const initial = modelRow({
    id: "stable-wire",
    name: "Original",
    limit: { context: 12345, output: 77 },
    defaultVariant: "off",
  })
  let row = editModelField(initial, "output", "3"),
    owner = "SDK-A/provider/revision-1",
    active = true
  const reset = createModelEditorReset(
    () => owner,
    () => active,
    () => {
      row = modelRow({
        id: initial.id,
        name: initial.name,
        limit: { context: 12345, output: 77 },
        defaultVariant: "off",
      })
    },
  )
  expect(reset()).toBe(true)
  expect(modelConfiguration(row)).toMatchObject({
    id: "stable-wire",
    limit: { context: 12345, output: 77 },
    defaultVariant: "off",
  })
  row = editModelField(row, "output", "5")
  owner = "SDK-B/provider/revision-1"
  expect(reset()).toBe(false)
  expect(row.output).toBe("5")
  owner = "SDK-A/provider/revision-1"
  active = false
  expect(reset()).toBe(false)
  expect(row.output).toBe("5")
})
