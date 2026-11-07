import { Button } from "@arforge-ai/ui/button"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { Dialog } from "@arforge-ai/ui/dialog"
import { IconButton } from "@arforge-ai/ui/icon-button"
import { ProviderIcon } from "@arforge-ai/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@arforge-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { batch, createEffect, createMemo, createResource, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import {
  type FormState,
  headerRow,
  legacyCustomProviderConfig,
  modelRow,
  validateCustomProvider,
} from "./dialog-custom-provider-form"
import {
  applyModelResolution,
  createModelMetadataLookup,
  editModelField,
  formModelMetadata,
  resetModelField,
  type FormModelMetadata,
  type ModelLimitKey,
} from "./custom-provider-model-autofill"
import { CustomProviderModelFields } from "./custom-provider-model-fields"
import { modelPresetSettingsCopy, type ModelSetupCopy } from "./custom-provider-model-copy"
import { modelPresetKey } from "@/utils/model-preset-match"
import { loadModelPresetCatalog } from "@/utils/model-presets-query"
import { createScopeRequestGuard } from "@/utils/scope-request"
import {
  createProviderConfigurationSave,
  createProviderConfigurationRefresh,
  providerConfigurationRefreshCopy,
  providerConfigurationReadonly,
  refreshProviderConfiguration,
} from "./provider-configuration"
import "./settings-v2/model-configuration.css"

type Props = {
  onBack: () => void
  onCreated?: (providerID: string) => void
}

export function DialogCustomProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full arforge-provider-config-dialog"
      size="large"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <CustomProviderForm onCreated={props.onCreated} />
    </Dialog>
  )
}

export function CustomProviderForm(
  props: {
    autofocus?: boolean
    modelMetadata?: FormModelMetadata
    modelCopy?: ModelSetupCopy
    onCreated?: (providerID: string) => void
  } = {},
) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const source = createMemo(() => ({ sdk: serverSDK(), sync: serverSync() }))
  return (
    <Show when={source()} keyed>
      {(requested) => (
        <CustomProviderFormContent
          autofocus={props.autofocus}
          source={requested}
          modelMetadata={props.modelMetadata}
          modelCopy={props.modelCopy}
          onCreated={props.onCreated}
          isSourceCurrent={() =>
            serverSDK.isAlive() && serverSDK() === requested.sdk && serverSync() === requested.sync
          }
        />
      )}
    </Show>
  )
}

function CustomProviderFormContent(props: {
  autofocus?: boolean
  source: { sdk: ReturnType<ReturnType<typeof useServerSDK>>; sync: ReturnType<ReturnType<typeof useServerSync>> }
  isSourceCurrent: () => boolean
  modelMetadata?: FormModelMetadata
  modelCopy?: ModelSetupCopy
  onCreated?: (providerID: string) => void
}) {
  const dialog = useDialog()
  const serverSync = () => props.source.sync
  const serverSDK = () => props.source.sdk
  const language = useLanguage()
  let active = true
  const lookups = new Map<string, ReturnType<typeof createModelMetadataLookup>>()
  let advanced: HTMLDetailsElement | undefined
  onCleanup(() => {
    active = false
    for (const lookup of lookups.values()) lookup.dispose()
  })
  const [capability] = createResource(async () => {
    if ((await serverSDK().protocol) === "v1") return { canWrite: true, providers: [] }
    try {
      return (await serverSDK().operationsApi.providers.capability()).data
    } catch {
      return { canWrite: false, providers: [] }
    }
  })
  const presetReads = createScopeRequestGuard(() => serverSync().data.path.directory)
  const [presets, { refetch: retryPresets }] = createResource(
    () =>
      props.modelMetadata
        ? undefined
        : { directory: serverSync().data.path.directory, token: presetReads.invalidate() },
    async ({ directory, token }) => {
      const sdk = serverSDK(),
        sync = serverSync()
      const current = () =>
        active &&
        props.isSourceCurrent() &&
        serverSDK() === sdk &&
        serverSync() === sync &&
        presetReads.isCurrent(token) &&
        sync.data.path.directory === directory
      if ((await sdk.protocol) !== "v2" || !current()) return { status: "unsupported" as const }
      try {
        const catalog = await loadModelPresetCatalog({
          scope: sdk.scope,
          directory,
          models: sdk.operationsApi.models,
          queryClient: sync.queryClient,
          isCurrent: current,
        })
        if (!current()) return undefined
        return catalog ? { status: "ready" as const, catalog, directory } : { status: "unsupported" as const }
      } catch {
        if (current()) return { status: "unavailable" as const }
        return undefined
      }
    },
  )
  const metadata = createMemo(() => {
    if (props.modelMetadata) return props.modelMetadata
    const result = presets()
    return result?.status === "ready" && result.directory === serverSync().data.path.directory
      ? formModelMetadata(result.catalog)
      : undefined
  })
  const [saveState, setSaveState] = createStore({ error: "", committed: false })
  const configurationSave = createProviderConfigurationSave(serverSDK().operationsApi.providers, () => active)
  const refreshCopy = () => providerConfigurationRefreshCopy(language.locale())
  const refreshConfiguration = createProviderConfigurationRefresh({
    refresh: () => refreshProviderConfiguration(serverSync(), serverSDK().scope, { reportErrors: true }),
    isCurrent: props.isSourceCurrent,
    onFailure: (retry) =>
      showToast({
        variant: "error",
        persistent: true,
        title: refreshCopy().failed,
        description: saveState.committed ? refreshCopy().saved : undefined,
        actions: [{ label: refreshCopy().retry, onClick: retry }],
      }),
  })

  const [form, setForm] = createStore<FormState>({
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  })

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const lookupModel = (index: number) => {
    const row = form.models[index]
    if (!row) return
    let lookup = lookups.get(row.row)
    if (!lookup) {
      lookup = createModelMetadataLookup(
        () => {
          const current = form.models.find((model) => model.row === row.row)
          return JSON.stringify([
            props.source.sdk.scope,
            serverSync().data.path.directory,
            form.providerID,
            current?.row,
            current?.id,
            current?.name,
          ])
        },
        () => active && props.isSourceCurrent() && form.models.some((model) => model.row === row.row),
      )
      lookups.set(row.row, lookup)
    }
    lookup.invalidate()
    setForm("models", index, "matchStatus", "pending")
    void lookup.resolve(
      {
        id: row.id,
        name: row.owners?.name?.type === "auto" || row.nameFallback !== undefined ? "" : row.name,
        ...(row.presetSelection ? { selectedOrigin: row.presetSelection } : {}),
      },
      metadata(),
      (result) => {
        const currentIndex = form.models.findIndex((model) => model.row === row.row)
        if (currentIndex >= 0) setForm("models", currentIndex, (current) => applyModelResolution(current, result))
      },
    )
  }

  const selectPreset = (index: number, key: string) => {
    const row = form.models[index]
    if (!row) return
    lookups.get(row.row)?.invalidate()
    const currentMetadata = metadata()
    const preset = currentMetadata?.catalog.items.find((preset) => modelPresetKey(preset) === key)
    if (preset && currentMetadata)
      setForm("models", index, (current) => ({
        ...applyModelResolution(current, { status: "matched", preset, revision: currentMetadata.catalog.revision }),
        presetSelection: preset.origin,
      }))
    else {
      setForm("models", index, "presetSelection", undefined)
      lookupModel(index)
    }
  }

  const setModelLimit = (index: number, field: ModelLimitKey, value: string) => {
    setForm("models", index, (current) => editModelField(current, field, value))
    setForm("models", index, "err", field, undefined)
    lookupModel(index)
  }
  createEffect(on(metadata, () => untrack(() => form.models.forEach((_, index) => lookupModel(index)))))

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    lookups.get(form.models[index].row)?.dispose()
    lookups.delete(form.models[index].row)
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
    if (key === "providerID") form.models.forEach((_, index) => lookupModel(index))
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      if (key === "name") setForm("models", index, (current) => editModelField(current, "name", value))
      else {
        setForm("models", index, key, value)
        setForm("models", index, "presetSelection", undefined)
      }
      setForm("models", index, "err", key, undefined)
    })
    lookupModel(index)
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      limitError: (props.modelCopy ?? modelPresetSettingsCopy(language.locale())).invalidLimit,
      disabledProviders: [
        ...(serverSync().data.config.disabled_providers ?? []),
        ...(capability()
          ?.providers.filter((provider) => provider.disabled)
          .map((provider) => provider.id) ?? []),
      ],
      existingProviderIDs: new Set(
        [...serverSync().data.provider.all.keys()].filter((id) => !configurationSave.acknowledged(id)),
      ),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    if (output.headers.some((error) => error.key || error.value) && advanced) advanced.open = true
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      setSaveState("error", "")
      const kind = await serverSDK().protocol
      if (!active) return result
      if (kind === "v2") {
        try {
          await configurationSave.save(result, () => setSaveState("committed", true))
        } finally {
          if (active) refreshConfiguration()
        }
        return result
      }
      const disabledProviders = serverSync().data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      const legacyConfig = legacyCustomProviderConfig(
        result.config,
        props.modelCopy ?? modelPresetSettingsCopy(language.locale()),
      )

      if (result.key) {
        await serverSDK().client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })
      }

      if (!active) return result
      await serverSync().updateConfig({
        provider: { [result.providerID]: legacyConfig },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: (result) => {
      if (!active || !props.isSourceCurrent()) return
      props.onCreated?.(result.providerID)
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: saveState.committed
          ? `${refreshCopy().saved} ${result.name}`
          : language.t("provider.connect.toast.connected.title", { provider: result.name }),
        description: saveState.committed
          ? refreshCopy().availability
          : language.t("provider.connect.toast.connected.description", { provider: result.name }),
      })
    },
    onError: (err) => {
      if (!active) return
      const message = err instanceof Error ? err.message : String(err)
      setSaveState("error", message)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending || !capability()?.canWrite) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <div class="arforge-provider-config-form">
      <div class="arforge-provider-config-heading">
        <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">{language.t("provider.custom.title")}</div>
      </div>

      <form onSubmit={save} class="arforge-provider-config-fields">
        <p class="text-14-regular text-text-base">
          {language.t("provider.custom.description.prefix")}
          {language.t("provider.custom.description.link")}
          {language.t("provider.custom.description.suffix")}
        </p>

        <div class="arforge-provider-config-connection">
          <TextField
            autofocus={props.autofocus ?? true}
            label={language.t("provider.custom.field.providerID.label")}
            placeholder={language.t("provider.custom.field.providerID.placeholder")}
            description={language.t("provider.custom.field.providerID.description")}
            value={form.providerID}
            onChange={(v) => setField("providerID", v)}
            validationState={form.err.providerID ? "invalid" : undefined}
            error={form.err.providerID}
          />
          <TextField
            label={language.t("provider.custom.field.name.label")}
            placeholder={language.t("provider.custom.field.name.placeholder")}
            value={form.name}
            onChange={(v) => setField("name", v)}
            validationState={form.err.name ? "invalid" : undefined}
            error={form.err.name}
          />
          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(v) => setField("baseURL", v)}
            validationState={form.err.baseURL ? "invalid" : undefined}
            error={form.err.baseURL}
          />
          <TextField
            label={language.t("provider.custom.field.apiKey.label")}
            type="password"
            placeholder={language.t("provider.custom.field.apiKey.placeholder")}
            description={language.t("provider.custom.field.apiKey.description")}
            value={form.apiKey}
            onChange={(v) => setField("apiKey", v)}
          />
        </div>

        <div class="arforge-provider-config-models flex flex-col gap-3">
          <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
          <For each={form.models}>
            {(m, i) => (
              <div class="flex gap-2 items-start" data-row={m.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.id.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.id.placeholder")}
                    value={m.id}
                    onChange={(v) => setModel(i(), "id", v)}
                    validationState={m.err.id ? "invalid" : undefined}
                    error={m.err.id}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.models.name.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.models.name.placeholder")}
                    value={m.name}
                    onChange={(v) => setModel(i(), "name", v)}
                    validationState={m.err.name ? "invalid" : undefined}
                    error={m.err.name}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  class="mt-1.5"
                  onClick={() => removeModel(i())}
                  disabled={form.models.length <= 1}
                  aria-label={language.t("provider.custom.models.remove")}
                />
                <Show when={m.id.trim() || m.name.trim() || m.matchedPreset}>
                  <CustomProviderModelFields
                    model={m}
                    presets={metadata()?.catalog.items ?? []}
                    vendors={metadata()?.catalog.vendors ?? []}
                    copy={props.modelCopy ?? modelPresetSettingsCopy(language.locale())}
                    onPreset={(key) => selectPreset(i(), key)}
                    onLimit={(field, value) => setModelLimit(i(), field, value)}
                    onReset={(field) => {
                      setForm("models", i(), (current) => resetModelField(current, field))
                      lookupModel(i())
                    }}
                  />
                </Show>
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
            {language.t("provider.custom.models.add")}
          </Button>
          <Show when={presets()?.status === "unavailable"}>
            <p role="status">{(props.modelCopy ?? modelPresetSettingsCopy(language.locale())).unavailable}</p>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => {
                if (active && props.isSourceCurrent()) void retryPresets()
              }}
            >
              {(props.modelCopy ?? modelPresetSettingsCopy(language.locale())).retry}
            </Button>
          </Show>
        </div>

        <details ref={advanced} class="arforge-provider-config-advanced">
          <summary>{language.t("provider.custom.headers.label")}</summary>
          <div class="flex flex-col gap-3">
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>
        </details>

        <Show when={!capability.loading && !capability()?.canWrite}>
          <p role="status" class="text-14-regular text-text-base">
            {providerConfigurationReadonly}
          </p>
        </Show>
        <Show when={saveState.error}>
          <p role="alert" class="text-14-regular text-text-base">
            {saveState.error}
          </p>
        </Show>
        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending || !capability()?.canWrite}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
        </Button>
      </form>
    </div>
  )
}
