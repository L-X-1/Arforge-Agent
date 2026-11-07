import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { matchModelPreset } from "@/utils/model-preset-match"

export type FormModelPreset = ModelPreset.Preset
export type ModelLimitKey = "context" | "input" | "output"
export type ModelAutofillKey = ModelLimitKey | "name"
export type FieldOwner =
  | { type: "empty" }
  | { type: "auto"; presetRevision: string; origin: ModelPreset.Origin; lastValue: string }
  | { type: "manual" }

export type FormModelResolution =
  | { status: "matched"; preset: ModelPreset.Preset; revision: string }
  | { status: "ambiguous"; candidates: readonly ModelPreset.Preset[] }
  | { status: "unknown" | "unavailable"; candidates?: readonly ModelPreset.Preset[] }

export type FormModelMetadata = {
  catalog: ModelPreset.Catalog
  resolve: (input: {
    id: string
    name: string
    selectedOrigin?: ModelPreset.Origin
  }) => FormModelResolution | Promise<FormModelResolution>
}

export type ModelAutofillDraft = {
  id?: string
  name: string
  /** Untouched wire-name fallback, separate from manufacturer metadata ownership. */
  nameFallback?: string
  presetSelection?: ModelPreset.Origin
  context?: string
  output?: string
  input?: string
  owners?: Partial<Record<ModelAutofillKey | "capabilities", FieldOwner>>
  matchedPreset?: ModelPreset.Preset
  matchStatus?: FormModelResolution["status"] | "idle" | "pending"
  candidates?: readonly ModelPreset.Preset[]
} & {
  -readonly [Key in keyof Pick<
    ModelPreset.ConfigurationInput,
    "capabilities" | "preset" | "variants" | "defaultVariant"
  >]: ModelPreset.ConfigurationInput[Key]
}

export function modelLimitValue(input: number | undefined) {
  return input !== undefined && Number.isSafeInteger(input) && input > 0 ? String(input) : ""
}

const fingerprint = (value: unknown) => (value === undefined ? "" : JSON.stringify(value))
const fieldOwner = (draft: ModelAutofillDraft, field: ModelAutofillKey | "capabilities"): FieldOwner =>
  draft.owners?.[field] ?? (draft[field] === undefined || draft[field] === "" ? { type: "empty" } : { type: "manual" })
const currentValue = (draft: ModelAutofillDraft, field: ModelAutofillKey | "capabilities") =>
  field === "capabilities" ? fingerprint(draft.capabilities) : (draft[field] ?? "")

export function editModelField<T extends ModelAutofillDraft>(draft: T, field: ModelAutofillKey, value: string): T {
  return {
    ...draft,
    [field]: value,
    ...(field === "name" ? { nameFallback: undefined } : {}),
    owners: { ...draft.owners, [field]: { type: "manual" } },
  }
}

export function applyModelResolution<T extends ModelAutofillDraft>(draft: T, resolution: FormModelResolution): T {
  const preset = resolution.status === "matched" ? resolution.preset : undefined
  const values = {
    name: preset?.name ?? draft.id ?? "",
    context: modelLimitValue(preset?.limit?.context),
    input: modelLimitValue(preset?.limit?.input),
    output: modelLimitValue(preset?.limit?.output),
  }
  const result: ModelAutofillDraft = {
    ...draft,
    matchedPreset: preset,
    matchStatus: resolution.status,
    candidates: resolution.status === "matched" ? undefined : resolution.candidates,
    preset:
      preset && resolution.status === "matched"
        ? { origin: preset.origin, revision: resolution.revision }
        : draft.matchedPreset
          ? undefined
          : draft.preset,
    owners: { ...draft.owners },
  }
  for (const key of ["name", "context", "input", "output", "capabilities"] as const) {
    const previous = fieldOwner(draft, key),
      value = currentValue(draft, key)
    const automatic =
      (previous.type === "empty" && (value === "" || (key === "name" && value === draft.nameFallback))) ||
      (previous.type === "auto" && value === previous.lastValue)
    if (!automatic) {
      result.owners![key] = { type: "manual" }
      if (key === "name") result.nameFallback = undefined
      continue
    }
    const next = key === "capabilities" ? fingerprint(preset?.capabilities) : values[key]
    if (key === "capabilities") result.capabilities = preset?.capabilities
    else result[key] = next
    if (key === "name") result.nameFallback = preset ? undefined : next
    result.owners![key] =
      next && preset && resolution.status === "matched"
        ? { type: "auto", presetRevision: resolution.revision, origin: preset.origin, lastValue: next }
        : { type: "empty" }
  }
  return { ...draft, ...result }
}

export function resetModelField<T extends ModelAutofillDraft>(draft: T, field: ModelAutofillKey): T {
  const preset = draft.matchedPreset
  const value = field === "name" ? (preset?.name ?? draft.id ?? "") : modelLimitValue(preset?.limit?.[field])
  const owner: FieldOwner =
    value && preset && draft.preset
      ? { type: "auto", presetRevision: draft.preset.revision, origin: preset.origin, lastValue: value }
      : { type: "empty" }
  return {
    ...draft,
    [field]: value,
    ...(field === "name" ? { nameFallback: preset ? undefined : value } : {}),
    owners: { ...draft.owners, [field]: owner },
  }
}

export function parseModelLimit(raw: string | undefined): { value?: number; invalid: boolean } {
  if (!raw?.trim()) return { invalid: false }
  if (!/^\d+$/.test(raw.trim())) return { invalid: true }
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value > 0 ? { value, invalid: false } : { invalid: true }
}

export function formModelMetadata(catalog: ModelPreset.Catalog): FormModelMetadata {
  return {
    catalog,
    resolve(input) {
      if (input.selectedOrigin) {
        const origin = input.selectedOrigin
        const preset = catalog.items.find(
          (preset) => preset.origin.vendorID === origin.vendorID && preset.origin.modelID === origin.modelID,
        )
        return preset ? { status: "matched", preset, revision: catalog.revision } : { status: "unknown" }
      }
      const wire = matchModelPreset(input.id, catalog)
      const match = wire.status === "unknown" && input.name.trim() ? matchModelPreset(input.name, catalog) : wire
      return match.status === "matched"
        ? { status: "matched", preset: match.preset, revision: catalog.revision }
        : match
    },
  }
}

export function createModelMetadataLookup(readScope: () => string, isCurrent: () => boolean) {
  const guard = createScopeRequestGuard(readScope)
  let disposed = false
  return {
    invalidate: () => guard.invalidate(),
    dispose() {
      disposed = true
      guard.invalidate()
    },
    async resolve(
      input: { id: string; name: string; selectedOrigin?: ModelPreset.Origin },
      metadata: FormModelMetadata | undefined,
      apply: (result: FormModelResolution) => void,
    ) {
      const token = guard.capture()
      let result: FormModelResolution
      try {
        result = metadata ? await metadata.resolve(input) : { status: "unknown" }
      } catch {
        result = { status: "unavailable" }
      }
      if (!disposed && isCurrent() && guard.isCurrent(token)) apply(result)
    },
  }
}
