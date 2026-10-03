import { normalizeModelSearch } from "./dialog-select-model-search"
import { reconcileModelGroupCatalog, type ModelGroupState } from "./dialog-select-model-state"

/** Catalog arrivals augment search expansion without replacing its saved fold snapshot. */
export function reconcileModelCatalog(
  state: ModelGroupState,
  providers: readonly string[],
  matching: readonly string[],
  currentProvider: string | undefined,
): ModelGroupState {
  const saved = reconcileModelGroupCatalog(providers, currentProvider, state.saved)
  const searchOpen = { ...state.searchOpen }
  if (normalizeModelSearch(state.query)) {
    for (const provider of matching) {
      if (!Object.hasOwn(searchOpen, provider)) searchOpen[provider] = true
    }
  }
  return { ...state, saved, searchOpen }
}
