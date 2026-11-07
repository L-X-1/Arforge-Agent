import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { Schema } from "effect"
import { Model } from "@arforge-ai/schema/model"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { CustomProviderModelFields } from "./custom-provider-model-fields"
import { modelPresetSettingsCopy } from "./custom-provider-model-copy"
import {
  applyModelResolution,
  createModelMetadataLookup,
  editModelField,
  resetModelField,
  type FormModelMetadata,
  type ModelLimitKey,
} from "./custom-provider-model-autofill"
import { modelConfiguration, modelRow } from "./dialog-custom-provider-form"
import { modelPresetKey } from "@/utils/model-preset-match"
import { providerWorkspaceCopy } from "./settings-v2/provider-workspace-copy"
import { applyModelDefaultChoice, createModelEditorReset, type ModelDefaultChoice } from "./provider-model-editor-state"

export function ProviderModelEditor(props: {
  initial?: ModelPreset.ConfigurationInput
  variantIDs?: readonly string[]
  metadata?: FormModelMetadata
  locale: string
  identity: () => string
  isCurrent: () => boolean
  onSave: (model: ModelPreset.ConfigurationInput) => Promise<void>
  onCancel: () => void
}) {
  const [state, setState] = createStore({
    row: modelRow(props.initial),
    error: "",
    busy: false,
    capabilities: props.initial?.capabilities ? JSON.stringify(props.initial.capabilities, null, 2) : "",
    capsEdited: false,
    defaultChoice: { type: "untouched" } as ModelDefaultChoice,
  })
  let active = true
  const copy = () => providerWorkspaceCopy(props.locale),
    metaCopy = () => modelPresetSettingsCopy(props.locale)
  const lookup = createModelMetadataLookup(
    () => JSON.stringify([props.identity(), state.row.row, state.row.id, state.row.name]),
    () => active && props.isCurrent(),
  )
  onCleanup(() => {
    active = false
    lookup.dispose()
  })
  const resolve = () => {
    lookup.invalidate()
    setState("row", "matchStatus", "pending")
    void lookup.resolve(
      {
        id: state.row.id,
        name: state.row.owners?.name?.type === "auto" || state.row.nameFallback !== undefined ? "" : state.row.name,
        selectedOrigin: state.row.presetSelection,
      },
      props.metadata,
      (result) => setState("row", (row) => applyModelResolution(row, result)),
    )
  }
  createEffect(on(() => props.metadata, resolve))
  createEffect(() => {
    if (!state.capsEdited)
      setState("capabilities", state.row.capabilities ? JSON.stringify(state.row.capabilities, null, 2) : "")
  })
  const change = (field: "name" | ModelLimitKey, value: string) => {
    setState("row", (row) => editModelField(row, field, value))
    setState("error", "")
    resolve()
  }
  const reset = createModelEditorReset(
    props.identity,
    () => active && props.isCurrent() && !state.busy,
    () => {
      lookup.invalidate()
      setState("row", reconcile(modelRow(props.initial)))
      setState({ error: "", capsEdited: false, defaultChoice: { type: "untouched" } })
      resolve()
    },
  )
  const capability = (field: string, checked: boolean) => {
    try {
      const caps =
        state.capsEdited && state.capabilities.trim()
          ? Schema.decodeUnknownSync(Model.Capabilities)(JSON.parse(state.capabilities))
          : (state.row.capabilities ?? { tools: false, input: [], output: [] })
      const next =
        field === "tools"
          ? { ...caps, tools: checked }
          : {
              ...caps,
              input: checked ? [...new Set([...caps.input, field])] : caps.input.filter((value) => value !== field),
            }
      setState("capsEdited", false)
      setState("row", (row) => ({
        ...row,
        capabilities: next,
        owners: { ...row.owners, capabilities: { type: "manual" } },
      }))
      resolve()
    } catch {
      setState("error", copy().invalidCapabilities)
    }
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy || !active || !props.isCurrent()) return
    try {
      let row = state.row
      if (state.capsEdited) {
        try {
          row = {
            ...row,
            capabilities: state.capabilities.trim()
              ? Schema.decodeUnknownSync(Model.Capabilities)(JSON.parse(state.capabilities))
              : undefined,
          }
        } catch {
          setState("error", copy().invalidCapabilities)
          return
        }
      }
      const model = applyModelDefaultChoice(modelConfiguration(row), state.defaultChoice, props.variantIDs ?? [])
      const owner = props.identity()
      setState("busy", true)
      await props.onSave(model)
      if (active && props.isCurrent() && owner === props.identity()) props.onCancel()
    } catch {
      if (active && props.isCurrent()) setState("error", copy().failed)
    } finally {
      if (active) setState("busy", false)
    }
  }
  return (
    <form class="arforge-model-editor" data-model-editor onSubmit={save}>
      <TextField
        label={copy().id}
        autofocus={!props.initial}
        value={state.row.id}
        readOnly={!!props.initial}
        copyable={!!props.initial}
        required
        onChange={(value) => {
          if (props.initial) return
          setState("row", "id", value)
          setState("row", "presetSelection", undefined)
          resolve()
        }}
      />
      <CustomProviderModelFields
        limitsOnly
        autofocusField={props.initial ? "context" : undefined}
        descriptions={{ context: copy().contextHelp, output: copy().outputHelp }}
        model={state.row}
        presets={props.metadata?.catalog.items ?? []}
        vendors={props.metadata?.catalog.vendors ?? []}
        copy={metaCopy()}
        onPreset={(key) => {
          lookup.invalidate()
          const preset = props.metadata?.catalog.items.find((item) => modelPresetKey(item) === key)
          if (preset && props.metadata)
            setState("row", (row) => ({
              ...applyModelResolution(row, { status: "matched", preset, revision: props.metadata!.catalog.revision }),
              presetSelection: preset.origin,
            }))
          else {
            setState("row", "presetSelection", undefined)
            resolve()
          }
        }}
        onLimit={change}
        onReset={(field) => {
          setState("row", (row) => resetModelField(row, field))
          resolve()
        }}
      />
      <details>
        <summary>{copy().advanced}</summary>
        <TextField label={copy().name} value={state.row.name} required onChange={(value) => change("name", value)} />
        <CustomProviderModelFields
          presetOnly
          model={state.row}
          presets={props.metadata?.catalog.items ?? []}
          vendors={props.metadata?.catalog.vendors ?? []}
          copy={metaCopy()}
          onPreset={(key) => {
            lookup.invalidate()
            const metadata = props.metadata,
              preset = metadata?.catalog.items.find((item) => modelPresetKey(item) === key)
            if (preset && metadata)
              setState("row", (row) => ({
                ...applyModelResolution(row, { status: "matched", preset, revision: metadata.catalog.revision }),
                presetSelection: preset.origin,
              }))
            else {
              setState("row", "presetSelection", undefined)
              resolve()
            }
          }}
          onLimit={change}
          onReset={(field) => {
            setState("row", (row) => resetModelField(row, field))
            resolve()
          }}
        />
        <TextField
          label={metaCopy().input}
          description={copy().inputHelp}
          value={state.row.input ?? ""}
          inputmode="numeric"
          onChange={(value) => change("input", value)}
        />
        <fieldset>
          <legend>{copy().capabilities}</legend>
          <Show when={!state.row.capabilities}>
            <p role="status">{metaCopy().unknownPlaceholder}</p>
          </Show>
          {(["tools", "text", "image", "audio", "video", "document"] as const).map((field) => (
            <label class="arforge-model-capability">
              <input
                type="checkbox"
                checked={
                  field === "tools"
                    ? (state.row.capabilities?.tools ?? false)
                    : (state.row.capabilities?.input.includes(field) ?? false)
                }
                onChange={(event) => capability(field, event.currentTarget.checked)}
              />
              {field === "tools"
                ? copy().tools
                : field === "image"
                  ? copy().vision
                  : field === "audio"
                    ? copy().audio
                    : field === "video"
                      ? copy().video
                      : field === "document"
                        ? copy().document
                        : copy().text}
            </label>
          ))}
        </fieldset>
        <details>
          <summary>{copy().capabilities} JSON</summary>
          <TextField
            label={copy().capabilities}
            value={state.capabilities}
            multiline
            onChange={(value) => {
              setState("capsEdited", true)
              setState("capabilities", value)
            }}
          />
        </details>
        <label>
          {copy().variant}
          <select
            aria-label={copy().variant}
            value={
              state.defaultChoice.type === "untouched"
                ? "untouched"
                : state.defaultChoice.type === "model-default"
                  ? "model-default"
                  : JSON.stringify(["variant", state.defaultChoice.id])
            }
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "untouched") setState("defaultChoice", { type: "untouched" })
              else if (value === "model-default") setState("defaultChoice", { type: "model-default" })
              else {
                const id = props.variantIDs?.find((id) => JSON.stringify(["variant", id]) === value)
                if (id !== undefined) setState("defaultChoice", { type: "variant", id })
              }
            }}
          >
            <option value="untouched">
              {props.initial
                ? `${copy().preserveVariant}${props.initial.defaultVariant ? ` (${props.initial.defaultVariant})` : ""}`
                : copy().automaticHighest}
            </option>
            <option value="model-default">{copy().modelDefault}</option>
            {props.variantIDs?.map((id) => (
              <option value={JSON.stringify(["variant", id])}>{id}</option>
            ))}
          </select>
        </label>
        <p>{copy().preserved}</p>
      </details>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
      <div class="arforge-provider-editor-actions">
        <Button type="button" onClick={reset} disabled={state.busy}>
          {copy().reset}
        </Button>
        <Button type="button" onClick={props.onCancel}>
          {copy().cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={state.busy}>
          {copy().save}
        </Button>
      </div>
    </form>
  )
}
