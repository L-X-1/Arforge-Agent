import { Popover } from "@kobalte/core/popover"
import { useParams, useSearchParams } from "@solidjs/router"
import { checksum } from "@arforge-ai/core/util/encode"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { Icon } from "@arforge-ai/ui/v2/icon"
import { Tag } from "@arforge-ai/ui/v2/badge-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import { KeybindV2 } from "@arforge-ai/ui/v2/keybind-v2"
import {
  createEffect,
  createMemo,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  untrack,
  type ComponentProps,
  type JSX,
  type ValidComponent,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ScopedKey } from "@/utils/server-scope"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { handleModelPickerSearchKeydown } from "./dialog-select-model-keyboard"
import { ModelTooltip } from "./model-tooltip"
import { normalizeModelSearch } from "./dialog-select-model-search"
import {
  afterModelMenuClose,
  captureModelComposerSelection,
  consumeModelOutsidePress,
  focusModelPickerOrigin,
  modelPickerComposing,
} from "./dialog-select-model-dismissal"
import {
  groupModelOptions,
  ModelChoiceError,
  modelGroupOpen,
  modelOptionKey,
  restoreModelGroups,
  searchModelGroups,
  toggleModelGroup,
  type ModelChoice,
  type ModelGroupPreference,
  type ModelGroupState,
} from "./dialog-select-model-state"
import { confirmBoundModelChoice, type ModelSelectionBinding } from "./dialog-select-model-binding"
import { reconcileModelCatalog } from "./dialog-select-model-catalog"
import { classifyModelCatalogError, type ModelCatalogFailure } from "./dialog-select-model-error"
import {
  chooserProvider,
  chooserCapabilityBadges,
  chooserVariantGroups,
  chooserStrengthOptions,
  chooserStep,
  chooserRangeIndex,
  commitChooserVariant,
  type ChooserVariant,
} from "./dialog-select-model-presentation"
import { chooserCopy, chooserVariantLabel } from "./dialog-select-model-copy"
import { ModelStrengthDial } from "./model-strength-dial"
export type { ModelSelectionBinding } from "./dialog-select-model-binding"
import "./dialog-select-model-v2.css"

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider" | "scope"
type StrengthCapture = {
  input: "range" | "dial"
  current: (committed?: boolean) => boolean
  options: ChooserVariant[]
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
  /** Gate a new open without unmounting an already open catalog during refresh. */
  canOpen?: boolean
  onOpenBlocked?: () => void
}) {
  const local = useLocal()
  const command = useCommand()
  const language = useLanguage()
  const sdk = useSDK()
  const params = useParams()
  const [route] = useSearchParams<{ draftId?: string }>()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const providers = useProviders(() => sdk().directory)
  const model = () => props.model ?? local.model
  const binding = () => props.binding ?? (model() === local.model ? local.modelSelection : undefined)
  const copy = () => chooserCopy(language.locale())
  const scope = () =>
    binding()?.scope() ?? ScopedKey.from(sdk().scope, sdk().directory, params.id ?? route.draftId ?? "__draft__")
  const ownership = createSessionOwnership(scope)
  const [preferences, setPreferences, , preferencesReady] = persisted(
    Persist.window("model-selector-groups.v2"),
    createStore<{ entries: Record<string, ModelGroupPreference | undefined> }>({ entries: {} }),
  )
  const [store, setStore] = createStore({
    open: false,
    hydrated: false,
    composing: false,
    active: "",
    provider: "",
    scope: "",
    preferenceKey: "",
    groups: { saved: { open: {} }, query: "", searchOpen: {} } as ModelGroupState,
    selecting: false,
    refreshing: false,
    error: "",
    catalogError: false,
    catalogLoading: false,
    catalogFailure: "unknown" as ModelCatalogFailure,
    touch: false,
    viewportHeight: 0,
    viewportWidth: 0,
    viewportTop: 0,
    viewportLeft: 0,
    strengthPreview: undefined as number | undefined,
    strengthMotionPaused: false,
    strengthMotionReduced: false,
  })
  let searchRef: HTMLInputElement | undefined
  let strengthInputRef: HTMLInputElement | undefined
  let contentRef: HTMLDivElement | undefined
  let triggerRef: HTMLElement | undefined
  let restoreSelection: ReturnType<typeof captureModelComposerSelection>
  let version = 0
  let mounted = true
  let openedSource: ReturnType<typeof sdk> | undefined
  let openedModel: ModelState | undefined
  let openedBinding: ModelSelectionBinding | undefined
  const id = createUniqueId()
  const catalogKey = () => [sdk().scope, pathKey(sdk().directory), "providers"]
  const currentChoice = (): ModelChoice | undefined => {
    if (binding()) return binding()!.key()
    const item = model().current()
    return item ? { providerID: item.provider.id, modelID: item.id } : undefined
  }
  const variantOwnership = createSessionOwnership(() =>
    JSON.stringify([scope(), currentChoice()?.providerID, currentChoice()?.modelID]),
  )
  const allModels = createMemo(() =>
    model()
      .list()
      .filter((item) => !props.provider || item.provider.id === props.provider)
      .filter(
        (item) =>
          model().visible({ providerID: item.provider.id, modelID: item.id }) ||
          (currentChoice()?.providerID === item.provider.id && currentChoice()?.modelID === item.id),
      ),
  )
  const providerIDs = createMemo(() => [...new Set(allModels().map((item) => item.provider.id))])
  const groups = createMemo(() => groupModelOptions(allModels(), store.groups.query))
  const connections = createMemo(() => {
    const entries = new Map<string, { id: string; name: string }>()
    for (const provider of providers.connected()) {
      if (!props.provider || props.provider === provider.id)
        entries.set(provider.id, { id: provider.id, name: provider.name })
    }
    for (const group of groupModelOptions(allModels()))
      if (!entries.has(group.id)) entries.set(group.id, { id: group.id, name: group.name })
    const matches = new Set(groups().map((group) => group.id))
    return [...entries.values()].filter((item) => !normalizeModelSearch(store.groups.query) || matches.has(item.id))
  })
  const browsing = createMemo(() => chooserProvider(connections(), store.provider, currentChoice()?.providerID))
  const displayedGroups = createMemo(() => groups().filter((group) => group.id === browsing()))
  const visibleModels = createMemo(() =>
    displayedGroups().flatMap((group) => (modelGroupOpen(store.groups, group.id) ? group.items : [])),
  )
  const selected = (item: ModelItem) =>
    currentChoice()?.providerID === item.provider.id && currentChoice()?.modelID === item.id
  const activeButton = () =>
    Array.from(contentRef?.querySelectorAll<HTMLButtonElement>("[data-option-key]") ?? []).find(
      (element) => element.dataset.optionKey === store.active,
    )
  const chooseActive = () => {
    const items = visibleModels()
    return modelOptionKey(items.find(selected) ?? items[0])
  }
  const saveGroups = () =>
    untrack(() => {
      if (!store.hydrated || !store.preferenceKey || providerIDs().length === 0) return
      setPreferences(
        "entries",
        store.preferenceKey,
        reconcile({ ...store.groups.saved, open: { ...store.groups.saved.open } }),
      )
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
    if (!store.open && props.canOpen === false) {
      props.onOpenBlocked?.()
      return
    }
    const currentVersion = ++version
    restoreSelection = captureModelComposerSelection()
    openedSource = sdk()
    openedModel = model()
    openedBinding = binding()
    setStore({
      open: true,
      hydrated: false,
      scope: scope(),
      preferenceKey: checksum(scope()) ?? "model-selector",
      error: "",
      selecting: false,
      refreshing: false,
      provider: currentChoice()?.providerID ?? "",
    })
    const initialize = () => {
      if (!mounted || !store.open || currentVersion !== version || scope() !== store.scope) return
      setStore(
        "groups",
        reconcile({
          saved: restoreModelGroups(
            providerIDs(),
            currentChoice()?.providerID,
            preferences.entries[store.preferenceKey],
          ),
          query: "",
          searchOpen: {},
        }),
      )
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
    else
      void Promise.resolve(preferencesReady.promise)
        .then(initialize)
        .catch(() => {
          if (currentVersion === version && store.open) setStore("error", copy().failed)
        })
  }
  const setSearch = (query: string) => {
    setStore(
      "groups",
      reconcile(
        searchModelGroups(
          store.groups,
          query,
          groupModelOptions(allModels(), query).map((group) => group.id),
          providerIDs(),
          currentChoice()?.providerID,
        ),
      ),
    )
    setStore("active", visibleModels().length ? modelOptionKey(visibleModels()[0]) : "")
  }
  const toggleGroup = (provider: string) => {
    setStore("groups", reconcile(toggleModelGroup(store.groups, provider)))
    saveGroups()
    if (!visibleModels().some((item) => modelOptionKey(item) === store.active)) {
      setStore("active", visibleModels().length ? chooseActive() : "")
    }
  }
  const browse = (provider: string) => {
    setStore("provider", provider)
    if (!modelGroupOpen(store.groups, provider)) toggleGroup(provider)
    setStore("active", visibleModels().length ? chooseActive() : "")
  }
  const variantGroups = createMemo(() => chooserVariantGroups(model().variant.list(), model().current()?.variants))
  const strength = createMemo(() => chooserStrengthOptions(variantGroups(), model().current()?.variants))
  const strengthOptions = () => strength().levels
  const strengthModes = () => [...strength().modes, ...(strengthOptions().length === 1 ? strengthOptions() : [])]
  const strengthShortcut = createMemo(() => command.keybindParts("model.variant.cycle"))
  let rangeCapture: StrengthCapture | undefined
  const clearStrengthPreview = () => {
    rangeCapture = undefined
    setStore("strengthPreview", undefined)
  }
  const strengthSelection = createMemo(() => {
    const preview = store.strengthPreview
    if (
      preview !== undefined &&
      rangeCapture?.current() &&
      chooserRangeIndex(preview, strengthOptions().length) !== undefined
    )
      return preview
    return strengthOptions().findIndex((option) => option.value === model().variant.current())
  })
  const strengthIndex = () => Math.max(0, strengthSelection())
  const strengthState = () => {
    if (strengthOptions().length < 2) return "unavailable"
    const index = strengthSelection()
    if (index < 0) return "mode"
    if (strengthOptions()[index] === strength().off) return "off"
    return index === strengthOptions().length - 1 ? "max" : "level"
  }
  const variantLabel = (option: ChooserVariant) =>
    option === strength().off
      ? copy().strengthNames.off
      : chooserVariantLabel(
          option.value,
          language.locale(),
          true,
          option.value === undefined ? undefined : model().current()?.variants?.[option.value],
        )
  const strengthStops = createMemo(() =>
    strengthOptions().map((option) => ({ key: option.key, label: variantLabel(option) })),
  )
  const strengthValue = () => {
    const selected = strengthOptions()[strengthSelection()]
    if (selected) return variantLabel(selected)
    const value = model().variant.current()
    return chooserVariantLabel(
      value,
      language.locale(),
      variantGroups().reasoning.some((option) => option.value === value),
      value === undefined ? undefined : model().current()?.variants?.[value],
    )
  }
  const restoreStrengthInput = (origin: HTMLInputElement) => {
    clearStrengthPreview()
    origin.valueAsNumber = strengthIndex()
  }
  const variantDisabled = () =>
    store.selecting || !store.hydrated || !model().ready() || !model().current() || !!(binding() && !binding()!.ready())
  const strengthDisabled = () => variantDisabled() || !model().current() || strengthOptions().length < 2
  const strengthReason = () => {
    if (!store.hydrated || !model().ready() || (binding() && !binding()!.ready())) return language.t("common.loading")
    if (!model().current()) return copy().unavailable
    if (!variantGroups().reasoning.length) return copy().noReasoning
    if (!strengthOptions().length) return copy().noStrengthScale
    if (strengthOptions().length === 1) return copy().singleStrength
  }
  const captureStrength = (input: StrengthCapture["input"]) => {
    const options = strengthOptions()
    const keys = options.map((option) => option.key).join("\n")
    const capturedVersion = version
    const source = sdk()
    const selectedModel = model()
    const selectedBinding = binding()
    const selectedStrength = strength()
    const selectedVariant = selectedModel.variant.current()
    const owner = variantOwnership.capture()
    let retired = false
    const capture: StrengthCapture = {
      input,
      options,
      current: (committed = false) => {
        if (retired) return false
        retired = !(
          mounted &&
          store.open &&
          version === capturedVersion &&
          sdk() === source &&
          model() === selectedModel &&
          binding() === selectedBinding &&
          strength() === selectedStrength &&
          (committed || selectedModel.variant.current() === selectedVariant) &&
          owner.current() &&
          keys ===
            strengthOptions()
              .map((option) => option.key)
              .join("\n")
        )
        return !retired
      },
    }
    rangeCapture = capture
    return capture
  }
  const previewStrength = (value: number, capture: StrengthCapture) => {
    if (
      rangeCapture !== capture ||
      strengthDisabled() ||
      chooserRangeIndex(value, capture.options.length) === undefined
    )
      return
    if (!capture.current()) {
      setStore("strengthPreview", undefined)
      return
    }
    setStore("strengthPreview", value)
  }
  const changeStrength = (value: number, origin: HTMLInputElement, capture: StrengthCapture) => {
    if (rangeCapture !== capture) return
    const index = chooserRangeIndex(value, capture.options.length)
    clearStrengthPreview()
    if (!capture.current() || index === undefined) {
      origin.valueAsNumber = strengthIndex()
      return
    }
    const target = capture.options[index]
    if (target.value === model().variant.current()) return
    const focused = document.activeElement === origin
    void selectVariant(target).then(() => {
      if (
        focused &&
        capture.current(true) &&
        origin.isConnected &&
        (document.activeElement === document.body || document.activeElement === origin)
      )
        origin.focus({ preventScroll: true })
    })
  }
  const previewRangeStrength = (value: number) => {
    if (strengthDisabled() || chooserRangeIndex(value, strengthOptions().length) === undefined) return
    const capture = rangeCapture?.input === "range" ? rangeCapture : captureStrength("range")
    previewStrength(value, capture)
  }
  const changeRangeStrength = (origin: HTMLInputElement) => {
    if (rangeCapture?.input === "range") changeStrength(origin.valueAsNumber, origin, rangeCapture)
  }
  const beginDialStrength = (index: number) => {
    const origin = strengthInputRef
    if (!origin || strengthDisabled() || chooserRangeIndex(index, strengthOptions().length) === undefined) return
    origin.focus({ preventScroll: true })
    const capture = captureStrength("dial")
    previewStrength(index, capture)
    return {
      preview: (value: number) => previewStrength(value, capture),
      commit: (value: number) => changeStrength(value, origin, capture),
      cancel: () => {
        if (rangeCapture === capture) restoreStrengthInput(origin)
      },
    }
  }
  const selectVariant = async (option: ChooserVariant) => {
    if (variantDisabled()) return
    const currentVersion = version
    const expectedScope = store.scope
    const selectedModel = model()
    const selectedBinding = binding()
    const selectedVariants = variantGroups()
    const source = sdk()
    const choice = currentChoice()
    const owner = variantOwnership.capture()
    const active = () =>
      mounted &&
      store.open &&
      version === currentVersion &&
      scope() === expectedScope &&
      owner.current() &&
      sdk() === source &&
      model() === selectedModel &&
      binding() === selectedBinding &&
      variantGroups() === selectedVariants &&
      currentChoice()?.providerID === choice?.providerID &&
      currentChoice()?.modelID === choice?.modelID
    setStore({ selecting: true, error: "" })
    try {
      const result = await commitChooserVariant({
        value: option.value,
        current: active,
        supported: () => selectedModel.variant.list(),
        write: (value) => selectedModel.variant.set(value),
      })
      if (active() && result === "unsupported") setStore("error", copy().unavailable)
    } catch {
      if (active()) setStore("error", copy().failed)
    } finally {
      if (mounted && version === currentVersion) setStore("selecting", false)
    }
  }
  const select = async (item: ModelItem) => {
    if (store.selecting || !store.hydrated) return
    const currentVersion = version
    const expectedScope = store.scope
    const selectedModel = model()
    const localBinding = binding()
    const active = () =>
      mounted && store.open && currentVersion === version && model() === selectedModel && binding() === localBinding
    setStore({ selecting: true, error: "" })
    try {
      await confirmBoundModelChoice({
        choice: { providerID: item.provider.id, modelID: item.id },
        scope,
        expectedScope,
        binding: localBinding,
        model: selectedModel,
        active,
      })
      if (active() && scope() === expectedScope) close("select")
    } catch (error) {
      if (!active() || scope() !== expectedScope) return
      setStore(
        "error",
        error instanceof ModelChoiceError
          ? error.reason === "unavailable"
            ? copy().unavailable
            : error.reason === "scope-changed"
              ? copy().changed
              : copy().notConfirmed
          : copy().failed,
      )
    } finally {
      if (mounted && currentVersion === version) setStore("selecting", false)
    }
  }
  const refresh = async () => {
    if (store.refreshing || store.selecting) return
    const currentVersion = version
    const expectedScope = scope()
    const key = catalogKey()
    const queryClient = serverSync().queryClient
    const active = () =>
      mounted &&
      store.open &&
      currentVersion === version &&
      scope() === expectedScope &&
      serverSync().queryClient === queryClient
    setStore({ refreshing: true, error: "" })
    try {
      if (!queryClient.getQueryState(key)) throw new ModelChoiceError("unavailable")
      await queryClient.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true })
    } catch (error) {
      if (active()) setStore({ error: "", catalogError: true, catalogFailure: classifyModelCatalogError(error) })
    } finally {
      if (active()) setStore("refreshing", false)
    }
  }
  const handoff = <T,>(cause: "manage" | "provider", load: () => Promise<T>, render: (module: T) => JSX.Element) => {
    if (!store.open) return
    const owner = ownership.capture()
    const selectedModel = model()
    const selectedBinding = binding()
    close(cause)
    const expectedVersion = version
    const previousDialog = dialog.active
    const current = () =>
      mounted &&
      expectedVersion === version &&
      !store.open &&
      owner.current() &&
      model() === selectedModel &&
      binding() === selectedBinding &&
      dialog.active === previousDialog
    afterModelMenuClose(() => {
      if (!current()) return
      void load()
        .then((module) => {
          if (current()) dialog.show(() => render(module))
        })
        .catch(() => {
          if (!current()) return
          setOpen(true)
          setStore("error", copy().failed)
        })
    })
  }
  const manage = () =>
    handoff(
      "manage",
      () => import("./dialog-manage-models"),
      (module) => <module.DialogManageModelsV2 />,
    )
  const connect = () => {
    const directory = sdk().directory
    handoff(
      "provider",
      () => import("./dialog-connect-provider"),
      (module) => <module.DialogConnectProvider directory={() => directory} />,
    )
  }
  const keydown = (event: KeyboardEvent) => {
    if (modelPickerComposing(event, store.composing)) return
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      close("escape")
      return
    }
    if (event.key === "Tab") {
      const elements = Array.from(
        contentRef?.querySelectorAll<HTMLElement>(
          "input:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex='0']",
        ) ?? [],
      ).filter((element) => element.tabIndex >= 0)
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === contentRef)) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target instanceof Element ? event.target : undefined
    // The native range owns keyboard and assistive-technology input for the dial.
    if (target?.closest('input[type="range"]')) return
    const provider = target?.closest<HTMLElement>("[data-provider-id]")
    if (provider) {
      const items = connections()
      const index = items.findIndex((item) => item.id === provider.dataset.providerId)
      const next = chooserStep(event.key, index, items.length)
      if (next !== undefined && event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        event.preventDefault()
        browse(items[next].id)
        Array.from(contentRef?.querySelectorAll<HTMLElement>("[data-provider-id]") ?? [])
          .find((item) => item.dataset.providerId === items[next].id)
          ?.focus()
        return
      }
      if (event.key === "ArrowRight") {
        event.preventDefault()
        activeButton()?.focus()
        return
      }
    }
    if (target?.closest("select")) return
    if (event.key === "ArrowLeft" && target?.closest("[data-option-key]")) {
      event.preventDefault()
      Array.from(contentRef?.querySelectorAll<HTMLElement>("[data-provider-id]") ?? [])
        .find((item) => item.dataset.providerId === browsing())
        ?.focus()
      return
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const items = visibleModels()
      if (!items.length) return
      const index = items.findIndex((item) => modelOptionKey(item) === store.active)
      const fromSearch = event.target === searchRef
      const next = fromSearch
        ? index < 0
          ? 0
          : index
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
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
    if (!store.open) clearStrengthPreview()
    else if (store.strengthPreview !== undefined && rangeCapture && !rangeCapture.current())
      setStore("strengthPreview", undefined)
  })
  createEffect(() => {
    if (!store.open || strengthOptions().length < 2) return
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setStore("strengthMotionReduced", motion.matches)
    update()
    motion.addEventListener("change", update)
    onCleanup(() => motion.removeEventListener("change", update))
  })
  createEffect(() => {
    const key = catalogKey()
    const queryClient = serverSync().queryClient
    const update = () => {
      const state = queryClient.getQueryState(key)
      setStore({
        catalogError: state?.status === "error",
        catalogLoading: !!state && !state.data && state.status === "pending",
        catalogFailure: classifyModelCatalogError(state?.error),
      })
    }
    update()
    onCleanup(
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.query.queryKey[0] === key[0] &&
          event.query.queryKey[1] === key[1] &&
          event.query.queryKey[2] === key[2]
        )
          update()
      }),
    )
  })
  createEffect(() => {
    if (
      store.open &&
      (scope() !== store.scope || sdk() !== openedSource || model() !== openedModel || binding() !== openedBinding)
    )
      close("scope")
  })
  createEffect(
    on(
      () => {
        if (!store.open || !store.hydrated || store.catalogLoading || store.catalogError) return
        return {
          providers: providerIDs(),
          matching: groups().map((group) => group.id),
          currentProvider: currentChoice()?.providerID,
        }
      },
      (catalog) => {
        if (!catalog) return
        const next = reconcileModelCatalog(store.groups, catalog.providers, catalog.matching, catalog.currentProvider)
        if (JSON.stringify(next) !== JSON.stringify(store.groups)) setStore("groups", reconcile(next))
        if (!visibleModels().some((item) => modelOptionKey(item) === store.active)) {
          setStore("active", visibleModels().length ? chooseActive() : "")
        }
      },
    ),
  )
  createEffect(() => {
    const media = window.matchMedia("(pointer: coarse), (max-width: 600px)")
    const viewport = window.visualViewport
    const update = () =>
      setStore({
        touch: media.matches,
        viewportHeight: viewport?.height ?? window.innerHeight,
        viewportWidth: viewport?.width ?? window.innerWidth,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportLeft: viewport?.offsetLeft ?? 0,
      })
    update()
    media.addEventListener("change", update)
    window.addEventListener("resize", update)
    viewport?.addEventListener("resize", update)
    viewport?.addEventListener("scroll", update)
    onCleanup(() => {
      media.removeEventListener("change", update)
      window.removeEventListener("resize", update)
      viewport?.removeEventListener("resize", update)
      viewport?.removeEventListener("scroll", update)
    })
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
      if (
        modelPickerComposing(event, store.composing) &&
        (event.key === "Escape" || event.key === "Enter" || event.keyCode === 229)
      )
        event.stopImmediatePropagation()
    }
    window.addEventListener("pointerdown", outside, true)
    window.addEventListener("keydown", composition, true)
    onCleanup(() => {
      window.removeEventListener("pointerdown", outside, true)
      window.removeEventListener("keydown", composition, true)
    })
  })
  onCleanup(() => {
    mounted = false
    version++
  })

  const style = (): JSX.CSSProperties => ({
    "--model-viewport-height": `${store.viewportHeight}px`,
    "--model-viewport-width": `${store.viewportWidth}px`,
    "--model-viewport-top": `${store.viewportTop}px`,
    "--model-viewport-left": `${store.viewportLeft}px`,
  })
  const unavailable = () => binding()?.unavailable()
  const body = () => (
    <>
      <div class="arforge-model-picker__search">
        <Icon name="magnifying-glass" size="small" />
        <input
          ref={searchRef}
          type="search"
          value={store.groups.query}
          aria-label={language.t("dialog.model.search.placeholder")}
          aria-controls={`${id}-models`}
          placeholder={language.t("dialog.model.search.placeholder")}
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          onInput={(event) => setSearch(event.currentTarget.value)}
          onCompositionStart={() => setStore("composing", true)}
          onCompositionEnd={() => setStore("composing", false)}
        />
        <Show when={store.groups.query}>
          <button
            type="button"
            class="arforge-model-picker__clear"
            aria-label={language.t("common.clear")}
            onClick={() => {
              setSearch("")
              searchRef?.focus()
            }}
          >
            <Icon name="close" size="small" />
          </button>
        </Show>
      </div>
      <Show when={unavailable()}>
        {(reason) => (
          <div class="arforge-model-picker__notice" role="status">
            <div>{copy()[reason()]}</div>
            <div class="arforge-model-picker__id">
              {currentChoice()?.providerID} / {currentChoice()?.modelID}
            </div>
          </div>
        )}
      </Show>
      <Show when={store.error || store.catalogError}>
        <div
          class="arforge-model-picker__notice"
          role="alert"
          data-model-catalog-failure={store.catalogError ? store.catalogFailure : undefined}
        >
          <div>
            {store.error ||
              copy()[store.catalogFailure === "unavailable" ? "catalogUnavailable" : store.catalogFailure]}
          </div>
          <Show when={store.catalogError && allModels().length > 0}>
            <div class="arforge-model-picker__id">{copy().stale}</div>
          </Show>
        </div>
      </Show>
      <Show when={!store.hydrated || !model().ready() || (binding() && !binding()!.ready()) || store.catalogLoading}>
        <div class="arforge-model-picker__notice" role="status">
          {language.t("common.loading")}
        </div>
      </Show>
      <div class="arforge-model-picker__columns">
        <nav class="arforge-model-picker__providers" aria-label={copy().connections}>
          <div class="arforge-model-picker__eyebrow">{copy().connections}</div>
          <For each={connections()}>
            {(provider) => (
              <button
                type="button"
                class="arforge-model-picker__provider"
                data-provider-id={provider.id}
                data-browsing={browsing() === provider.id ? true : undefined}
                aria-pressed={browsing() === provider.id}
                aria-current={currentChoice()?.providerID === provider.id ? "true" : undefined}
                aria-controls={`${id}-models`}
                tabIndex={browsing() === provider.id ? 0 : -1}
                disabled={store.selecting}
                onClick={() => browse(provider.id)}
              >
                <span class="arforge-model-picker__connection-mark" aria-hidden="true">
                  {provider.name.slice(0, 1)}
                </span>
                <span>{provider.name}</span>
                <Show when={currentChoice()?.providerID === provider.id}>
                  <Icon name="check" size="small" />
                </Show>
              </button>
            )}
          </For>
        </nav>
        <div class="arforge-model-picker__model-column">
          <div class="arforge-model-picker__eyebrow">{copy().models}</div>
          <div
            id={`${id}-models`}
            class="arforge-model-picker__scroll"
            data-slot="model-selector-scroll"
            aria-busy={store.selecting || store.refreshing}
          >
            <Show
              when={displayedGroups().length}
              fallback={
                <div class="arforge-model-picker__empty" role="status">
                  {normalizeModelSearch(store.groups.query) ? language.t("dialog.model.empty") : copy().empty}
                </div>
              }
            >
              <For each={displayedGroups()}>
                {(group) => (
                  <section aria-label={group.name}>
                    <button
                      type="button"
                      class="arforge-model-picker__group"
                      aria-expanded={modelGroupOpen(store.groups, group.id)}
                      aria-controls={`${id}-${encodeURIComponent(group.id)}`}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                        style={{ transform: modelGroupOpen(store.groups, group.id) ? "rotate(90deg)" : undefined }}
                      >
                        <path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
                      </svg>
                      <span>{group.name}</span>
                    </button>
                    <div id={`${id}-${encodeURIComponent(group.id)}`} hidden={!modelGroupOpen(store.groups, group.id)}>
                      <Show when={modelGroupOpen(store.groups, group.id)}>
                        <For each={group.items}>
                          {(item) => (
                            <TooltipV2
                              class="w-full"
                              placement="right-start"
                              gutter={6}
                              openDelay={400}
                              value={
                                <ModelTooltip
                                  model={item}
                                  latest={item.latest}
                                  free={item.provider.id === "arforge" && (!item.cost || item.cost.input === 0)}
                                  v2
                                />
                              }
                            >
                              <button
                                type="button"
                                class="arforge-model-picker__row"
                                data-option-key={modelOptionKey(item)}
                                data-selected-model={selected(item) ? true : undefined}
                                data-active={store.active === modelOptionKey(item) ? true : undefined}
                                aria-pressed={selected(item)}
                                aria-label={`${item.name}, ${item.id}, ${item.provider.name}`}
                                tabIndex={store.active === modelOptionKey(item) ? 0 : -1}
                                disabled={
                                  store.selecting ||
                                  !store.hydrated ||
                                  !model().ready() ||
                                  !!(binding() && !binding()!.ready())
                                }
                                onFocus={() => setStore("active", modelOptionKey(item))}
                                onClick={() => void select(item)}
                              >
                                <span class="arforge-model-picker__labels">
                                  <span class="arforge-model-picker__name">{item.name}</span>
                                  <Show when={item.name !== item.id}>
                                    <span class="arforge-model-picker__id">{item.id}</span>
                                  </Show>
                                  <span class="arforge-model-picker__tags">
                                    <For each={chooserCapabilityBadges(item)}>
                                      {(badge) => <Tag>{copy()[badge]}</Tag>}
                                    </For>
                                  </span>
                                  <Show
                                    when={
                                      item.latest ||
                                      (item.provider.id === "arforge" && (!item.cost || item.cost.input === 0))
                                    }
                                  >
                                    <span class="arforge-model-picker__tags">
                                      <Show
                                        when={item.provider.id === "arforge" && (!item.cost || item.cost.input === 0)}
                                      >
                                        <Tag>{language.t("model.tag.free")}</Tag>
                                      </Show>
                                      <Show when={item.latest}>
                                        <Tag>{language.t("model.tag.latest")}</Tag>
                                      </Show>
                                    </span>
                                  </Show>
                                </span>
                                <Show when={selected(item)}>
                                  <Icon name="check" size="small" />
                                </Show>
                              </button>
                            </TooltipV2>
                          )}
                        </For>
                      </Show>
                    </div>
                  </section>
                )}
              </For>
            </Show>
          </div>
          <div class="arforge-model-picker__strength" data-slot="model-strength" aria-busy={store.selecting}>
            <div class="arforge-model-picker__strength-heading">
              <label for={`${id}-strength`} title={`${copy().strengthFor}: ${model().current()?.name ?? ""}`}>
                {copy().strength}
              </label>
              <output for={`${id}-strength`} class="arforge-model-picker__strength-value">
                {variantGroups().reasoning.length ? strengthValue() : copy().strengthUnavailable}
              </output>
              <Show when={strengthShortcut().length > 0}>
                <KeybindV2
                  keys={strengthShortcut()}
                  variant="neutral"
                  class="arforge-model-picker__strength-shortcut"
                  role="img"
                  aria-label={`${language.t("command.model.variant.cycle")}: ${command.keybind("model.variant.cycle")}`}
                  title={language.t("command.model.variant.cycle")}
                />
              </Show>
            </div>
            <Show when={browsing() && browsing() !== model().current()?.provider.id}>
              <div
                id={`${id}-strength-target`}
                class="arforge-model-picker__strength-target"
                data-slot="model-strength-target"
              >
                {copy().strengthFor}：{model().current()?.name}
              </div>
            </Show>
            <div
              class="arforge-model-picker__strength-options"
              data-slot="model-strength-options"
              data-disabled={strengthDisabled() ? true : undefined}
              data-strength-state={strengthState()}
              data-mode-selected={strengthSelection() < 0 ? true : undefined}
            >
              <input
                ref={strengthInputRef}
                id={`${id}-strength`}
                class="sr-only arforge-model-picker__strength-input"
                type="range"
                min={0}
                max={Math.max(0, strengthOptions().length - 1)}
                step={1}
                value={strengthIndex()}
                disabled={strengthDisabled()}
                aria-label={copy().strength}
                aria-valuetext={variantGroups().reasoning.length ? strengthValue() : copy().strengthUnavailable}
                aria-describedby={
                  [
                    strengthReason() ? `${id}-strength-reason` : "",
                    browsing() && browsing() !== model().current()?.provider.id ? `${id}-strength-target` : "",
                  ]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                onPointerDown={(event) => {
                  if (event.button === 0) previewRangeStrength(event.currentTarget.valueAsNumber)
                }}
                onPointerUp={(event) => changeRangeStrength(event.currentTarget)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
                  if (rangeCapture?.input === "dial") restoreStrengthInput(event.currentTarget)
                  previewRangeStrength(event.currentTarget.valueAsNumber)
                }}
                onKeyUp={(event) => {
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
                    changeRangeStrength(event.currentTarget)
                }}
                onInput={(event) => {
                  previewRangeStrength(event.currentTarget.valueAsNumber)
                  event.currentTarget.valueAsNumber = strengthIndex()
                }}
                onChange={(event) => changeRangeStrength(event.currentTarget)}
                onPointerCancel={(event) => {
                  if (rangeCapture?.input === "range") restoreStrengthInput(event.currentTarget)
                }}
                onBlur={(event) => restoreStrengthInput(event.currentTarget)}
              />
              <Show when={store.open && strengthOptions().length >= 2}>
                <ModelStrengthDial
                  stops={strengthStops()}
                  selection={strengthSelection()}
                  hasOff={!!strength().off}
                  disabled={strengthDisabled()}
                  paused={store.strengthMotionPaused}
                  reducedMotion={store.strengthMotionReduced}
                  begin={beginDialStrength}
                />
                <button
                  type="button"
                  class="arforge-model-picker__strength-motion"
                  data-slot="model-strength-motion"
                  aria-disabled={store.strengthMotionReduced ? true : undefined}
                  onClick={() => {
                    if (!store.strengthMotionReduced) setStore("strengthMotionPaused", (paused) => !paused)
                  }}
                >
                  {store.strengthMotionReduced
                    ? copy().strengthMotionReduced
                    : store.strengthMotionPaused
                      ? copy().strengthMotionResume
                      : copy().strengthMotionPause}
                </button>
              </Show>
            </div>
            <Show when={strengthReason()}>
              {(reason) => (
                <div id={`${id}-strength-reason`} class="arforge-model-picker__strength-reason" role="status">
                  {reason()}
                </div>
              )}
            </Show>
            <Show when={model().current() && variantGroups().reasoning.length > 0}>
              <div class="arforge-model-picker__strength-modes" role="group" aria-label={copy().strengthModes}>
                <For each={strengthModes()}>
                  {(option) => (
                    <button
                      type="button"
                      class="arforge-model-picker__strength-mode"
                      data-variant-key={option.key}
                      aria-pressed={option.value === model().variant.current()}
                      disabled={variantDisabled()}
                      onClick={() => {
                        clearStrengthPreview()
                        void selectVariant(option)
                      }}
                    >
                      {variantLabel(option)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={variantGroups().other.length > 0}>
              <label class="arforge-model-picker__preset">
                <span>{copy().otherPresets}</span>
                <select
                  aria-label={copy().otherPresets}
                  disabled={variantDisabled()}
                  value={
                    variantGroups().other.find((option) => option.value === model().variant.current())?.key ??
                    (model().variant.current() === undefined ? "reset" : "current-reasoning")
                  }
                  onChange={(event) => {
                    const option = [variantGroups().reset, ...variantGroups().other].find(
                      (item) => item.key === event.currentTarget.value,
                    )
                    if (option) void selectVariant(option)
                  }}
                >
                  <option value="current-reasoning" disabled>
                    {copy().choosePreset}
                  </option>
                  <option value="reset">{copy().defaultStrength}</option>
                  <For each={variantGroups().other}>
                    {(option) => <option value={option.key}>{option.value}</option>}
                  </For>
                </select>
              </label>
            </Show>
          </div>
        </div>
      </div>
      <div class="arforge-model-picker__footer">
        <Show when={unavailable() || store.error || store.catalogError}>
          <button
            type="button"
            class="arforge-model-picker__action"
            disabled={store.refreshing || store.selecting}
            onClick={() => void refresh()}
          >
            {store.refreshing ? language.t("common.loading") : copy().retry}
          </button>
        </Show>
        <button type="button" class="arforge-model-picker__action" disabled={store.selecting} onClick={manage}>
          <Icon name="outline-sliders" size="small" />
          {language.t("dialog.model.manage")}
        </button>
        <button type="button" class="arforge-model-picker__action" disabled={store.selecting} onClick={connect}>
          {language.t("command.provider.connect")}
        </button>
        <Show when={store.touch}>
          <button type="button" class="arforge-model-picker__action" onClick={() => close("escape")}>
            {language.t("common.close")}
          </button>
        </Show>
      </div>
    </>
  )
  return (
    <Popover open={store.open} modal={false} placement="top-start" gutter={6} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={(element) => (triggerRef = element)}
        as={props.triggerAs ?? "button"}
        {...props.triggerProps}
      >
        {props.children}
      </Popover.Trigger>
      <Show
        when={store.open && store.touch}
        fallback={
          <Show when={!store.touch}>
            <Popover.Portal>
              <Popover.Content
                ref={(element) => (contentRef = element)}
                class="arforge-model-picker"
                data-compact-height={store.viewportHeight > 0 && store.viewportHeight < 420 ? true : undefined}
                style={style()}
                onKeyDown={keydown}
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => event.preventDefault()}
                onEscapeKeyDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!modelPickerComposing(event, store.composing)) close("escape")
                }}
                onPointerDownOutside={(event) => event.preventDefault()}
                onFocusOutside={(event) => event.preventDefault()}
              >
                <Popover.Title class="sr-only">{language.t("dialog.model.select.title")}</Popover.Title>
                {body()}
              </Popover.Content>
            </Popover.Portal>
          </Show>
        }
      >
        <Portal>
          <div
            ref={(element) => (contentRef = element)}
            class="arforge-model-picker"
            data-compact-height={store.viewportHeight > 0 && store.viewportHeight < 420 ? true : undefined}
            data-touch="true"
            role="dialog"
            aria-label={language.t("dialog.model.select.title")}
            tabIndex={-1}
            style={style()}
            onKeyDown={keydown}
          >
            {body()}
          </div>
        </Portal>
      </Show>
    </Popover>
  )
}
