export * as ModelPresets from "./model-presets"

import { createHash } from "node:crypto"
import { Schema } from "effect"
import * as ModelPreset from "@arforge-ai/schema/model-preset"
import { optional } from "@arforge-ai/schema/schema"
import manifestJSON from "../assets/model-presets.json"

const Recipe = Schema.Struct({
  strengthOrder: Schema.Array(Schema.String).check(Schema.isMaxLength(16)).pipe(optional),
  protocol: Schema.Literals(["openai-chat", "openai-responses", "anthropic-messages"]),
  wireIDs: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  variants: Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.Record(Schema.String, Schema.Json) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
})
export type Recipe = typeof Recipe.Type
const Entry = Schema.Struct({
  fieldSources: Schema.Record(Schema.String, Schema.Array(ModelPreset.Provenance)).pipe(optional),
  sourceConditions: Schema.Json.pipe(optional),
  limitRules: Schema.Array(Schema.Struct({ protocol: Recipe.fields.protocol, limit: ModelPreset.Limits })).pipe(
    optional,
  ),
  verifiedModalities: Schema.Struct({ input: Schema.Array(Schema.String), output: Schema.Array(Schema.String) }).pipe(
    optional,
  ),
  capabilityRules: Schema.Array(
    Schema.Struct({ protocol: Recipe.fields.protocol, capabilities: ModelPreset.Preset.fields.capabilities }),
  ).pipe(optional),
  origin: ModelPreset.Origin,
  aliases: ModelPreset.Preset.fields.aliases,
  source: Schema.Struct({ providerID: Schema.String, modelID: Schema.String }).pipe(optional),
  overlay: Schema.Struct({
    name: ModelPreset.Preset.fields.name.pipe(optional),
    limit: ModelPreset.Limits.pipe(optional),
    capabilities: ModelPreset.Preset.fields.capabilities,
    reasoning: ModelPreset.Preset.fields.reasoning,
    status: ModelPreset.Preset.fields.status.pipe(optional),
  }).pipe(optional),
  provenance: Schema.Array(ModelPreset.Provenance),
  recipes: Schema.Array(Recipe).check(Schema.isMaxLength(8)),
})
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  vendors: Schema.Array(ModelPreset.Vendor).check(Schema.isMaxLength(500)),
  entries: Schema.Array(Entry).check(Schema.isMaxLength(500)),
})
export type Manifest = typeof Manifest.Type
// Static import makes the small manifest an actual native/server bundle input.
export const manifest = Schema.decodeUnknownSync(Manifest)(manifestJSON)
const cache = new WeakMap<object, ModelPreset.Catalog>()
const fingerprint = (preset: ModelPreset.Preset) => JSON.stringify({ ...preset, provenance: undefined })

/** Uses the existing ModelsDev snapshot only. No new cache file, downloader or availability policy. */
export function project(
  snapshot: Readonly<Record<string, { readonly models: Readonly<Record<string, unknown>> }>>,
  input: Manifest = manifest,
): ModelPreset.Catalog {
  if (input === manifest && cache.has(snapshot)) return cache.get(snapshot)!
  // Re-validate even injected/test manifests; overflow must fail, never truncate.
  const checked = Schema.decodeUnknownSync(Manifest)(input)
  const items: ModelPreset.Preset[] = []
  const seen = new Map<string, number>()
  const sourceRows: unknown[] = []
  for (const entry of checked.entries) {
    const raw = entry.source && snapshot[entry.source.providerID]?.models[entry.source.modelID]
    if (
      !entry.overlay ||
      !entry.provenance.length ||
      entry.provenance.some((item) => item.source !== "official" || item.verifiedAt === undefined)
    )
      throw new Error("Curated presets require audited official overlay fields and verification receipts.")
    sourceRows.push(raw ?? null)
    const provenance = entry.provenance
    const preset = Schema.decodeUnknownSync(ModelPreset.Preset)({
      origin: entry.origin,
      name: entry.overlay.name ?? entry.origin.modelID,
      aliases: entry.aliases,
      status: entry.overlay.status ?? "active",
      ...entry.overlay,
      provenance,
    })
    const key = fingerprint(preset)
    const previous = seen.get(key)
    if (previous !== undefined) {
      const existing = items[previous]
      items[previous] = {
        ...existing,
        provenance: [
          ...new Map(
            [...existing.provenance, ...preset.provenance].map((item) => [JSON.stringify(item), item]),
          ).values(),
        ],
      }
    } else {
      seen.set(key, items.length)
      items.push(preset)
    }
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([checked, sourceRows]))
    .digest("hex")
  const catalog = Schema.decodeUnknownSync(ModelPreset.Catalog)({ revision, vendors: checked.vendors, items })
  if (input === manifest) cache.set(snapshot, catalog)
  return catalog
}

/** References never guess, cross revisions, choose a conflicting region or change connection identity. */
export function resolve(
  catalog: ModelPreset.Catalog,
  reference: ModelPreset.Reference,
): ModelPreset.Preset | undefined {
  if (catalog.revision !== reference.revision) return undefined
  const matches = catalog.items.filter(
    (item) => item.origin.vendorID === reference.origin.vendorID && item.origin.modelID === reference.origin.modelID,
  )
  return matches.length === 1 ? matches[0] : undefined
}

export function recipes(reference: ModelPreset.Reference, catalog: ModelPreset.Catalog): readonly Recipe[] {
  if (!resolve(catalog, reference)) return []
  return manifest.entries
    .filter(
      (entry) =>
        entry.origin.vendorID === reference.origin.vendorID && entry.origin.modelID === reference.origin.modelID,
    )
    .flatMap((entry) => entry.recipes)
}

/** Conditional official capabilities are private metadata; never flatten them into relay-wide promises. */
export function capabilities(
  reference: ModelPreset.Reference,
  catalog: ModelPreset.Catalog,
  protocol: Recipe["protocol"],
) {
  if (!resolve(catalog, reference)) return undefined
  const rules = manifest.entries
    .filter(
      (entry) =>
        entry.origin.vendorID === reference.origin.vendorID && entry.origin.modelID === reference.origin.modelID,
    )
    .flatMap((entry) => entry.capabilityRules ?? [])
    .filter((rule) => rule.protocol === protocol)
  return rules.length === 1 ? rules[0].capabilities : undefined
}

export function limitsForProtocol(
  reference: ModelPreset.Reference,
  catalog: ModelPreset.Catalog,
  protocol: Recipe["protocol"],
) {
  const preset = resolve(catalog, reference)
  if (!preset) return undefined
  const rules = manifest.entries
    .filter(
      (entry) =>
        entry.origin.vendorID === reference.origin.vendorID && entry.origin.modelID === reference.origin.modelID,
    )
    .flatMap((entry) => entry.limitRules ?? [])
    .filter((rule) => rule.protocol === protocol)
  return rules.length === 1 ? { ...preset.limit, ...rules[0].limit } : preset.limit
}
