import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { Dialog } from "@arforge-ai/ui/dialog"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { Switch } from "@arforge-ai/ui/v2/switch-v2"
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK, useServerProtocol } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { ProviderModelEditor } from "../provider-model-editor"
import { useConfirmAction } from "../confirm-action"
import { refreshProviderConfiguration, providerCredentialRetry } from "../provider-configuration"
import { formModelMetadata } from "../custom-provider-model-autofill"
import { loadModelPresetCatalog } from "@/utils/model-presets-query"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { pathKey } from "@/utils/path-key"
import { useProviders } from "@/hooks/use-providers"
import { retryBootstrapRead } from "@/context/global-sync/bootstrap-read"
import { providerWorkspaceCopy, providerTestCategoryCopy } from "./provider-workspace-copy"
import { modelPresetSettingsCopy } from "../custom-provider-model-copy"
import {
  createSavedModelTest,
  createWorkspaceSave,
  WorkspaceCredentialPending,
  workspacePatch,
  type WorkspaceApi,
  type WorkspaceDetail,
  type WorkspaceTestResult,
} from "./provider-workspace-operations"

const narrowWorkspaceWidth = 720

export function ProviderWorkspace() {
  const sdk = useServerSDK(),
    sync = useServerSync(),
    protocol = useServerProtocol(),
    language = useLanguage(),
    dialog = useDialog()
  const providers = useProviders()
  const source = createMemo(() => ({
    sdk: sdk(),
    sync: sync(),
    directory: sync().data.path.directory,
    kind: protocol(),
  }))
  return (
    <Show when={source().kind === "v2" && source()} keyed>
      {(owner) => (
        <ProviderWorkspaceSource
          api={owner.sdk.operationsApi.providers}
          scope={owner.sdk.scope}
          directory={owner.directory}
          sync={owner.sync}
          loadPresets={(current) =>
            loadModelPresetCatalog({
              scope: owner.sdk.scope,
              directory: owner.directory,
              queryClient: owner.sync.queryClient,
              models: owner.sdk.operationsApi.models,
              isCurrent: current,
            })
          }
          isCurrent={() =>
            sdk.isAlive() &&
            sdk() === owner.sdk &&
            sync() === owner.sync &&
            sync().data.path.directory === owner.directory
          }
          names={Object.fromEntries(providers.connected().map((provider) => [provider.id, provider.name]))}
          locale={language.locale()}
          onCreate={(onCreated) =>
            dialog.show(() => <DialogCustomProvider onBack={dialog.close} onCreated={onCreated} />)
          }
        />
      )}
    </Show>
  )
}

export function ProviderWorkspaceSource(props: {
  api: WorkspaceApi
  scope: string
  directory: string
  sync: Parameters<typeof refreshProviderConfiguration>[0]
  isCurrent: () => boolean
  locale: string
  names?: Record<string, string>
  onCreate: (onCreated: (providerID: string) => void) => void
  loadPresets: (current: () => boolean) => ReturnType<typeof loadModelPresetCatalog>
}) {
  let active = true,
    readController: AbortController | undefined,
    accessController: AbortController | undefined,
    accessGeneration = 0,
    workspaceElement: HTMLElement | undefined,
    listElement: HTMLElement | undefined,
    lastProviderButton: HTMLButtonElement | undefined,
    resizeObserver: ResizeObserver | undefined
  const [narrow, setNarrow] = createSignal(false)
  const [showDetail, setShowDetail] = createSignal(false)
  const copy = () => providerWorkspaceCopy(props.locale)
  const readCopy = () => {
    const locale = props.locale.toLowerCase()
    if (["zht", "zh-tw", "zh-hant", "zh-hk"].includes(locale))
      return {
        empty: "尚未設定服務商，請選擇「新增服務商」開始設定。",
        failed: "無法讀取服務商設定，請重試目前來源。",
        retry: "重試讀取設定",
      }
    if (["zh", "zh-cn", "zh-hans", "zhhans"].includes(locale))
      return {
        empty: "尚未配置服务商，请选择「添加服务商」开始配置。",
        failed: "无法读取服务商配置，请重试当前来源。",
        retry: "重试读取配置",
      }
    return {
      empty: "No configured providers. Choose Add provider to get started.",
      failed: "Could not read provider configuration. Retry the current source.",
      retry: "Retry configuration read",
    }
  }
  const [readErrors, setReadErrors] = createStore({ access: false, detail: false })
  const [selection, setSelection] = createStore({ id: "", readEpoch: 0, names: {} as Record<string, string> })
  const current = () => active && props.isCurrent()
  onCleanup(() => {
    active = false
    readController?.abort()
    accessController?.abort()
    resizeObserver?.disconnect()
  })
  const applyWorkspaceWidth = (width: number) => {
    if (!active || width <= 0) return
    const next = width < narrowWorkspaceWidth
    if (next === narrow()) return
    // Entering the compact layout always starts from the connection list.
    if (next) setShowDetail(false)
    setNarrow(next)
  }
  onMount(() => {
    if (!workspaceElement) return
    applyWorkspaceWidth(workspaceElement.getBoundingClientRect().width)
    if (typeof ResizeObserver === "undefined") {
      const apply = () => {
        if (workspaceElement) applyWorkspaceWidth(workspaceElement.getBoundingClientRect().width)
      }
      window.addEventListener("resize", apply)
      onCleanup(() => window.removeEventListener("resize", apply))
      return
    }
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) applyWorkspaceWidth(entry.contentRect.width)
    })
    resizeObserver.observe(workspaceElement)
  })
  const [access, { refetch: refreshAccess }] = createResource(async () => {
    accessController?.abort()
    const abort = new AbortController(),
      generation = ++accessGeneration
    accessController = abort
    const owned = () => current() && !abort.signal.aborted && generation === accessGeneration
    if (!owned()) return undefined
    setReadErrors("access", false)
    try {
      const response = await retryBootstrapRead(
        () => props.api.capability({ location: { directory: props.directory } }, { signal: abort.signal }),
        owned,
      )
      if (!owned()) return undefined
      if (pathKey(response.location.directory) !== pathKey(props.directory)) throw Error("source mismatch")
      return response.data
    } catch {
      if (owned()) setReadErrors("access", true)
      return undefined
    }
  })
  const selected = createMemo(
    () => access()?.providers.find((item) => item.id === selection.id)?.id ?? access()?.providers[0]?.id,
  )
  const focusNarrowDetail = () => {
    queueMicrotask(() => {
      if (!active || !narrow() || !showDetail()) return
      workspaceElement
        ?.querySelector<HTMLButtonElement>(".arforge-provider-workspace-detail-bar button")
        ?.focus({ preventScroll: true })
    })
  }
  const selectProvider = (providerID: string, origin?: HTMLButtonElement) => {
    lastProviderButton = origin
    if (selected() === providerID) {
      // A completed read keeps the draft; an in-flight or failed read restarts and replaces it.
      if (readErrors.detail || detail.loading) setSelection("readEpoch", selection.readEpoch + 1)
    } else {
      setSelection({ id: providerID, readEpoch: selection.readEpoch + 1 })
    }
    if (!narrow()) return
    setShowDetail(true)
    focusNarrowDetail()
  }
  const backToProviders = () => {
    setShowDetail(false)
    queueMicrotask(() => {
      if (!active || !narrow() || showDetail()) return
      const selectedID = selected()
      const buttons = Array.from(
        listElement?.querySelectorAll<HTMLButtonElement>("[data-provider-config-id]") ?? [],
      )
      const target =
        buttons.find((button) => button.dataset.providerConfigId === selectedID) ??
        (lastProviderButton?.isConnected ? lastProviderButton : undefined)
      if (target) target.focus({ preventScroll: true })
      else listElement?.focus({ preventScroll: true })
    })
  }
  const guard = createScopeRequestGuard(() =>
    JSON.stringify([props.scope, props.directory, selected(), selection.readEpoch]),
  )
  const [detail, { refetch: refreshDetail }] = createResource(
    () => ({ id: selected(), token: guard.invalidate() }),
    async ({ id, token }) => {
      readController?.abort()
      const abort = new AbortController()
      readController = abort
      if (!current()) return undefined
      const owned = () => current() && !abort.signal.aborted && guard.isCurrent(token)
      if (!owned()) return undefined
      setReadErrors("detail", false)
      if (!id) return undefined
      try {
        const response = await retryBootstrapRead(
          () =>
            props.api.configurationGet(
              { providerID: id, location: { directory: props.directory } },
              { signal: abort.signal },
            ),
          owned,
        )
        if (!owned()) return undefined
        if (pathKey(response.location.directory) !== pathKey(props.directory)) throw Error("source mismatch")
        if (response.data.providerID !== id) throw Error("provider mismatch")
        setSelection("names", id, response.data.name)
        return response.data
      } catch {
        if (owned()) setReadErrors("detail", true)
        return undefined
      }
    },
  )
  const [presets, { refetch: refreshPresets }] = createResource(async () => {
    try {
      return { catalog: await props.loadPresets(current), unavailable: false }
    } catch {
      return { catalog: undefined, unavailable: true }
    }
  })
  const refresh = async () => {
    if (!current()) return
    await refreshProviderConfiguration(props.sync, props.scope)
    if (!current()) return
    await refreshAccess()
    if (current()) await refreshDetail()
  }
  const retryRead = async () => {
    if (!current()) return
    await refreshAccess()
    if (current()) await refreshDetail()
  }
  const created = async (providerID: string) => {
    if (!current()) return
    const previous = selected()
    // Keep this source's intended selection even when the capability read needs a retry.
    setSelection("id", providerID)
    await refreshAccess()
    if (!current() || !access()?.providers.some((provider) => provider.id === providerID)) return
    if (narrow() && selected() === providerID) {
      setShowDetail(true)
      focusNarrowDetail()
    }
    // A changed selection starts its own detail read; do not duplicate it or hide its failure.
    if (previous === providerID) await refreshDetail()
  }
  const readState = createMemo(() => {
    if (!current()) return "retired"
    if (access.loading) return "loading"
    if (readErrors.access) return "failed"
    if (detail.loading) return "loading"
    if (readErrors.detail) return "failed"
    if (selected() && detail()?.providerID === selected()) return "ready"
    if (access()?.canWrite === false) return "readonly"
    if (access()?.canWrite === true && !selected()) return "empty"
    return "loading"
  })
  const listState = createMemo(() => {
    if (!current()) return "retired"
    if (access.loading) return "loading"
    if (readErrors.access) return "failed"
    if (!access()?.providers.length) return access()?.canWrite === false ? "readonly" : "empty"
    return "ready"
  })
  createEffect(() => {
    if (narrow() && showDetail() && access()?.providers.length === 0) setShowDetail(false)
  })
  return (
    <section
      ref={workspaceElement}
      class="arforge-provider-workspace"
      data-provider-workspace
      data-provider-narrow={narrow() ? "true" : "false"}
      data-provider-view={narrow() ? (showDetail() ? "detail" : "list") : "wide"}
    >
      <header class="arforge-provider-workspace-header">
        <h3>{copy().title}</h3>
        <div class="arforge-provider-workspace-header-actions">
          <Button
            type="button"
            onClick={() => {
              if (current()) {
                void refresh()
                void refreshPresets()
              }
            }}
          >
            {copy().refresh}
          </Button>
          <Button
            type="button"
            disabled={!access()?.canWrite}
            onClick={() => {
              if (current()) props.onCreate((providerID) => void created(providerID))
            }}
          >
            {copy().addProvider}
          </Button>
        </div>
      </header>
      <Show when={presets()?.unavailable}>
        <p role="status" data-model-metadata-state="unavailable">
          {modelPresetSettingsCopy(props.locale).unavailable}
        </p>
        <Button
          type="button"
          onClick={() => {
            if (current()) void refreshPresets()
          }}
        >
          {modelPresetSettingsCopy(props.locale).retry}
        </Button>
      </Show>
      <div class="arforge-provider-workspace-columns">
        <nav
          ref={listElement}
          class="arforge-provider-workspace-list"
          aria-label={copy().title}
          aria-busy={listState() === "loading"}
          tabIndex={-1}
        >
          <Show when={narrow() && listState() !== "ready" && listState() !== "retired"}>
            <div class="arforge-provider-workspace-list-status">
              <p role="status">
                {listState() === "loading"
                  ? copy().loading
                  : listState() === "failed"
                    ? readCopy().failed
                    : listState() === "readonly"
                      ? copy().readOnly
                      : readCopy().empty}
              </p>
              <Show when={listState() === "failed"}>
                <Button
                  type="button"
                  onClick={() => {
                    void retryRead()
                  }}
                >
                  {readCopy().retry}
                </Button>
              </Show>
            </div>
          </Show>
          <For each={access()?.providers}>
            {(provider) => {
              const name = () => props.names?.[provider.id] ?? selection.names[provider.id] ?? provider.id
              return (
                <button
                  type="button"
                  class="arforge-provider-workspace-list-item"
                  data-provider-config-id={provider.id}
                  data-provider-state={provider.disabled ? "disabled" : "enabled"}
                  aria-current={selected() === provider.id ? "page" : undefined}
                  onClick={(event) => selectProvider(provider.id, event.currentTarget)}
                >
                  <span class="arforge-provider-workspace-list-copy">
                    <strong>{name()}</strong>
                    <Show when={Boolean(name()) && name() !== provider.id}>
                      <code>{provider.id}</code>
                    </Show>
                  </span>
                  <small class="arforge-provider-workspace-status">
                    <span class="arforge-provider-workspace-status-dot" aria-hidden="true" />
                    {provider.disabled ? copy().disabled : copy().enabled}
                  </small>
                </button>
              )
            }}
          </For>
        </nav>
        <div class="arforge-provider-workspace-detail" aria-busy={readState() === "loading"}>
          <Show when={narrow()}>
            <div class="arforge-provider-workspace-detail-bar">
              <Button type="button" onClick={backToProviders}>
                {copy().backToProviders}
              </Button>
            </div>
          </Show>
          <Show
            when={readState() === "ready" ? detail() : undefined}
            keyed
            fallback={
              <Show when={readState() !== "retired"}>
                <p role="status">
                  {readState() === "loading"
                    ? copy().loading
                    : readState() === "failed"
                      ? readCopy().failed
                      : readState() === "empty"
                        ? readCopy().empty
                        : copy().readOnly}
                </p>
                <Show when={readState() === "failed"}>
                  <Button
                    type="button"
                    onClick={() => {
                      void retryRead()
                    }}
                  >
                    {readCopy().retry}
                  </Button>
                </Show>
              </Show>
            }
          >
            {(saved) => (
              <ProviderWorkspaceEditor
                detail={saved}
                api={props.api}
                directory={props.directory}
                scope={props.scope}
                locale={props.locale}
                metadata={presets()?.catalog ? formModelMetadata(presets()!.catalog!) : undefined}
                isCurrent={() => current() && selected() === saved.providerID && detail()?.revision === saved.revision}
                canWrite={access()?.canWrite === true}
                onRefresh={refresh}
              />
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}

function ProviderWorkspaceEditor(props: {
  detail: WorkspaceDetail
  api: WorkspaceApi
  directory: string
  scope: string
  locale: string
  metadata?: ReturnType<typeof formModelMetadata>
  isCurrent: () => boolean
  canWrite: boolean
  onRefresh: () => Promise<void>
}) {
  const saved = props.detail,
    copy = () => providerWorkspaceCopy(props.locale),
    confirm = useConfirmAction()
  const dialog = useDialog()
  let editorHandle: ReturnType<typeof dialog.pushScoped> | undefined
  const [state, setState] = createStore({
    name: saved.name,
    baseURL: saved.baseURL ?? "",
    format: saved.apiFormat,
    key: "",
    busy: false,
    error: "",
    notice: "",
    editing: undefined as { id?: string } | undefined,
    tests: {} as Record<string, { status: string; result?: WorkspaceTestResult }>,
  })
  let active = true
  const owner = () => JSON.stringify([props.scope, props.directory, saved.providerID, saved.revision])
  const current = () => active && props.isCurrent()
  const saveConfiguration = createWorkspaceSave(props.api, current)
  const writable = () =>
    props.canWrite &&
    saved.canWrite &&
    (saved.apiFormat === "openai-chat" ||
      saved.apiFormat === "openai-responses" ||
      saved.apiFormat === "anthropic-messages")
  const dirty = () =>
    state.name !== saved.name ||
    state.baseURL !== (saved.baseURL ?? "") ||
    state.format !== saved.apiFormat ||
    state.key !== ""
  const tests = createSavedModelTest({
    owner,
    isCurrent: current,
    run: (modelID, signal) =>
      props.api
        .configurationTest(
          { providerID: saved.providerID, revision: saved.revision, modelID, location: { directory: props.directory } },
          { signal },
        )
        .then((response) => {
          if (
            pathKey(response.location.directory) !== pathKey(props.directory) ||
            response.data.providerID !== saved.providerID ||
            response.data.modelID !== modelID ||
            response.data.revision !== saved.revision
          )
            throw Error("stale result")
          return response.data
        }),
    publish: (id, result) => setState("tests", id, result),
  })
  onCleanup(() => {
    active = false
    tests.cancel()
    editorHandle?.discard()
  })
  createEffect(
    on(
      () => JSON.stringify([state.name, state.baseURL, state.format, state.key, state.editing]),
      () => tests.cancel(),
      { defer: true },
    ),
  )
  const mutate = async (changes: Parameters<typeof workspacePatch>[1], key?: string) => {
    if (!current() || !writable() || state.busy) return
    tests.cancel()
    setState({ busy: true, error: "", notice: "" })
    try {
      await saveConfiguration({ ...workspacePatch(saved, changes), location: { directory: props.directory } }, key)
      if (current()) await props.onRefresh()
    } catch (error) {
      if (current())
        setState("error", error instanceof WorkspaceCredentialPending ? providerCredentialRetry : copy().failed)
      throw new Error("Configuration operation failed")
    } finally {
      if (active) setState("busy", false)
    }
  }
  const action = (changes: Parameters<typeof workspacePatch>[1]) => {
    void mutate(changes).catch(() => {})
  }
  const edit = (id?: string) => {
    if (!current() || !writable() || state.busy || dirty() || state.editing) return
    tests.cancel()
    setState("editing", { id })
    const existing = id !== undefined ? saved.models.find((model) => model.id === id) : undefined
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const openedOwner = owner()
    editorHandle = dialog.pushScoped(
      () => (
        <Dialog class="arforge-model-editor-dialog" size="large" title={existing ? copy().edit : copy().addModel}>
          <ProviderModelEditor
            initial={existing ? modelInput(existing) : undefined}
            variantIDs={existing?.variants}
            metadata={props.metadata}
            locale={props.locale}
            identity={owner}
            isCurrent={current}
            onCancel={() => editorHandle?.close()}
            onSave={async (model) => {
              await mutate({ models: [model] })
            }}
          />
        </Dialog>
      ),
      () => {
        editorHandle = undefined
        if (active) setState("editing", undefined)
        queueMicrotask(() => {
          if (current() && owner() === openedOwner && !editorHandle && origin?.isConnected)
            origin.focus({ preventScroll: true })
        })
      },
    )
  }
  const modelInput = (model: WorkspaceDetail["models"][number]) => ({
    id: model.id,
    name: model.name,
    ...(model.limit ? { limit: model.limit } : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    ...(model.preset ? { preset: model.preset } : {}),
    ...(typeof model.defaultVariant === "string" ? { defaultVariant: model.defaultVariant } : {}),
  })
  const remove = async (model: WorkspaceDetail["models"][number]) => {
    if (!current() || !writable() || state.busy) return
    const identity = owner()
    if (
      await confirm(`${copy().delete}: ${saved.name} (${saved.providerID}) / ${model.name} (${model.id})`, {
        danger: true,
        isCurrent: () => current() && owner() === identity && !state.busy,
      })
    ) {
      if (current() && owner() === identity) action({ deletedModelIDs: [model.id] })
    }
  }
  return (
    <div class="arforge-provider-editor" data-provider-editor={saved.providerID}>
      <header>
        <h3>{saved.name}</h3>
        <Button
          type="button"
          disabled={!writable() || state.busy || dirty() || !!state.editing}
          onClick={() => action({ disabled: !saved.disabled })}
        >
          {saved.disabled ? copy().enable : copy().disable}
        </Button>
      </header>
      <Show when={!writable()}>
        <p role="status">
          {copy().readOnly} {saved.adapter.type} {saved.adapter.package}
        </p>
      </Show>
      <form
        class="arforge-provider-connection-editor"
        onSubmit={(event) => {
          event.preventDefault()
          void mutate(
            {
              name: state.name,
              ...(state.baseURL !== (saved.baseURL ?? "") ? { baseURL: state.baseURL } : {}),
              ...(state.format && state.format !== saved.apiFormat ? { apiFormat: state.format } : {}),
            },
            state.key,
          ).catch(() => {})
        }}
      >
        <TextField
          label={copy().name}
          value={state.name}
          readOnly={!writable()}
          required
          onChange={(value) => setState("name", value)}
        />
        <TextField
          label={copy().baseURL}
          description={typeof saved.baseURL !== "string" ? copy().endpointHidden : undefined}
          value={state.baseURL}
          readOnly={!writable()}
          required={typeof saved.baseURL === "string"}
          onChange={(value) => setState("baseURL", value)}
        />
        <label>
          {copy().format}
          <select
            aria-label={copy().format}
            disabled={!writable()}
            value={state.format ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "openai-chat" || value === "openai-responses" || value === "anthropic-messages")
                setState("format", value)
            }}
          >
            <Show when={!saved.apiFormat}>
              <option value="">
                {saved.adapter.type} {saved.adapter.package}
              </option>
            </Show>
            <option value="openai-chat">Chat Completions (/chat/completions)</option>
            <option value="openai-responses">OpenAI Responses (/responses)</option>
            <option value="anthropic-messages">Anthropic Messages (/messages)</option>
          </select>
        </label>
        <TextField
          type="password"
          label={copy().key}
          value={state.key}
          placeholder={saved.credential.configured ? "••••••••" : ""}
          description={saved.credential.configured ? copy().stored : copy().noKey}
          readOnly={!writable()}
          autocomplete="new-password"
          onChange={(value) => setState("key", value)}
        />
        <Show
          when={
            saved.credential.reconnectRequired ||
            (saved.credential.configured &&
              (state.baseURL !== (saved.baseURL ?? "") || state.format !== saved.apiFormat))
          }
        >
          <p role="status">{copy().reconnect}</p>
        </Show>
        <Button type="submit" disabled={!writable() || state.busy || !dirty()}>
          {copy().save}
        </Button>
      </form>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <Show when={state.notice}>
        <p role="status">{state.notice}</p>
      </Show>
      <header>
        <h4>{copy().models}</h4>
        <Button type="button" disabled={!writable() || state.busy || dirty() || !!state.editing} onClick={() => edit()}>
          {copy().addModel}
        </Button>
      </header>
      <p class="arforge-provider-model-metadata-hint">{copy().testScope}</p>
      <ul class="arforge-provider-model-list">
        <For each={saved.models}>
          {(model) => (
            <li data-config-model-id={model.id}>
              <div>
                <strong>{model.name}</strong>
                <code>{model.wireID}</code>
                <span class="arforge-provider-model-badge">{model.limit?.context ?? copy().unknown}</span>
                <Show when={model.capabilities?.input.includes("image")}>
                  <span class="arforge-provider-model-badge">{copy().vision}</span>
                </Show>
                <Show when={model.disabled}>
                  <span>{copy().disabled}</span>
                </Show>
                <Show when={model.defaultVariant !== undefined}>
                  <span class="arforge-provider-model-badge">
                    {model.defaultVariant === null ? copy().modelDefault : model.defaultVariant}
                  </span>
                </Show>
              </div>
              <div class="arforge-provider-model-actions">
                <IconButton
                  type="button"
                  icon="link"
                  variant="ghost"
                  aria-label={copy().test}
                  title={copy().test}
                  disabled={
                    !writable() ||
                    state.busy ||
                    saved.disabled ||
                    model.disabled ||
                    !model.canTest ||
                    state.tests[model.id]?.status === "pending"
                  }
                  onClick={() => {
                    if (dirty() || state.editing) {
                      setState("notice", copy().saveFirst)
                      return
                    }
                    void tests.start(model.id)
                  }}
                />
                <Show when={state.tests[model.id]?.status === "pending"}>
                  <Button type="button" onClick={tests.cancel}>
                    {copy().cancelTest}
                  </Button>
                </Show>
                <IconButton
                  type="button"
                  icon="pencil-line"
                  variant="ghost"
                  aria-label={copy().edit}
                  title={copy().edit}
                  disabled={!writable() || state.busy || dirty() || !!state.editing}
                  onClick={() => edit(model.id)}
                />
                <Switch
                  checked={!model.disabled}
                  hideLabel
                  disabled={!writable() || state.busy || dirty() || !!state.editing}
                  onChange={(checked) => action({ models: [{ id: model.id, name: model.name, disabled: !checked }] })}
                >
                  {`${model.disabled ? copy().enable : copy().disable}: ${model.name}`}
                </Switch>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  aria-label={copy().delete}
                  title={copy().delete}
                  disabled={!writable() || state.busy || dirty() || !!state.editing}
                  onClick={() => {
                    void remove(model)
                  }}
                />
              </div>
              <Show when={state.tests[model.id]}>
                {(test) => (
                  <p role="status" data-model-test-status={test().status}>
                    {test().status === "pending"
                      ? copy().pending
                      : test().status === "cancelled"
                        ? copy().cancelled
                        : test().result
                          ? `${test().result!.outcome === "success" ? copy().success : copy().failure} · ${providerTestCategoryCopy(props.locale, test().result!.category)} · ${test().result!.latencyMs} ms`
                          : copy().failure}
                  </p>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
