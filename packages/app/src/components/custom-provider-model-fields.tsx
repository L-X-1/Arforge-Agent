import { Button } from "@arforge-ai/ui/button"
import { TextField } from "@arforge-ai/ui/text-field"
import { createMemo, For, Show } from "solid-js"
import type { ModelRow } from "./dialog-custom-provider-form"
import type { FormModelPreset, ModelLimitKey } from "./custom-provider-model-autofill"
import { modelPresetKey } from "@/utils/model-preset-match"

import type { ModelSetupCopy } from "./custom-provider-model-copy"

/** Receives manufacturer metadata, never a connection ID/URL/key to rewrite. */
export function CustomProviderModelFields(props: {
  model: ModelRow
  presets: readonly FormModelPreset[]
  vendors: readonly { id: string; name: string }[]
  copy: ModelSetupCopy
  onPreset: (key: string) => void
  onLimit: (field: ModelLimitKey, value: string) => void
  onReset: (field: ModelLimitKey) => void
  fields?: readonly ModelLimitKey[]
  limitsOnly?: boolean
  presetOnly?: boolean
  descriptions?: Partial<Record<ModelLimitKey, string>>
  autofocusField?: ModelLimitKey
}) {
  const groups = createMemo(() => {
    const groups = new Map<string, FormModelPreset[]>()
    for (const preset of props.presets) {
      const rows = groups.get(preset.origin.vendorID) ?? []
      rows.push(preset)
      groups.set(preset.origin.vendorID, rows)
    }
    return [...groups.entries()]
  })
  const status = () => {
    switch (props.model.matchStatus) {
      case "pending":
        return props.copy.matching
      case "matched":
        return props.copy.matched
      case "ambiguous":
        return props.copy.ambiguous
      case "unavailable":
        return props.copy.unavailable
      default:
        return props.copy.unknown
    }
  }
  return (
    <div class="arforge-provider-model-parameters" data-model-parameters={props.model.row}>
      <Show when={!props.limitsOnly}>
        <label class="arforge-provider-model-preset">
          <span>{props.copy.preset}</span>
          <select
            aria-label={props.copy.preset}
            value={props.model.matchedPreset ? modelPresetKey(props.model.matchedPreset) : ""}
            onChange={(event) => props.onPreset(event.currentTarget.value)}
          >
            <option value="">{props.copy.automatic}</option>
            <For each={groups()}>
              {([vendorID, presets]) => (
                <optgroup label={props.vendors.find((vendor) => vendor.id === vendorID)?.name ?? vendorID}>
                  <For each={presets}>
                    {(preset) => (
                      <option value={modelPresetKey(preset)}>
                        {preset.name === preset.origin.modelID
                          ? preset.name
                          : `${preset.name} · ${preset.origin.modelID}`}
                      </option>
                    )}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
        </label>
      </Show>
      <p role="status" class="arforge-provider-model-match">
        {status()}
      </p>
      <p class="arforge-provider-model-metadata-hint">{props.copy.metadataHint}</p>
      <Show when={!props.limitsOnly && props.model.matchedPreset}>
        <details class="arforge-model-metadata-sources">
          <summary>{props.copy.sources}</summary>
          <For each={props.model.matchedPreset?.provenance}>
            {(source) => (
              <p>
                <span>{source.sourceID}</span>
                {" · "}
                <time>
                  {source.verifiedAt && Number.isFinite(new Date(source.verifiedAt).getTime())
                    ? new Date(source.verifiedAt).toISOString()
                    : props.copy.unknownPlaceholder}
                </time>
              </p>
            )}
          </For>
        </details>
      </Show>
      <Show when={!props.presetOnly}>
        <div class="arforge-provider-model-limits">
          <For each={props.fields ?? (["context", "output"] as const)}>
            {(field) => (
              <div class="arforge-provider-model-limit">
                <TextField
                  label={props.copy[field]}
                  autofocus={props.autofocusField === field}
                  description={props.descriptions?.[field]}
                  value={props.model[field] ?? ""}
                  type="text"
                  inputmode="numeric"
                  placeholder={props.copy.unknownPlaceholder}
                  onChange={(value) => props.onLimit(field, value)}
                  validationState={props.model.err[field] ? "invalid" : undefined}
                  error={props.model.err[field]}
                />
                <Show when={props.model.owners?.[field]?.type === "manual"}>
                  <span class="arforge-provider-model-override">{props.copy.override}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    onClick={() => props.onReset(field)}
                    aria-label={`${props.copy.reset}: ${props.copy[field]}`}
                  >
                    {props.copy.reset}
                  </Button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
