import type { OperationsApi } from "@/utils/server"
import type { validateCustomProvider } from "./dialog-custom-provider-form"

type Draft = NonNullable<ReturnType<typeof validateCustomProvider>["result"]>
type Api = Pick<OperationsApi["providers"], "capability" | "save" | "credential">
export const providerConfigurationReadonly = "Host provider configuration is unavailable or read-only for this source."
export const providerCredentialRetry = "Configuration is saved; credential connection failed. Retry the same provider."

/** Volatile receipt only; keys and header values are never retained here. */
export function createProviderConfigurationSave(api: Api, isCurrent: () => boolean) {
  let committed: { providerID: string; revision: string; fingerprint: string } | undefined
  const check = () => {
    if (!isCurrent()) throw new Error("Provider source changed; nothing else was saved.")
  }
  return {
    acknowledged: (id: string) => committed?.providerID === id,
    async save(draft: Draft, onCommitted: () => void) {
      check()
      const capability = (await api.capability()).data
      check()
      if (!capability.canWrite) throw new Error(providerConfigurationReadonly)
      const existing = capability.providers.find((provider) => provider.id === draft.providerID)
      const headers = draft.config.options.headers
      const input = {
        providerID: draft.providerID,
        name: draft.name,
        baseURL: draft.config.options.baseURL,
        // Preserve all validated nonsecret model metadata in the shared save DTO.
        models: Object.entries(draft.config.models).map(([id, model]) => ({ id, ...model })),
        authentication: (draft.key || draft.config.env?.length || headers ? "required" : "optional") as
          | "required"
          | "optional",
        ...(draft.config.env?.[0] ? { env: draft.config.env[0] } : {}),
      }
      const fingerprint = JSON.stringify(input)
      const previous = committed?.providerID === draft.providerID ? committed : undefined
      if (previous && existing?.revision !== previous.revision)
        throw new Error("Provider configuration changed. Read the source again before retrying.")
      if (!previous || previous.fingerprint !== fingerprint) {
        const receipt = (
          await api.save({
            ...input,
            revision: previous?.revision ?? (existing?.disabled ? existing.revision : undefined),
          })
        ).data
        check()
        committed = { ...receipt, fingerprint }
      }
      check()
      onCommitted()
      check()
      if (draft.key || headers) {
        try {
          await api.credential({ providerID: draft.providerID, revision: committed!.revision, key: draft.key, headers })
        } catch {
          check()
          throw new Error(providerCredentialRetry)
        }
        check()
      }
    },
  }
}

export async function refreshProviderConfiguration(
  sync: { queryClient: import("@tanstack/solid-query").QueryClient },
  scope: string,
  options: { reportErrors?: boolean } = {},
) {
  const predicate = (query: import("@tanstack/solid-query").Query) =>
    query.queryKey[0] === scope &&
    (query.queryKey[1] === "bootstrap" ||
      query.queryKey.includes("providers") ||
      query.queryKey.includes("integrations") ||
      query.queryKey.includes("models"))
  await sync.queryClient.invalidateQueries({ predicate }, { throwOnError: options.reportErrors })
  // Bootstrap uses allSettled, so a failed nested active catalog query must also be observed.
  if (
    options.reportErrors &&
    sync.queryClient
      .getQueryCache()
      .findAll({ predicate, type: "active" })
      .some((query) => query.state.status === "error")
  )
    throw new Error("Provider/model list refresh failed.")
}

export function providerConfigurationRefreshCopy(locale: string) {
  const zh = locale.startsWith("zh")
  const traditional = locale === "zht" || locale === "zh-TW"
  return {
    saved: zh ? (traditional ? "設定已儲存。" : "配置已保存。") : "Configuration saved.",
    failed: zh
      ? traditional
        ? "供應商/模型清單重新整理失敗。"
        : "提供商/模型列表刷新失败。"
      : "Provider/model list refresh failed.",
    retry: zh ? (traditional ? "重試重新整理清單" : "重试列表刷新") : "Retry list refresh",
    availability: zh
      ? traditional
        ? "模型清單會自動更新。"
        : "模型列表会自动更新。"
      : "The model list updates automatically.",
  }
}

/** The read continuation outlives a closed form, but remains bound to its captured source. */
export function createProviderConfigurationRefresh(input: {
  refresh: () => Promise<void>
  isCurrent: () => boolean
  onFailure: (retry: () => void) => void
}) {
  let pending: Promise<void> | undefined
  const current = () => {
    try {
      return input.isCurrent()
    } catch {
      return false
    }
  }
  const run = () => {
    if (!current() || pending) return
    pending = Promise.resolve()
      .then(input.refresh)
      .catch(() => {
        if (current()) input.onFailure(run)
      })
      .finally(() => {
        pending = undefined
      })
  }
  return run
}
