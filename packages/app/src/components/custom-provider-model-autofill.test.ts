import { expect, test } from "bun:test"
import {
  applyModelResolution,
  createModelMetadataLookup,
  editModelField,
  formModelMetadata,
  resetModelField,
  parseModelLimit,
  type FormModelPreset,
} from "./custom-provider-model-autofill"
import { validateCustomProvider, legacyCustomProviderConfig, modelRow } from "./dialog-custom-provider-form"
import { modelPresetSettingsCopy } from "./custom-provider-model-copy"

const preset = (key: string, context: number, output: number): FormModelPreset => ({
  origin: { vendorID: "unit", modelID: key },
  name: key,
  aliases: [],
  limit: { context, output },
  status: "active",
  provenance: [{ source: "bundled", sourceID: "unit" }],
})
const one = preset("unit-one", 1000, 100),
  two = preset("unit-two", 2000, 200)
const catalog = (items: readonly FormModelPreset[]) => ({
  revision: "revision-1",
  vendors: [{ id: "unit", name: "Unit manufacturer" }],
  items,
})

test("metadata changes only fields that remain auto-owned and preserves a manual output override", () => {
  const first = applyModelResolution(modelRow(), { status: "matched", preset: one, revision: "revision-1" })
  const manual = editModelField(first, "output", "75")
  const next = applyModelResolution(manual, { status: "matched", preset: two, revision: "revision-2" })
  expect([next.name, next.context, next.output]).toEqual(["unit-two", "2000", "75"])
  expect(next.owners).toMatchObject({
    name: { type: "auto", presetRevision: "revision-2" },
    context: { type: "auto", lastValue: "2000" },
    output: { type: "manual" },
  })
  expect([first.output, manual.output]).toEqual(["100", "75"])
})

test("explicit preset cannot rewrite relay wire ID, connection identity, endpoint or secret", () => {
  const row = {
    ...modelRow(),
    id: "relay-private-alias",
    name: "My model",
    providerID: "my-relay",
    endpoint: "https://relay.invalid/v1",
    apiKey: "unit-only",
    headers: { "X-Fixture": "unit-header" },
  }
  const next = applyModelResolution(row, { status: "matched", preset: one, revision: "revision-1" })
  expect([next.id, next.name, next.providerID, next.endpoint, next.apiKey]).toEqual([
    row.id,
    row.name,
    row.providerID,
    row.endpoint,
    row.apiKey,
  ])
  expect([next.context, next.output]).toEqual(["1000", "100"])
  expect(next.headers).toEqual(row.headers)
})

test("unknown or ambiguous matching clears stale auto values, preserves manual fields and never inserts arbitrary zero", () => {
  const first = applyModelResolution(modelRow(), { status: "matched", preset: one, revision: "revision-1" })
  const manual = editModelField(first, "context", "512")
  const unknown = applyModelResolution(manual, { status: "unknown" })
  expect([unknown.name, unknown.context, unknown.output]).toEqual(["", "512", ""])
  const ambiguous = applyModelResolution(first, { status: "ambiguous", candidates: [one, two] })
  expect([ambiguous.context, ambiguous.output]).toEqual(["", ""])
  expect(ambiguous.candidates).toEqual([one, two])
  const absent = applyModelResolution(modelRow(), {
    status: "matched",
    preset: preset("unknown capacity", 0, 0),
    revision: "revision-1",
  })
  expect([absent.context, absent.output]).toEqual(["", ""])
})

test("manual clearing stays manual until explicit reset; reset restores only that field", () => {
  const first = applyModelResolution(modelRow(), { status: "matched", preset: one, revision: "revision-1" })
  const edited = editModelField(editModelField(first, "context", "999"), "output", "")
  const changed = applyModelResolution(edited, { status: "matched", preset: two, revision: "revision-2" })
  expect([changed.context, changed.output]).toEqual(["999", ""])
  const reset = resetModelField(changed, "output")
  expect([reset.context, reset.output]).toEqual(["999", "200"])
  expect(reset.owners?.context?.type).toBe("manual")
})

test("limits accept optional positive safe integers and reject nonnumeric, decimal, negative, zero or overflow", () => {
  expect(parseModelLimit("")).toEqual({ invalid: false })
  expect(parseModelLimit(" 2048 ")).toEqual({ invalid: false, value: 2048 })
  for (const value of ["0", "-1", "1.5", "1e3", "Infinity", "128k", "9007199254740992"])
    expect(parseModelLimit(value).invalid).toBe(true)
})

test("validated typed model draft preserves chosen numeric limits and original relay wire ID", () => {
  const run = (context?: string, output?: string) =>
    validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.invalid/v1",
        apiKey: "",
        models: [{ ...modelRow(), id: "relay-alias", name: "My model", context, output }],
        headers: [],
        err: {},
      },
      t: (key) => key,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
  expect(run("2048", "512").result?.config.models["relay-alias"]).toEqual({
    name: "My model",
    limit: { context: 2048, output: 512 },
  })
  expect(run("", "").result?.config.models["relay-alias"]).toEqual({ name: "My model" })
  expect(run("0", "512").result).toBeUndefined()
  expect(run("0", "512").models[0].context).toBe(modelPresetSettingsCopy("en").invalidLimit)
})

test("unknown wire names supply an untouched display fallback which follows edits and a later exact match", () => {
  const initial = applyModelResolution({ ...modelRow(), id: "relay-alias" }, { status: "unknown" })
  expect(initial.name).toBe("relay-alias")
  const changed = applyModelResolution({ ...initial, id: "other-alias" }, { status: "unknown" })
  expect(changed.name).toBe("other-alias")
  const matched = applyModelResolution(changed, { status: "matched", preset: one, revision: "r1" })
  expect(matched.name).toBe(one.name)
  expect(matched.id).toBe("other-alias")
  const manual = editModelField(initial, "name", initial.name)
  expect(applyModelResolution(manual, { status: "matched", preset: one, revision: "r1" }).name).toBe("relay-alias")
})

test("editing even the old auto value transfers ownership; external field divergence also becomes manual", () => {
  const first = applyModelResolution(modelRow(), { status: "matched", preset: one, revision: "r1" })
  const same = editModelField(first, "output", first.output!)
  expect(applyModelResolution(same, { status: "matched", preset: two, revision: "r2" }).output).toBe("100")
  const divergent = applyModelResolution({ ...first, context: "777" }, { status: "unknown" })
  expect(divergent.context).toBe("777")
  expect(divergent.owners?.context).toEqual({ type: "manual" })
})

test("an explicit origin is resolvable for an arbitrary relay alias and manual display name", () => {
  const metadata = formModelMetadata(catalog([one, two]))
  expect(metadata.resolve({ id: "arbitrary-wire-name", name: "My label", selectedOrigin: one.origin })).toMatchObject({
    status: "matched",
    preset: one,
    revision: "revision-1",
  })
  expect(
    metadata.resolve({
      id: one.origin.modelID,
      name: "My label",
      selectedOrigin: { vendorID: "missing", modelID: "missing" },
    }),
  ).toEqual({ status: "unknown" })
})

test("persisted metadata is manual and typed save keeps explicit empty variants/input without UI ownership state", () => {
  const existing = modelRow({
    id: "relay-alias",
    name: "Existing label",
    limit: { context: 333, input: 222, output: 111 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    variants: [],
  })
  const resolved = applyModelResolution(existing, { status: "matched", preset: two, revision: "r2" })
  expect([resolved.name, resolved.context, resolved.output, resolved.input]).toEqual([
    "Existing label",
    "333",
    "111",
    "222",
  ])
  const result = validateCustomProvider({
    form: {
      providerID: "relay",
      name: "Relay",
      baseURL: "https://relay.invalid/v1",
      apiKey: "",
      models: [resolved],
      headers: [],
      err: {},
    },
    t: (key) => key,
    disabledProviders: [],
    existingProviderIDs: new Set(),
  }).result
  expect(result?.config.models["relay-alias"]).toEqual({
    name: "Existing label",
    limit: { context: 333, input: 222, output: 111 },
    capabilities: existing.capabilities,
    variants: [],
    preset: { origin: two.origin, revision: "r2" },
  })
  expect(JSON.stringify(result)).not.toMatch(/owners|matchStatus|matchedPreset|nameFallback|presetSelection/)
  const newRow = applyModelResolution(
    { ...modelRow(), id: "relay-alias" },
    { status: "matched", preset: one, revision: "r1" },
  )
  expect(newRow.variants).toBeUndefined()
  expect(newRow.defaultVariant).toBeUndefined()
})

test("local setup copy supports simplified/traditional Chinese and English fallback without global keys", () => {
  const en = modelPresetSettingsCopy("en")
  expect(modelPresetSettingsCopy("fr")).toBe(en)
  expect(modelPresetSettingsCopy("zhHans").context).toBe(modelPresetSettingsCopy("zh-Hans").context)
  expect(modelPresetSettingsCopy("zht").context).toBe(modelPresetSettingsCopy("zh-TW").context)
  expect(modelPresetSettingsCopy("zht").override).not.toBe(modelPresetSettingsCopy("zh-Hans").override)
  expect(Object.keys(en)).toHaveLength(19)
})

test("legacy save uses its real contract: full manual limits work; partial limits or canonical metadata fail before mutation", () => {
  const copy = modelPresetSettingsCopy("en")
  const config = {
    npm: "@ai-sdk/openai-compatible",
    name: "Relay",
    options: { baseURL: "https://relay.invalid/v1" },
    models: {
      alias: { name: "Alias", limit: { context: 444, output: 55 } },
    },
  }
  expect(legacyCustomProviderConfig(config, copy)).toEqual(config)
  expect(() =>
    legacyCustomProviderConfig({ ...config, models: { alias: { name: "Alias", limit: { context: 444 } } } }, copy),
  ).toThrow(copy.legacyLimitUnsupported)
  expect(() =>
    legacyCustomProviderConfig({ ...config, models: { alias: { name: "Alias", variants: [] } } }, copy),
  ).toThrow(copy.legacyUnsupported)
  expect(legacyCustomProviderConfig({ ...config, models: { alias: { name: "Alias" } } }, copy).models).toEqual({
    alias: { name: "Alias" },
  })
})

test("a late lookup cannot affect changed provider/input, ABA scope, removed row or disposed source", async () => {
  let scope = "provider-a/row/one",
    active = true,
    applyCount = 0
  const lookup = createModelMetadataLookup(
    () => scope,
    () => active,
  )
  let finish!: (result: { status: "matched"; preset: FormModelPreset; revision: string }) => void
  const metadata = {
    catalog: catalog([one]),
    resolve: () =>
      new Promise<{ status: "matched"; preset: FormModelPreset; revision: string }>((done) => {
        finish = done
      }),
  }
  const pending = lookup.resolve({ id: "one", name: "" }, metadata, () => {
    applyCount++
  })
  scope = "provider-b/row/two"
  lookup.invalidate()
  scope = "provider-a/row/one"
  lookup.invalidate()
  finish({ status: "matched", preset: one, revision: "revision-1" })
  await pending
  expect(applyCount).toBe(0)
  const removed = lookup.resolve({ id: "one", name: "" }, metadata, () => {
    applyCount++
  })
  lookup.dispose()
  finish({ status: "matched", preset: one, revision: "revision-1" })
  await removed
  expect(applyCount).toBe(0)
  const other = createModelMetadataLookup(
    () => scope,
    () => active,
  )
  const stale = other.resolve({ id: "one", name: "" }, metadata, () => {
    applyCount++
  })
  active = false
  finish({ status: "matched", preset: one, revision: "revision-1" })
  await stale
  expect(applyCount).toBe(0)
})

test("current lookup applies and lookup failure remains a manual setup state", async () => {
  const lookup = createModelMetadataLookup(
    () => "current",
    () => true,
  )
  const results: string[] = []
  await lookup.resolve(
    { id: "one", name: "" },
    { catalog: catalog([one]), resolve: () => ({ status: "matched", preset: one, revision: "revision-1" }) },
    (result) => results.push(result.status),
  )
  await lookup.resolve(
    { id: "unknown", name: "" },
    {
      catalog: catalog([]),
      resolve: () => {
        throw Error("catalog unavailable")
      },
    },
    (result) => results.push(result.status),
  )
  expect(results).toEqual(["matched", "unavailable"])
})
