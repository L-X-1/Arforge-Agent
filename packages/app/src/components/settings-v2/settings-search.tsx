import { For, Show, createContext, createMemo, createUniqueId, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import "./settings-search.css"

type SearchEntry = {
  id: string
  label: () => string
  description: () => string
  keywords: () => readonly string[]
  target: () => HTMLElement | undefined
}
function createSettingsSearch() {
  const [state, setState] = createStore({ query: "", entries: [] as SearchEntry[] })
  return {
    state,
    query: (query: string) => setState("query", query),
    register: (entry: SearchEntry) => {
      setState("entries", (entries) => [...entries, entry])
      return () => setState("entries", (entries) => entries.filter((item) => item.id !== entry.id))
    },
  }
}
const SearchContext = createContext<ReturnType<typeof createSettingsSearch>>()
export const useSettingsSearch = () => useContext(SearchContext)
export function SettingsSearchProvider(props: ParentProps) {
  return <SearchContext.Provider value={createSettingsSearch()}>{props.children}</SearchContext.Provider>
}

/** Only explicitly registered public labels are indexed. Values and DOM text are never read. */
export function SettingsLocalSearch() {
  const search = useSettingsSearch()
  const language = useLanguage()
  const resultsID = createUniqueId()
  const copy = () =>
    language.locale() === "zh"
      ? { search: "搜索通用设置", scope: "范围：本页设置标题与说明", clear: "清除搜索", empty: "没有匹配的设置。" }
      : language.locale() === "zht"
        ? { search: "搜尋一般設定", scope: "範圍：本頁設定標題與說明", clear: "清除搜尋", empty: "沒有符合的設定。" }
        : {
            search: "Search general settings",
            scope: "Scope: setting names and descriptions on this page",
            clear: "Clear search",
            empty: "No matching settings.",
          }
  const results = createMemo(() => {
    const words = search?.state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? []
    if (!words.length) return []
    return (
      search?.state.entries.filter((entry) => {
        const text = [entry.label(), entry.description(), ...entry.keywords()].join(" ").toLocaleLowerCase()
        return !!entry.label() && words.every((word) => text.includes(word))
      }) ?? []
    )
  })
  const focus = (entry: SearchEntry) => {
    const row = entry.target()
    if (!row?.isConnected || row.closest('[hidden], [inert], [aria-hidden="true"]')) return
    row.scrollIntoView({ block: "center", behavior: "instant" })
    const control = row.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
    )
    ;(control ?? row).focus({ preventScroll: true })
  }
  return (
    <div class="settings-local-search">
      <div class="settings-local-search-field">
        <TextInputV2
          type="search"
          aria-label={copy().search}
          placeholder={copy().search}
          aria-controls={resultsID}
          value={search?.state.query ?? ""}
          onInput={(event) => search?.query(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) return
            if (event.key === "Escape") {
              event.preventDefault()
              search?.query("")
            }
            if (event.key === "Enter") {
              event.preventDefault()
              const first = results()[0]
              if (first) focus(first)
            }
          }}
        />
        <Show when={search?.state.query}>
          <ButtonV2 type="button" variant="ghost" onClick={() => search?.query("")}>
            {copy().clear}
          </ButtonV2>
        </Show>
      </div>
      <p class="settings-local-search-scope">{copy().scope}</p>
      <Show when={search?.state.query.trim()}>
        <div id={resultsID} class="settings-local-search-results">
          <Show when={results().length} fallback={<p role="status">{copy().empty}</p>}>
            <ul>
              <For each={results()}>
                {(entry) => (
                  <li>
                    <button type="button" onClick={() => focus(entry)}>
                      <span>{entry.label()}</span>
                      <small>{entry.description()}</small>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  )
}
