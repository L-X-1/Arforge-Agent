import { confirmationSnapshot, useConfirmAction } from "@/components/confirm-action"
import { createManagementConfirmationGuard } from "../control-center/management-confirmation"
import { createStore } from "solid-js/store"
import { ManagementStatus } from "./management-status"
import { managementCopy, managementErrorText } from "./management-state"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Tag } from "@arforge-ai/ui/v2/badge-v2"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { ProviderIcon } from "@arforge-ai/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createEffect, createMemo, createResource, on, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerProtocol, useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { refreshProviderConfiguration } from "../provider-configuration"
import { SettingsListV2 } from "./parts/list"
import { ManagementDetail } from "../control-center/management-detail"
import { ManagementDangerZone } from "../control-center/management-danger-zone"
import "./settings-v2.css"
import "./model-configuration.css"
import { ProviderWorkspace } from "./provider-workspace"
import { providerWorkspaceCopy } from "./provider-workspace-copy"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const modelIdentity = (models: ProviderItem["models"]) =>
  confirmationSnapshot(
    Object.values(models)
      .map((model) => ({ id: model.id, name: model.name }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.name.localeCompare(b.name)),
  )

const PROVIDER_NOTES = [
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component<{
  title: string
  onBack?: () => void
  onNavigate?: (value: string) => void
}> = (props) => {
  const dialog = useDialog()
  const confirmAction = useConfirmAction()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const protocol = useServerProtocol()
  const serverSync = useServerSync()
  const providers = useProviders()
  const [configuration, { refetch: refreshConfiguration }] = createResource(
    () => ({
      sdk: serverSdk(),
      kind: protocol(),
      catalog: providers
        .connected()
        .map((item) => item.id)
        .join("\0"),
    }),
    async ({ sdk, kind }) => {
      if (kind !== "v2") return undefined
      try {
        return { ...(await sdk.operationsApi.providers.capability()).data, readFailed: false }
      } catch {
        return { canWrite: false, providers: [], readFailed: true }
      }
    },
  )
  const configured = (id: string) =>
    configuration()?.canWrite ? configuration()?.providers.find((item) => item.id === id) : undefined
  const configurationCopy = () =>
    language.locale().startsWith("zh")
      ? {
          failed: "无法读取当前来源的服务商配置权限。请重试读取；尚未启用配置写入。",
          readOnly: "当前服务器账户没有主机服务商配置权限。请切换到有权限的来源后再配置。",
        }
      : {
          failed:
            "Provider configuration access could not be read from this source. Retry the read; writes remain unavailable.",
          readOnly:
            "This server account cannot configure host providers. Select a source with configuration access to continue.",
        }
  const providerConnect = useProviderConnectController({ onBack: props.onBack })
  const [request, setRequest] = createStore({
    busy: "",
    error: "",
    notice: "",
    selected: "",
    detailOpen: 0,
    selectionCurrent: (): boolean => false,
  })
  const detailCopy = () =>
    language.locale().startsWith("zh")
      ? {
          details: "查看详情",
          connected: "已连接",
          source: "连接来源",
          models: "当前可用模型",
          empty: "当前连接未提供可用模型。",
          id: "服务商标识",
          choose: "选择一个服务商，查看连接来源和当前可用模型。",
        }
      : {
          details: "View details",
          connected: "Connected",
          source: "Connection source",
          models: "Available models",
          empty: "No models are available from this connection.",
          id: "Provider ID",
          choose: "Select a provider to inspect its connection source and available models.",
        }
  const selected = createMemo(() =>
    request.selectionCurrent() ? providers.connected().find((item) => item.id === request.selected) : undefined,
  )
  const select = (id: string) => {
    const sdk = serverSdk(),
      sync = serverSync(),
      kind = protocol()
    setRequest({
      selected: id,
      detailOpen: request.detailOpen + 1,
      selectionCurrent: () => serverSdk() === sdk && serverSync() === sync && protocol() === kind,
    })
  }
  const captureConfirmation = createManagementConfirmationGuard({
    source: serverSdk,
    key: () => protocol() ?? "pending",
    blocked: () => !!request.busy || !protocol(),
  })
  createEffect(
    on(
      [serverSdk, serverSync, protocol],
      () => {
        setRequest({ busy: "", error: "", notice: "", selected: "", selectionCurrent: () => false })
      },
      { defer: true },
    ),
  )

  const connect = (provider?: string) => {
    providerConnect.select(provider)
    void dialog.show(() => <DialogConnectProvider controller={providerConnect} />)
  }

  const connected = createMemo(() => providers.connected())

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) =>
    source(item) !== "env" &&
    (protocol() === "v1" ||
      (!configuration.loading && (isConfigCustom(item.id) ? configured(item.id)?.canDisconnect === true : true)))

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    if (protocol() === "v2" && configuration()?.providers.some((item) => item.id === providerID)) return true
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  type DisconnectContext = {
    sdk: ReturnType<typeof serverSdk>
    sync: ReturnType<typeof serverSync>
    custom: boolean
    disabledProviders: string[]
    isCurrent: () => boolean
    revision?: string
    kind?: "v1" | "v2"
  }

  const disableProvider = async (providerID: string, name: string, context: DisconnectContext) => {
    if (!context.isCurrent()) return
    const before = context.disabledProviders
    const next = before.includes(providerID) ? before : [...before, providerID]
    context.sync.set("config", "disabled_providers", next)

    await context.sync
      .updateConfig({ disabled_providers: next })
      .then(() => {
        if (!context.isCurrent()) return
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        if (!context.isCurrent()) return
        const current = context.sync.data.config.disabled_providers ?? []
        if (current.length === next.length && current.every((id, index) => id === next[index]))
          context.sync.set("config", "disabled_providers", before)
        const message = managementErrorText(err, language.t("common.requestFailed"))
        setRequest("error", message)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    const confirmation = captureConfirmation()
    const sync = serverSync()
    const kind = protocol()
    const item = connected().find((item) => item.id === providerID)
    if (!item || !canDisconnect(item)) return
    const providerSource = source(item)
    const affectedModels = Object.values(item.models).map((model) => ({ id: model.id, name: model.name }))
    const modelSnapshot = modelIdentity(item.models)
    const custom = isConfigCustom(providerID)
    const revision = configured(providerID)?.revision
    const disabledProviders = [...(sync.data.config.disabled_providers ?? [])]
    const sourceCurrent = () => confirmation.isCurrent() && serverSync() === sync && protocol() === kind
    const isCurrent = () => {
      const current = connected().find((item) => item.id === providerID)
      const disabled = sync.data.config.disabled_providers ?? []
      return (
        confirmation.canWrite() &&
        sourceCurrent() &&
        !!current &&
        current.name === name &&
        source(current) === providerSource &&
        canDisconnect(current) &&
        modelSnapshot !== undefined &&
        modelIdentity(current.models) === modelSnapshot &&
        isConfigCustom(providerID) === custom &&
        configured(providerID)?.revision === revision &&
        (!custom ||
          (disabled.length === disabledProviders.length &&
            disabled.every((id, index) => id === disabledProviders[index])))
      )
    }
    if (!isCurrent()) return
    const scopeCopy = language.locale().startsWith("zh")
      ? { source: "来源", recovery: "恢复使用需重新连接；本次只断开所选服务商。", models: "受影响模型" }
      : {
          source: "Source",
          recovery: "Reconnect to use this provider again. Only the selected connection is affected.",
          models: "Affected models",
        }
    const publicSource = managementErrorText(confirmation.source.url, "")
    const modelImpact = `${scopeCopy.models}: ${affectedModels.length}`
    if (
      !(await confirmAction(
        `${name} · ${providerID}\n${scopeCopy.source}: ${publicSource} · ${type(item)}\n\n${modelImpact}\n\n${managementCopy(language.locale()).disconnect}\n${scopeCopy.recovery}`,
        {
          isCurrent,
          danger: true,
          details: {
            summary: modelImpact,
            items: affectedModels.map((model) => ({ label: model.name, value: model.id })),
          },
        },
      ))
    )
      return
    if (!isCurrent()) return
    const context: DisconnectContext = {
      sdk: confirmation.source,
      sync,
      custom,
      disabledProviders,
      isCurrent: sourceCurrent,
      revision,
      kind,
    }
    setRequest({ busy: providerID, error: "", notice: "" })
    try {
      await performDisconnect(providerID, name, context)
      if (sourceCurrent() && !request.error)
        setRequest("notice", language.t("provider.disconnect.toast.disconnected.title", { provider: name }))
    } catch (error) {
      if (sourceCurrent()) setRequest("error", managementErrorText(error, language.t("common.requestFailed")))
    } finally {
      if (sourceCurrent()) setRequest("busy", "")
    }
  }

  const performDisconnect = async (providerID: string, name: string, context: DisconnectContext) => {
    if (!context.isCurrent()) return
    if (context.kind === "v2" && context.custom) {
      if (!context.revision) throw new Error(language.t("common.requestFailed"))
      try {
        await context.sdk.operationsApi.providers.disconnect({ providerID, revision: context.revision })
      } finally {
        if (context.isCurrent()) {
          await refreshProviderConfiguration(context.sync, context.sdk.scope)
          if (context.isCurrent()) await refreshConfiguration()
        }
      }
      return
    }
    if (context.custom) {
      // Config-defined custom providers may have no separately stored auth entry.
      await context.sdk.client.auth.remove({ providerID }).catch(() => undefined)
      if (!context.isCurrent()) return
      const current = context.sync.data.config.disabled_providers ?? []
      if (
        current.length !== context.disabledProviders.length ||
        !current.every((id, index) => id === context.disabledProviders[index])
      )
        throw new Error(language.t("common.requestFailed"))
      await disableProvider(providerID, name, context)
      return
    }
    await context.sdk.client.auth
      .remove({ providerID })
      .then(async () => {
        if (!context.isCurrent()) return
        await context.sdk.client.global.dispose()
        if (!context.isCurrent()) return
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        if (!context.isCurrent()) return
        const message = managementErrorText(err, language.t("common.requestFailed"))
        setRequest("error", message)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{props.title}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers" aria-busy={!!request.busy}>
        <ProviderWorkspace />
        <details class="arforge-provider-legacy-actions" data-provider-legacy-actions open={protocol() === "v1"}>
          <summary>{providerWorkspaceCopy(language.locale()).otherConnections}</summary>
          <ManagementStatus saving={!!request.busy} error={request.error} notice={request.notice} />
          <div class="arforge-management-master-detail settings-v2-connection-layout">
            <div class="arforge-management-master-content">
              <div class="settings-v2-section" data-component="connected-providers-section">
                <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
                <SettingsListV2>
                  <Show
                    when={connected().length > 0}
                    fallback={
                      <div class="settings-v2-provider-empty" role="status">
                        {language.t("settings.providers.connected.empty")}
                      </div>
                    }
                  >
                    <For each={connected()}>
                      {(item) => (
                        <div class="settings-v2-provider-row group" data-density="single">
                          <div class="settings-v2-provider-lead">
                            <ProviderIcon
                              id={item.id}
                              width={PROVIDER_ICON_SIZE}
                              height={PROVIDER_ICON_SIZE}
                              class="settings-v2-provider-icon shrink-0"
                            />
                            <button
                              type="button"
                              class="settings-v2-provider-main settings-v2-provider-select"
                              data-management-detail-id={item.id}
                              aria-expanded={selected()?.id === item.id}
                              onClick={() => select(item.id)}
                            >
                              <span class="settings-v2-provider-name truncate">{item.name}</span>
                              <Tag>{type(item)}</Tag>
                            </button>
                          </div>
                          <Show
                            when={canDisconnect(item)}
                            fallback={
                              <span class="settings-v2-provider-env-hint">
                                {language.t("settings.providers.connected.environmentDescription")}
                              </span>
                            }
                          >
                            <ButtonV2
                              size="normal"
                              variant="ghost-muted"
                              data-management-detail-id={item.id}
                              onClick={() => select(item.id)}
                            >
                              {detailCopy().details}
                            </ButtonV2>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </SettingsListV2>
              </div>

              <div class="settings-v2-section">
                <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
                <SettingsListV2>
                  <For each={popular()}>
                    {(item) => (
                      <div class="settings-v2-provider-row" data-density={note(item.id) ? "double" : "single"}>
                        <div class="settings-v2-provider-lead">
                          <ProviderIcon
                            id={item.id}
                            width={PROVIDER_ICON_SIZE}
                            height={PROVIDER_ICON_SIZE}
                            class="settings-v2-provider-icon shrink-0"
                          />
                          <div class="settings-v2-provider-copy">
                            <div class="settings-v2-provider-main">
                              <span class="settings-v2-provider-name">{item.name}</span>
                            </div>
                            <Show when={note(item.id)}>
                              {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                            </Show>
                          </div>
                        </div>
                        <ButtonV2 size="normal" variant="neutral" icon="plus" onClick={() => connect(item.id)}>
                          {language.t("common.connect")}
                        </ButtonV2>
                      </div>
                    )}
                  </For>

                  <Show when={protocol() === "v2"}>
                    <ManagementStatus
                      scope={language.t("provider.custom.title")}
                      loading={configuration.loading}
                      initialLoading={!configuration()}
                      error={
                        !configuration.loading && configuration()?.readFailed ? configurationCopy().failed : undefined
                      }
                      readOnly={
                        !configuration.loading &&
                        configuration() &&
                        !configuration()?.readFailed &&
                        !configuration()?.canWrite
                          ? configurationCopy().readOnly
                          : undefined
                      }
                      onRetry={() => {
                        void refreshConfiguration()
                      }}
                    />
                  </Show>
                  <Show when={protocol() === "v1" || (!configuration.loading && configuration()?.canWrite)}>
                    <div
                      class="settings-v2-provider-row"
                      data-density="double"
                      data-component="custom-provider-section"
                    >
                      <div class="settings-v2-provider-lead">
                        <ProviderIcon
                          id="synthetic"
                          width={PROVIDER_ICON_SIZE}
                          height={PROVIDER_ICON_SIZE}
                          class="settings-v2-provider-icon shrink-0"
                        />
                        <div class="settings-v2-provider-copy">
                          <div class="settings-v2-provider-main">
                            <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                            <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                          </div>
                          <p class="settings-v2-provider-description">
                            {language.t("settings.providers.custom.description")}
                          </p>
                        </div>
                      </div>
                      <ButtonV2
                        size="normal"
                        variant="neutral"
                        icon="plus"
                        onClick={() => {
                          dialog.show(() => <DialogCustomProvider onBack={dialog.close} />)
                        }}
                      >
                        {language.t("common.connect")}
                      </ButtonV2>
                    </div>
                  </Show>
                </SettingsListV2>

                <button type="button" class="settings-v2-providers-view-all" onClick={() => connect()}>
                  {language.t("dialog.provider.viewAll")}
                </button>
              </div>
            </div>
            <Show
              when={selected()}
              fallback={
                <div class="settings-v2-provider-detail-placeholder">
                  <ProviderIcon id="synthetic" width={24} height={24} />
                  <h3>{language.t("settings.providers.title")}</h3>
                  <p>{detailCopy().choose}</p>
                </div>
              }
            >
              {(item) => (
                <ManagementDetail identity={item().id} openRequest={request.detailOpen} title={item().name}>
                  <div class="settings-v2-connection-detail">
                    <p data-management-source title={managementErrorText(serverSdk().url, "")}>
                      {managementErrorText(serverSdk().url, "")}
                    </p>
                    <span class="settings-v2-connection-state">{detailCopy().connected}</span>
                    <dl>
                      <dt>{detailCopy().id}</dt>
                      <dd>
                        <code>{item().id}</code>
                      </dd>
                      <dt>{detailCopy().source}</dt>
                      <dd>{type(item())}</dd>
                    </dl>
                    <h3>
                      {detailCopy().models} · {Object.keys(item().models).length}
                    </h3>
                    <ul class="settings-v2-detail-models">
                      <For each={Object.values(item().models)} fallback={<li>{detailCopy().empty}</li>}>
                        {(model) => (
                          <li>
                            <span>{model.name}</span>
                            <code>{model.id}</code>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={props.onNavigate}>
                      <ButtonV2 variant="neutral" onClick={() => props.onNavigate?.("models")}>
                        {language.t("settings.models.title")}
                      </ButtonV2>
                    </Show>
                    <Show
                      when={canDisconnect(item())}
                      fallback={
                        <ManagementStatus
                          readOnly={language.t("settings.providers.connected.environmentDescription")}
                        />
                      }
                    >
                      <ManagementDangerZone scope={`${item().name} · ${type(item())}`}>
                        <ButtonV2
                          variant="danger"
                          disabled={!!request.busy || !protocol()}
                          onClick={() => void disconnect(item().id, item().name)}
                        >
                          {language.t("common.disconnect")}
                        </ButtonV2>
                      </ManagementDangerZone>
                    </Show>
                  </div>
                </ManagementDetail>
              )}
            </Show>
          </div>
        </details>
      </div>
    </>
  )
}
