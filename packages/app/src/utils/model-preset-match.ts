import type { ModelPreset } from "@arforge-ai/schema/model-preset"

export type ModelPresetMatch =
  | { status: "matched"; preset: ModelPreset.Preset; via: "id" | "alias" | "name" }
  | { status: "ambiguous" | "unknown"; candidates: readonly ModelPreset.Preset[] }

export const modelPresetKey = (preset: Pick<ModelPreset.Preset, "origin">) =>
  JSON.stringify([preset.origin.vendorID, preset.origin.modelID])

// Comparison only: never normalize a requested wire ID or remove its namespace/version.
const compare = (value: string) => value.trim().toLowerCase()

export function matchModelPreset(input: string, catalog: ModelPreset.Catalog): ModelPresetMatch {
  const query = compare(input)
  if (!query) return { status: "unknown", candidates: [] }
  const steps = [
    ["id", (preset: ModelPreset.Preset) => compare(preset.origin.modelID) === query],
    // Complete registered aliases are also the sole permission for namespace forms.
    ["alias", (preset: ModelPreset.Preset) => preset.aliases.some((alias) => compare(alias) === query)],
    ["name", (preset: ModelPreset.Preset) => compare(preset.name) === query],
  ] as const
  for (const [via, accepts] of steps) {
    const matches = catalog.items.filter(accepts)
    if (matches.length === 1) return { status: "matched", preset: matches[0], via }
    if (matches.length > 1) return { status: "ambiguous", candidates: matches }
  }
  const candidates = catalog.items.filter((preset) =>
    [preset.origin.modelID, preset.name, ...preset.aliases].some((name) => compare(name).startsWith(query)),
  )
  return { status: candidates.length > 1 ? "ambiguous" : "unknown", candidates }
}
