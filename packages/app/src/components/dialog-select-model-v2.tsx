import { Popover } from "@kobalte/core/popover"
import { useParams, useSearchParams } from "@solidjs/router"
import { useQueryClient } from "@tanstack/solid-query"
import { checksum } from "@arforge-ai/core/util/encode"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { Icon } from "@arforge-ai/ui/v2/icon"
import { Tag } from "@arforge-ai/ui/v2/badge-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { createEffect, createMemo, createUniqueId, For, on, onCleanup, Show, untrack, type ComponentProps, type JSX, type ValidComponent } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { ScopedKey } from "@/utils/server-scope"
import { handleModelPickerSearchKeydown } from "./dialog-select-model-keyboard"
import { ModelTooltip } from "./model-tooltip"
import { normalizeModelSearch } from "./dialog-select-model-search"
import { afterModelMenuClose, captureModelComposerSelection, consumeModelOutsidePress, focusModelPickerOrigin, modelPickerComposing } from "./dialog-select-model-dismissal"
import { groupModelOptions, ModelChoiceError, modelGroupOpen, modelOptionKey, restoreModelGroups, searchModelGroups, toggleModelGroup, type ModelChoice, type ModelGroupPreference, type ModelGroupState } from "./dialog-select-model-state"
import { confirmBoundModelChoice, type ModelSelectionBinding } from "./dialog-select-model-binding"
import { reconcileModelCatalog } from "./dialog-select-model-catalog"
export type { ModelSelectionBinding } from "./dialog-select-model-binding"
import "./dialog-select-model-v2.css"

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider" | "scope"

const messages = {
  en: {
    retry: "Retry", unavailable: "The selected model is unavailable. Your selection and draft are preserved.",
    provider: "The selected provider is no longer in this workspace's catalog.",
    disconnected: "The selected provider is disconnected. Reconnect it to use this model.",
    removed: "The selected model is no longer in the provider's catalog.",
    failed: "The model could not be selected. Your previous selection and draft are preserved.",
    stale: "The model catalog could not be refreshed. The last available catalog is shown.",
    notConfirmed: "The selection was not confirmed. Retry or configure the provider.",
    changed: "The session changed. Open its model selector to try again.",
    details: "Model details", empty: "No configured models are available. Connect a provider or manage models.",
  },
  zh: {
    retry: "重试", unavailable: "当前模型不可用。已保留原选择和草稿。",
    provider: "当前服务商已不在此工作区的模型目录中。",
    disconnected: "当前服务商未连接。请重新连接后使用此模型。",
    removed: "当前模型已不在服务商目录中。",
    failed: "模型选择失败。已保留原选择和草稿。",
    stale: "模型目录刷新失败，当前显示最后一次可用的目录。",
    notConfirmed: "模型选择尚未确认。请重试或配置服务商。",
    changed: "会话已切换，请重新打开当前会话的模型选择器。",
    details: "模型信息", empty: "暂无已配置的可用模型，请连接服务商或管理模型。",
  },
}

export function ModelSelectorPopoverV2(props: {
  provider?: string
  model?: ModelState
  /** Optional draft/session binding; omitted callers retain the existing model contract. */
  binding?: ModelSelectionBinding
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: Omit<ComponentProps<typeof Popover.Trigger>, "as" | "ref">
  /** Existing composer callback: successful selection only; Escape restores the trigger. */
  onClose?: () => void
}) {
  const local = useLocal()
  const language = useLanguage()
  const sdk = useSDK()
  const params = useParams()
  const [route] = useSearchParams<{ draftId?: string }>()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const model = () => props.model ?? local.model
  const binding = () => props.binding ?? (model() === local.model ? local.modelSelection : undefined)
  const copy = () => language.intl().startsWith("zh") ? messages.zh : messages.en
  const scope = () => binding()?.scope() ?? ScopedKey.from(sdk().scope, sdk().directory, params.id ?? route.draftId ?? "__draft__")
  const [preferences, setPreferences, , preferencesReady] = persisted(
    Persist.window("model-selector-groups.v2"),
    createStore<{ entries: Record<string, ModelGroupPreference | undefined> }>({ entries: {} }),
  )
  const [store, setStore] = createStore({
    open: false, hydrated: false, composing: false, active: "", scope: "", preferenceKey: "",
    groups: { saved: { open: {} }, query: "", searchOpen: {} } as ModelGroupState,
    selecting: false, refreshing: false, error: "", catalogError: false, catalogLoading: false,
    touch: false, viewportHeight: 0, viewportWidth: 0, viewportTop: 0, viewportLeft: 0,
  })
  let searchRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let triggerRef: HTMLElement | undefined
  let restoreSelection: ReturnType<typeof captureModelComposerSelection>
  let version = 0
  let mounted = true
  const id = createUniqueId()
  const catalogKey = () => [sdk().scope, sdk().directory, "providers"]
  const currentChoice = (): ModelChoice | undefined => {
    if (binding()) return binding()!.key()
    const item = model().current()
    return item ? { providerID: item.provider.id, modelID: item.id } : undefined
  }
  const allModels = createMemo(() => model().list()
    .filter((item) => !props.provider || item.provider.id === props.provider)
    .filter((item) => model().visible({ providerID: item.provider.id, modelID: item.id }) ||
      (currentChoice()?.providerID === item.provider.id && currentChoice()?.modelID === item.id)))
  const providerIDs = createMemo(() => [...new Set(allModels().map((item) => item.provider.id))])
  const groups = createMemo(() => groupModelOptions(allModels(), store.groups.query))
  const visibleModels = createMemo(() => groups().flatMap((group) => modelGroupOpen(store.groups, group.id) ? group.items : []))
  const selected = (item: ModelItem) => currentChoice()?.providerID === item.provider.id && currentChoice()?.modelID === item.id
  const activeButton = () => Array.from(contentRef?.querySelectorAll<HTMLButtonElement>("[data-option-key]") ?? [])
    .find((element) => element.dataset.optionKey === store.active)
  const chooseActive = () => {
    const items = visibleModels()
    return modelOptionKey(items.find(selected) ?? items[0])
  }
  const saveGroups = () => untrack(() => {
    if (!store.hydrated || !store.preferenceKey || providerIDs().length === 0) return
    setPreferences("entries", store.preferenceKey, reconcile({ ...store.groups.saved, open: { ...store.groups.saved.open } }))
  })
  const close = (cause: Dismiss) => {
    if (!store.open) return
    saveGroups()
    const expectedScope = store.scope
    const currentVersion = ++version
    const restore = restoreSelection
    setStore({ open: false, composing: false, selecting: false, refreshing: false, error: "" })
    afterModelMenuClose(() => {
      if (!mounted || currentVersion !== version || cause === "manage" || cause === "provider") return
      if (cause === "scope" || scope() !== expectedScope) {
        focusModelPickerOrigin()
        return
      }
      if (cause === "select") {
        props.onClose?.()
        if (!restore?.() && !props.onClose) focusModelPickerOrigin()
        return
      }
      focusModelPickerOrigin(triggerRef)
    })
  }
  const setOpen = (open: boolean) => {
    if (!open) return close("outside")
    const currentVersion = ++version
    restoreSelection = captureModelComposerSelection()
    setStore({ open: true, hydrated: false, scope: scope(), preferenceKey: checksum(scope()) ?? "model-selector", error: "", selecting: false, refreshing: false })
    const initialize = () => {
      if (!mounted || !store.open || currentVersion !== version || scope() !== store.scope) return
      setStore("groups", reconcile({
        saved: restoreModelGroups(providerIDs(), currentChoice()?.providerID, preferences.entries[store.preferenceKey]),
        query: "", searchOpen: {},
      }))
      setStore("hydrated", true)
      setStore("active", visibleModels().length ? chooseActive() : "")
      saveGroups()
      requestAnimationFrame(() => {
        if (!mounted || !store.open || currentVersion !== version) return
        if (store.touch) contentRef?.focus({ preventScroll: true })
        else searchRef?.focus({ preventScroll: true })
        activeButton()?.scrollIntoView({ block: "nearest" })
      })
    }
    if (preferencesReady()) initialize()
    else void Promise.resolve(preferencesReady.promise).then(initialize).catch(() => {
      if (currentVersion === version && store.open) setStore("error", copy().failed)
    })
  }
  const setSearch = (query: string) => {
    setStore("groups", reconcile(searchModelGroups(store.groups, query,
      groupModelOptions(allModels(), query).map((group) => group.id), providerIDs(), currentChoice()?.providerID)))
    setStore("active", visibleModels().length ? modelOptionKey(visibleModels()[0]) : "")
  }
  const toggleGroup = (provider: string) => {
    setStore("groups", reconcile(toggleModelGroup(store.groups, provider)))
    saveGroups()
    if (!visibleModels().some((item) => modelOptionKey(item) === store.active)) {
      setStore("active", visibleModels().length ? chooseActive() : "")
    }
  }
  const select = async (item: ModelItem) => {
    if (store.selecting || !store.hydrated) return
    const currentVersion = version
    const expectedScope = store.scope
    const selectedModel = model()
    const localBinding = binding()
    const active = () => mounted && store.open && currentVersion === version && model() === selectedModel && binding() === localBinding
    setStore({ selecting: true, error: "" })
    try {
      await confirmBoundModelChoice({
        choice: { providerID: item.provider.id, modelID: item.id }, scope, expectedScope,
        binding: localBinding, model: selectedModel, active,
      })
      if (active() && scope() === expectedScope) close("select")
    } catch (error) {
      if (!active() || scope() !== expectedScope) return
      setStore("error", error instanceof ModelChoiceError
        ? error.reason === "unavailable" ? copy().unavailable : error.reason === "scope-changed" ? copy().changed : copy().notConfirmed
        : copy().failed)
    } finally {
      if (mounted && currentVersion === version) setStore("selecting", false)
    }
  }
  const refresh = async () => {
    if (store.refreshing || store.selecting) return
    const currentVersion = version
    const expectedScope = scope()
    const key = catalogKey()
    const active = () => mounted && store.open && currentVersion === version && scope() === expectedScope
    setStore({ refreshing: true, error: "" })
    try {
      if (!queryClient.getQueryState(key)) throw new ModelChoiceError("unavailable")
      await queryClient.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true })
    } catch {
      if (active()) setStore("error", copy().stale)
    } finally {
      if (active()) setStore("refreshing", false)
    }
  }
  const manage = () => {
    close("manage")
    afterModelMenuClose(() => { void import("./dialog-manage-models").then((module) => dialog.show(() => <module.DialogManageModelsV2 />)) })
  }
  const connect = () => {
    const directory = sdk().directory
    close("provider")
    afterModelMenuClose(() => { void import("./dialog-connect-provider").then((module) => dialog.show(() => <module.DialogConnectProvider directory={() => directory} />)) })
  }
  const keydown = (event: KeyboardEvent) => {
    if (modelPickerComposing(event, store.composing)) return
    event.stopPropagation()
    if (event.key === "Escape") { event.preventDefault(); close("escape"); return }
    if (event.key === "Tab") {
      const elements = Array.from(contentRef?.querySelectorAll<HTMLElement>("input, button:not(:disabled), [tabindex='0']") ?? [])
        .filter((element) => element.tabIndex >= 0)
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === contentRef)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const items = visibleModels()
      if (!items.length) return
      const index = items.findIndex((item) => modelOptionKey(item) === store.active)
      const fromSearch = event.target === searchRef
      const next = fromSearch ? (index < 0 ? 0 : index) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
      setStore("active", modelOptionKey(items[next]))
      activeButton()?.focus({ preventScroll: true })
      activeButton()?.scrollIntoView({ block: "nearest" })
      return
    }
    if (event.key === "Enter" && event.target === searchRef) {
      event.preventDefault()
      const item = visibleModels().find((candidate) => modelOptionKey(candidate) === store.active)
      if (item) void select(item)
      return
    }
    handleModelPickerSearchKeydown(searchRef, event, store.groups.query, setSearch)
  }

  createEffect(() => {
    const key = catalogKey()
    const update = () => {
      const state = queryClient.getQueryState(key)
      setStore({ catalogError: state?.status === "error", catalogLoading: !!state && !state.data && state.status === "pending" })
    }
    update()
    onCleanup(queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] === key[0] && event.query.queryKey[1] === key[1] && event.query.queryKey[2] === key[2]) update()
    }))
  })
  createEffect(() => {
    if (store.open && scope() !== store.scope) close("scope")
  })
  createEffect(on(
    () => {
      if (!store.open || !store.hydrated || store.catalogLoading || store.catalogError) return
      return { providers: providerIDs(), matching: groups().map((group) => group.id), currentProvider: currentChoice()?.providerID }
    },
    (catalog) => {
      if (!catalog) return
      const next = reconcileModelCatalog(store.groups, catalog.providers, catalog.matching, catalog.currentProvider)
      if (JSON.stringify(next) !== JSON.stringify(store.groups)) setStore("groups", reconcile(next))
      if (!visibleModels().some((item) => modelOptionKey(item) === store.active)) {
        setStore("active", visibleModels().length ? chooseActive() : "")
      }
    },
  ))
  createEffect(() => {
    const media = window.matchMedia("(pointer: coarse), (max-width: 600px)")
    const viewport = window.visualViewport
    const update = () => setStore({ touch: media.matches, viewportHeight: viewport?.height ?? window.innerHeight,
      viewportWidth: viewport?.width ?? window.innerWidth, viewportTop: viewport?.offsetTop ?? 0, viewportLeft: viewport?.offsetLeft ?? 0 })
    update()
    media.addEventListener("change", update)
    window.addEventListener("resize", update)
    viewport?.addEventListener("resize", update)
    viewport?.addEventListener("scroll", update)
    onCleanup(() => { media.removeEventListener("change", update); window.removeEventListener("resize", update); viewport?.removeEventListener("resize", update); viewport?.removeEventListener("scroll", update) })
  })
  createEffect(() => {
    if (!store.open) return
    const outside = (event: PointerEvent) => {
      if (contentRef && event.composedPath().includes(contentRef)) return
      consumeModelOutsidePress(event)
      close("outside")
    }
    const composition = (event: KeyboardEvent) => {
      if (!contentRef?.contains(event.target as Node)) return
      if (modelPickerComposing(event, store.composing) && (event.key === "Escape" || event.key === "Enter" || event.keyCode === 229)) event.stopImmediatePropagation()
    }
    window.addEventListener("pointerdown", outside, true)
    window.addEventListener("keydown", composition, true)
    onCleanup(() => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", composition, true) })
  })
  onCleanup(() => { mounted = false; version++ })

  const style = (): JSX.CSSProperties => ({ "--model-viewport-height": `${store.viewportHeight}px`, "--model-viewport-width": `${store.viewportWidth}px`, "--model-viewport-top": `${store.viewportTop}px`, "--model-viewport-left": `${store.viewportLeft}px` })
  const unavailable = () => binding()?.unavailable()
  const body = () => <>
    <div class="arforge-model-picker__search">
      <Icon name="magnifying-glass" size="small" />
      <input ref={searchRef} type="search" value={store.groups.query} aria-label={language.t("dialog.model.search.placeholder")}
        aria-controls={`${id}-models`} placeholder={language.t("dialog.model.search.placeholder")} spellcheck={false} autocomplete="off" autocorrect="off" autocapitalize="off"
        onInput={(event) => setSearch(event.currentTarget.value)} onCompositionStart={() => setStore("composing", true)} onCompositionEnd={() => setStore("composing", false)} />
      <Show when={store.groups.query}>
        <button type="button" class="arforge-model-picker__clear" aria-label={language.t("common.clear")} onClick={() => { setSearch(""); searchRef?.focus() }}><Icon name="close" size="small" /></button>
      </Show>
    </div>
    <Show when={unavailable()}>{(reason) => <div class="arforge-model-picker__notice" role="status">
      <div>{copy()[reason()]}</div><div class="arforge-model-picker__id">{currentChoice()?.providerID} / {currentChoice()?.modelID}</div>
    </div>}</Show>
    <Show when={store.error || store.catalogError}><div class="arforge-model-picker__notice" role="alert">{store.error || copy().stale}</div></Show>
    <Show when={!store.hydrated || !model().ready() || (binding() && !binding()!.ready()) || store.catalogLoading}><div class="arforge-model-picker__notice" role="status">{language.t("common.loading")}</div></Show>
    <div id={`${id}-models`} class="arforge-model-picker__scroll" data-slot="model-selector-scroll" aria-busy={store.selecting || store.refreshing}>
      <Show when={groups().length} fallback={<div class="arforge-model-picker__empty" role="status">{normalizeModelSearch(store.groups.query) ? language.t("dialog.model.empty") : copy().empty}</div>}>
        <For each={groups()}>{(group) => <section aria-label={group.name}>
          <button type="button" class="arforge-model-picker__group" aria-expanded={modelGroupOpen(store.groups, group.id)} aria-controls={`${id}-${encodeURIComponent(group.id)}`} onClick={() => toggleGroup(group.id)}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ transform: modelGroupOpen(store.groups, group.id) ? "rotate(90deg)" : undefined }}><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
            <span>{group.name}</span>
          </button>
          <div id={`${id}-${encodeURIComponent(group.id)}`} hidden={!modelGroupOpen(store.groups, group.id)}>
            <Show when={modelGroupOpen(store.groups, group.id)}><For each={group.items}>{(item) =>
              <TooltipV2 class="w-full" placement="right-start" gutter={6} openDelay={400} value={<ModelTooltip model={item} latest={item.latest} free={item.provider.id === "arforge" && (!item.cost || item.cost.input === 0)} v2 />}>
                <button type="button" class="arforge-model-picker__row" data-option-key={modelOptionKey(item)} data-selected-model={selected(item) ? true : undefined}
                  data-active={store.active === modelOptionKey(item) ? true : undefined} aria-pressed={selected(item)}
                  aria-label={`${item.name}, ${item.id}, ${item.provider.name}`} tabIndex={store.active === modelOptionKey(item) ? 0 : -1}
                  disabled={store.selecting || !store.hydrated || !model().ready() || !!(binding() && !binding()!.ready())} onFocus={() => setStore("active", modelOptionKey(item))} onClick={() => void select(item)}>
                  <span class="arforge-model-picker__labels"><span class="arforge-model-picker__name">{item.name}</span>
                    <Show when={item.name !== item.id}><span class="arforge-model-picker__id">{item.id}</span></Show>
                    <Show when={item.latest || (item.provider.id === "arforge" && (!item.cost || item.cost.input === 0))}><span class="arforge-model-picker__tags">
                      <Show when={item.provider.id === "arforge" && (!item.cost || item.cost.input === 0)}><Tag>{language.t("model.tag.free")}</Tag></Show>
                      <Show when={item.latest}><Tag>{language.t("model.tag.latest")}</Tag></Show>
                    </span></Show>
                  </span><Show when={selected(item)}><Icon name="check" size="small" /></Show>
                </button>
              </TooltipV2>
            }</For></Show>
          </div>
        </section>}</For>
      </Show>
    </div>
    <div class="arforge-model-picker__footer">
      <Show when={unavailable() || store.error || store.catalogError}><button type="button" class="arforge-model-picker__action" disabled={store.refreshing || store.selecting} onClick={() => void refresh()}>{store.refreshing ? language.t("common.loading") : copy().retry}</button></Show>
      <button type="button" class="arforge-model-picker__action" disabled={store.selecting} onClick={manage}><Icon name="outline-sliders" size="small" />{language.t("dialog.model.manage")}</button>
      <button type="button" class="arforge-model-picker__action" disabled={store.selecting} onClick={connect}>{language.t("command.provider.connect")}</button>
      <Show when={store.touch}><button type="button" class="arforge-model-picker__action" onClick={() => close("escape")}>{language.t("common.close")}</button></Show>
    </div>
  </>
  return <Popover open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
    <Popover.Trigger ref={(element) => triggerRef = element} as={props.triggerAs ?? "button"} {...props.triggerProps}>{props.children}</Popover.Trigger>
    <Show when={store.open && store.touch} fallback={<Show when={!store.touch}><Popover.Portal><Popover.Content
      ref={(element) => contentRef = element} class="arforge-model-picker" style={style()} onKeyDown={keydown}
      onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); if (!modelPickerComposing(event, store.composing)) close("escape") }}
      onPointerDownOutside={(event) => event.preventDefault()} onFocusOutside={(event) => event.preventDefault()}>
      <Popover.Title class="sr-only">{language.t("dialog.model.select.title")}</Popover.Title>{body()}
    </Popover.Content></Popover.Portal></Show>}>
      <Portal><div ref={(element) => contentRef = element} class="arforge-model-picker" data-touch="true" role="dialog" aria-label={language.t("dialog.model.select.title")} tabIndex={-1} style={style()} onKeyDown={keydown}>{body()}</div></Portal>
    </Show>
  </Popover>
}
