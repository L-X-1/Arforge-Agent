import { For, Show, createMemo, createEffect, on, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { ManagementStatus } from "../settings-v2/management-status"
import { ManagementDetail } from "./management-detail"
import "./management-collection.css"

/** Opaque local row identity for read-only records without a wire ID; never sent to an API. */
export function createManagementRecordIdentity() {
  const identities = new WeakMap<object, string>()
  let sequence = 0
  return (record: object) => {
    let id = identities.get(record)
    if (!id) {
      id = `record-${++sequence}`
      identities.set(record, id)
    }
    return id
  }
}

/** Selection is presentation-only. Data, drafts and action owners stay with the caller. */
export function ManagementCollection<T>(props: {
  label: string
  scope: string
  scopeLabel?: string
  items: readonly T[]
  identity: (item: T) => string
  title: (item: T) => string
  description?: (item: T) => string
  searchText?: (item: T) => string
  status?: (item: T) => JSX.Element
  actions?: (item: T) => JSX.Element
  toolbar?: JSX.Element
  emptyText?: string
  onSelect?: (item: T) => void
  selectedIdentity?: string
  selectionDisabled?: boolean
  loading?: boolean
  children: (item: T, index: () => number) => JSX.Element
}) {
  const language = useLanguage()
  const [view, setView] = createStore({ query: "", selected: "", source: props.scope, openRequest: 0, page: 0 })
  const copy = () =>
    language.locale() === "zh"
      ? {
          search: "搜索",
          clear: "清除搜索",
          select: "选择对象查看详情",
          previous: "上一页",
          next: "下一页",
          page: "页",
          total: "已读对象",
        }
      : language.locale() === "zht"
        ? {
            search: "搜尋",
            clear: "清除搜尋",
            select: "選擇物件查看詳細資料",
            previous: "上一頁",
            next: "下一頁",
            page: "頁",
            total: "已讀物件",
          }
        : {
            search: "Search",
            clear: "Clear search",
            select: "Select an item to inspect",
            previous: "Previous page",
            next: "Next page",
            page: "Page",
            total: "Read items",
          }
  const selected = createMemo(() =>
    view.source === props.scope ? props.items.find((item) => props.identity(item) === view.selected) : undefined,
  )
  const filtered = createMemo(() => {
    const words = view.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return props.items.filter((item) => {
      const text = [props.title(item), props.description?.(item), props.searchText?.(item)]
        .join(" ")
        .toLocaleLowerCase()
      return words.every((word) => text.includes(word))
    })
  })
  const pages = () => Math.max(1, Math.ceil(filtered().length / 50))
  const page = () => Math.min(view.page, pages() - 1)
  const visible = () => filtered().slice(page() * 50, (page() + 1) * 50)
  createEffect(
    on(
      () => props.scope,
      (source) => setView({ source, selected: "", query: "", page: 0 }),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.selectedIdentity,
      (selected) => {
        if (selected) setView({ selected, source: props.scope, openRequest: view.openRequest + 1 })
      },
    ),
  )
  const select = (item: T) => {
    if (props.selectionDisabled) return
    setView({ source: props.scope, selected: props.identity(item), openRequest: view.openRequest + 1 })
    props.onSelect?.(item)
  }
  return (
    <section class="arforge-management-collection" aria-label={props.label}>
      <header class="arforge-management-collection-toolbar">
        <h3>{props.label}</h3>
        {props.toolbar}
        <TextInputV2
          type="search"
          appearance="base"
          value={view.query}
          aria-label={`${copy().search} · ${props.label}`}
          placeholder={`${copy().search} · ${props.label}`}
          onInput={(event) => setView({ query: event.currentTarget.value, page: 0 })}
        />
        <Show when={view.query}>
          <ButtonV2 variant="ghost" onClick={() => setView({ query: "", page: 0 })}>
            {copy().clear}
          </ButtonV2>
        </Show>
      </header>
      <Show when={props.scopeLabel}>
        <p class="arforge-management-search-scope">{props.scopeLabel}</p>
      </Show>
      <div class="arforge-management-master-detail">
        <div class="arforge-management-master-content">
          <div class="arforge-management-entity-list" role="list" aria-label={props.label}>
            <For each={visible()}>
              {(item, index) => (
                <div
                  class="arforge-management-entity-row"
                  role="listitem"
                  aria-posinset={page() * 50 + index() + 1}
                  aria-setsize={filtered().length}
                  data-density={props.description ? "double" : "single"}
                >
                  <button
                    type="button"
                    class="arforge-management-entity-select"
                    data-management-detail-id={props.identity(item)}
                    disabled={props.selectionDisabled}
                    aria-expanded={selected() !== undefined && view.selected === props.identity(item)}
                    onClick={() => select(item)}
                  >
                    <span class="arforge-management-entity-preview">{props.title(item)}</span>
                    <Show when={props.description}>
                      <span class="arforge-management-entity-meta">{props.description?.(item)}</span>
                    </Show>
                  </button>
                  {props.status?.(item)}
                  {props.actions?.(item)}
                </div>
              )}
            </For>
          </div>
          <Show when={pages() > 1}>
            <div class="arforge-management-list-pagination">
              <span>
                {copy().total}: {filtered().length} · {copy().page} {page() + 1} / {pages()}
              </span>
              <ButtonV2 variant="ghost" disabled={page() === 0} onClick={() => setView("page", page() - 1)}>
                {copy().previous}
              </ButtonV2>
              <ButtonV2 variant="ghost" disabled={page() + 1 >= pages()} onClick={() => setView("page", page() + 1)}>
                {copy().next}
              </ButtonV2>
            </div>
          </Show>
          <ManagementStatus
            noResults={!props.loading && !!view.query.trim() && filtered().length === 0}
            empty={!props.loading && !view.query.trim() && props.items.length === 0}
            emptyText={props.emptyText}
            scope={props.scopeLabel}
            onClearSearch={() => setView("query", "")}
          />
          <Show when={!selected() && props.items.length > 0}>
            <p class="arforge-management-search-scope">{copy().select}</p>
          </Show>
        </div>
        <Show when={selected()}>
          {(item) => (
            <ManagementDetail
              identity={props.identity(item())}
              title={props.title(item())}
              openRequest={view.openRequest}
            >
              {props.children(item(), () =>
                props.items.findIndex((row) => props.identity(row) === props.identity(item())),
              )}
            </ManagementDetail>
          )}
        </Show>
      </div>
    </section>
  )
}
