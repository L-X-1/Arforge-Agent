const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"
import { modelLimitValue, parseModelLimit, type ModelAutofillDraft } from "./custom-provider-model-autofill"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { modelPresetSettingsCopy } from "./custom-provider-model-copy"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
  context?: string
  input?: string
  output?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = ModelAutofillDraft & {
  row: string
  id: string
  name: string
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
  limitError?: string
}

export function validateCustomProvider(input: ValidateArgs) {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim()
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.custom.error.providerID.format")
      : undefined

  const nameError = !name ? input.t("provider.custom.error.name.required") : undefined
  const urlError = !baseURL
    ? input.t("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("provider.custom.error.baseURL.format")
      : undefined

  const disabled = input.disabledProviders.includes(providerID)
  const existsError = idError
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled
      ? input.t("provider.custom.error.providerID.exists")
      : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined
    const context = parseModelLimit(m.context)
    const inputLimit = parseModelLimit(m.input)
    const output = parseModelLimit(m.output)
    return {
      id: idError,
      name: nameError,
      ...(context.invalid ? { context: input.limitError ?? modelPresetSettingsCopy("en").invalidLimit } : {}),
      ...(inputLimit.invalid ? { input: input.limitError ?? modelPresetSettingsCopy("en").invalidLimit } : {}),
      ...(output.invalid ? { output: input.limitError ?? modelPresetSettingsCopy("en").invalidLimit } : {}),
    }
  })
  const modelsValid = models.every((m) => !m.id && !m.name && !m.context && !m.input && !m.output)
  const modelConfig: Record<string, Omit<ModelPreset.ConfigurationInput, "id">> = Object.fromEntries(
    input.form.models.map((m) => {
      const context = parseModelLimit(m.context).value,
        inputLimit = parseModelLimit(m.input).value,
        output = parseModelLimit(m.output).value
      return [
        m.id.trim(),
        {
          name: m.name.trim(),
          ...(context !== undefined || output !== undefined || inputLimit !== undefined
            ? {
                limit: {
                  ...(context !== undefined ? { context } : {}),
                  ...(output !== undefined ? { output } : {}),
                  ...(inputLimit !== undefined ? { input: inputLimit } : {}),
                },
              }
            : {}),
          ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
          ...(m.preset !== undefined ? { preset: m.preset } : {}),
          ...(m.variants !== undefined ? { variants: m.variants } : {}),
          ...(m.defaultVariant !== undefined ? { defaultVariant: m.defaultVariant } : {}),
        },
      ] as const
    }),
  )

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
  }

  const ok = !idError && !existsError && !nameError && !urlError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (
  initial?: Pick<ModelRow, "id" | "name" | "capabilities" | "preset" | "variants" | "defaultVariant"> & {
    limit?: { context?: number; input?: number; output?: number }
  },
): ModelRow => ({
  row: nextRow(),
  id: initial?.id ?? "",
  name: initial?.name ?? "",
  context: modelLimitValue(initial?.limit?.context),
  output: modelLimitValue(initial?.limit?.output),
  input: modelLimitValue(initial?.limit?.input),
  ...(initial?.capabilities !== undefined ? { capabilities: initial.capabilities } : {}),
  ...(initial?.preset !== undefined ? { preset: initial.preset } : {}),
  ...(initial?.variants !== undefined ? { variants: initial.variants } : {}),
  ...(initial?.defaultVariant !== undefined ? { defaultVariant: initial.defaultVariant } : {}),
  owners: {},
  matchStatus: "idle",
  err: {},
})
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })

/** Shared model editor projection; UI ownership fields never enter the save DTO. */
export function modelConfiguration(row: ModelRow): ModelPreset.ConfigurationInput {
  const limit = Object.fromEntries(
    (["context", "input", "output"] as const).flatMap((key) => {
      const parsed = parseModelLimit(row[key])
      if (parsed.invalid) throw new Error(modelPresetSettingsCopy("en").invalidLimit)
      return parsed.value === undefined ? [] : [[key, parsed.value]]
    }),
  )
  if (!row.id.trim() || !row.name.trim()) throw new Error("Model ID and display name are required.")
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    ...(Object.keys(limit).length ? { limit } : {}),
    ...(row.capabilities !== undefined ? { capabilities: row.capabilities } : {}),
    ...(row.preset !== undefined ? { preset: row.preset } : {}),
    ...(row.variants !== undefined ? { variants: row.variants } : {}),
    ...(row.defaultVariant !== undefined ? { defaultVariant: row.defaultVariant } : {}),
  }
}

/** V1 has no preset/canonical variant contract and requires paired limits. */
export function legacyCustomProviderConfig(
  config: NonNullable<ReturnType<typeof validateCustomProvider>["result"]>["config"],
  copy: { legacyUnsupported: string; legacyLimitUnsupported: string },
) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([id, model]) => {
      if (
        model.preset !== undefined ||
        model.capabilities !== undefined ||
        model.variants !== undefined ||
        model.defaultVariant !== undefined
      )
        throw new Error(copy.legacyUnsupported)
      if (model.limit && (model.limit.context === undefined || model.limit.output === undefined))
        throw new Error(copy.legacyLimitUnsupported)
      const limit =
        model.limit?.context !== undefined && model.limit.output !== undefined
          ? {
              context: model.limit.context,
              output: model.limit.output,
              ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
            }
          : undefined
      return [id, { name: model.name, ...(limit ? { limit } : {}) }]
    }),
  )
  return { ...config, models }
}
