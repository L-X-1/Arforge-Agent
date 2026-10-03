import { matchesModelSearch, modelSearchRank, normalizeModelSearch } from "./dialog-select-model-search"

export type ModelChoice = { providerID: string; modelID: string }
export type PickerModel = { id: string; name: string; provider: { id: string; name: string } }
export type ModelGroupPreference = { open: Record<string, boolean>; currentProvider?: string; initialized?: boolean }
export type ModelGroupState = { saved: ModelGroupPreference; query: string; searchOpen: Record<string, boolean> }

// JSON tuples remain unique even when either stable ID contains ':' or '/'.
export const modelOptionKey = (model: PickerModel) => JSON.stringify([model.provider.id, model.id])
export const sameModelChoice = (a: ModelChoice | undefined, b: ModelChoice | undefined) =>
  !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID

export function groupModelOptions<T extends PickerModel>(models: readonly T[], query = "") {
  const grouped = new Map<string, { id: string; name: string; items: T[] }>()
  for (const model of models) {
    if (!matchesModelSearch(query, [model.name, model.id, model.provider.name])) continue
    let group = grouped.get(model.provider.id)
    if (!group) {
      group = { id: model.provider.id, name: model.provider.name, items: [] }
      grouped.set(group.id, group)
    }
    group.items.push(model)
  }
  const groups = [...grouped.values()]
  if (normalizeModelSearch(query)) {
    for (const group of groups) group.items.sort((a, b) => modelSearchRank(query, a.name) - modelSearchRank(query, b.name))
  }
  return groups
}

export function restoreModelGroups(
  providers: readonly string[],
  currentProvider: string | undefined,
  previous?: ModelGroupPreference,
): ModelGroupPreference {
  // An empty first catalog is not a saved choice to collapse future groups.
  // Older persisted records without this flag still count as established preferences.
  const restored = previous?.initialized === false ? undefined : previous
  const current = providers.includes(currentProvider ?? "") ? currentProvider : undefined
  const open = Object.fromEntries(providers.map((id) => [id, restored ? restored.open[id] === true : !current || id === current]))
  if (current && current !== restored?.currentProvider) open[current] = true
  return { open, currentProvider, initialized: !!restored || providers.length > 0 }
}

export function reconcileModelGroupCatalog(
  providers: readonly string[],
  currentProvider: string | undefined,
  previous: ModelGroupPreference,
) {
  // Read the live current provider only for the first populated catalog.
  // Later refreshes must preserve manual folds until the next explicit opening.
  return restoreModelGroups(providers, previous.initialized === false ? currentProvider : previous.currentProvider, previous)
}

export function searchModelGroups(
  state: ModelGroupState,
  query: string,
  matches: readonly string[],
  providers: readonly string[],
  currentProvider?: string,
): ModelGroupState {
  const normalized = normalizeModelSearch(query)
  if (!normalized) {
    return { saved: restoreModelGroups(providers, currentProvider, state.saved), query, searchOpen: {} }
  }
  if (normalized === normalizeModelSearch(state.query)) return { ...state, query }
  return { ...state, query, searchOpen: Object.fromEntries(matches.map((id) => [id, true])) }
}

export function toggleModelGroup(state: ModelGroupState, id: string): ModelGroupState {
  if (normalizeModelSearch(state.query)) {
    return { ...state, searchOpen: { ...state.searchOpen, [id]: !state.searchOpen[id] } }
  }
  return { ...state, saved: { ...state.saved, open: { ...state.saved.open, [id]: !state.saved.open[id] } } }
}

export const modelGroupOpen = (state: ModelGroupState, id: string) =>
  (normalizeModelSearch(state.query) ? state.searchOpen : state.saved.open)[id] === true

/** An explicit unavailable choice is deliberately not replaced by a default. */
export function resolveModelChoice<T>(
  choice: ModelChoice | undefined,
  available: (choice: ModelChoice) => boolean,
  find: (choice: ModelChoice) => T | undefined,
): T | undefined {
  return choice && available(choice) ? find(choice) : undefined
}

export class ModelChoiceError extends Error {
  constructor(readonly reason: "unavailable" | "scope-changed" | "not-confirmed") {
    super(reason)
    this.name = "ModelChoiceError"
  }
}

export async function confirmModelChoice(input: {
  choice: ModelChoice
  scope: () => string
  expectedScope: string
  available: (choice: ModelChoice) => boolean
  write: (choice: ModelChoice) => unknown
  current: () => ModelChoice | undefined
}) {
  if (input.scope() !== input.expectedScope) throw new ModelChoiceError("scope-changed")
  if (!input.available(input.choice)) throw new ModelChoiceError("unavailable")
  await input.write({ ...input.choice })
  if (input.scope() !== input.expectedScope) throw new ModelChoiceError("scope-changed")
  if (!sameModelChoice(input.current(), input.choice)) throw new ModelChoiceError("not-confirmed")
}
