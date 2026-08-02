import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { For, Show, createEffect, createMemo, on, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import { CONTROL_CENTER_CAPABILITY_MAP } from "@/capabilities/control-center-map"
import { SessionExtensionControl } from "@/components/session/session-extension-control"
import { SessionRunHistory } from "@/components/session/session-run-history"
import { AgentDeepDiagnostics } from "./agent-deep-diagnostics"
import { AgentExtensionInsights } from "./agent-extension-insights"
import { DiagnosticsWorkbench, MemoryLearningGovernance } from "./capability-workbench"
import "./control-center.css"
type LocationInfo = Awaited<ReturnType<OperationsApi["location"]["get"]>>
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
const publicError = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return fallback
  }
}
export function ArforgeSettingsPanels(props: {
  value: string
  sessionID?: string
  onNavigate: (value: string) => void
}) {
  const t = useControlCenterText()
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    loading: true,
    error: "",
    location: undefined as LocationInfo | undefined,
  })
  const api = () => serverSDK().operationsApi
  const location = createMemo<LocationInput>(() => ({
    location: {
      directory: state.location?.directory ?? "",
      ...(state.location?.workspaceID ? { workspace: state.location.workspaceID } : {}),
    },
  }))
  const loadLocation = async () => {
    if (state.loading && state.location) return
    setState({ loading: true, error: "" })
    try {
      setState("location", await api().location.get())
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  onMount(() => void loadLocation())
  const panelProps = (value: string, title: string, description: string) => ({
    value,
    title,
    description,
    context: () => ({
      loading: state.loading,
      error: state.error,
      directory: state.location?.directory,
    }),
    onRefresh: loadLocation,
  })
  return (
    <>
      <Show when={props.value === "arforge-overview"}>
        <ControlPanel
          {...panelProps("arforge-overview", t("系统概览"), t("Server、工作区和 Agent 能力引擎的实时只读状态。"))}
        >
          <SystemOverview api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-integrations"}>
        <ControlPanel
          {...panelProps(
            "arforge-integrations",
            t("Provider / 模型"),
            t("模型配置仍由成熟设置界面管理；这里补齐集成连接和凭据生命周期。"),
          )}
        >
          <ProviderControl
            api={api}
            location={location}
            ready={() => !state.loading && !!state.location}
            onNavigate={props.onNavigate}
          />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-permissions"}>
        <ControlPanel
          {...panelProps(
            "arforge-permissions",
            t("权限 / 安全"),
            t("查看待处理请求以及已经持久化的权限规则，并可精确撤销单条规则。"),
          )}
        >
          <SavedPermissionControl api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-memory"}>
        <ControlPanel
          {...panelProps(
            "arforge-memory",
            t("Memory / Learning"),
            t("同一工作区中的持久记忆、语义检索、召回质量、编辑和治理闭环。"),
          )}
        >
          <MemoryControl api={api} location={location} ready={() => !state.loading && !!state.location} />
          <MemoryLearningGovernance api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-extensions"}>
        <ControlPanel
          {...panelProps(
            "arforge-extensions",
            t("Workflow / Plugin / Skill"),
            t("Workflow 运行、插件两阶段安装、Skill 开关与恢复入口共用同一 typed Server API。"),
          )}
        >
          <Show when={!state.loading && state.location}>
            <SessionExtensionControl api={api} location={location} sessionID={props.sessionID} />
          </Show>
          <AgentExtensionInsights api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-diagnostics"}>
        <ControlPanel
          {...panelProps(
            "arforge-diagnostics",
            t("诊断 / 运行报告"),
            t("读取持久运行事实；报告不会创建第二份状态源。"),
          )}
        >
          <Show when={!state.loading && state.location}>
            <SessionRunHistory api={api} location={location} />
          </Show>
          <AgentDeepDiagnostics api={api} location={location} ready={() => !state.loading && !!state.location} />
          <DiagnosticsWorkbench api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-operations"}>
        <ControlPanel
          {...panelProps(
            "arforge-operations",
            t("数据库 / 私有运维"),
            t("破坏性运维不伪装成普通按钮；此处明确展示当前安全入口和执行边界。"),
          )}
        >
          <Show when={state.location}>
            {(value) => <ProjectCopyControl api={api} location={location} info={value()} />}
          </Show>
          <PrivateOperations api={api} location={location} ready={() => !state.loading && !!state.location} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-coverage"}>
        <ControlPanel
          {...panelProps(
            "arforge-coverage",
            t("能力映射"),
            t("由机器可读合同生成的覆盖视图。新增 Server API 未归属时，测试会失败。"),
          )}
        >
          <CapabilityCoverage />
        </ControlPanel>
      </Show>
    </>
  )
}
function ControlPanel(props: {
  value: string
  title: string
  description: string
  context: () => { loading: boolean; error: string; directory?: string }
  onRefresh: () => Promise<void>
  children: JSX.Element
}) {
  const t = useControlCenterText()
  return (
    <TabsV2.Content value={props.value} class="settings-v2-panel arforge-control-center-panel">
      <header class="settings-v2-tab-header arforge-control-center-header">
        <h2 class="settings-v2-tab-title">{props.title}</h2>
        <p class="arforge-control-center-description">{props.description}</p>
        <div class="arforge-control-center-context">
          <span class="arforge-control-center-path" title={props.context().directory}>
            {props.context().directory ?? t("正在解析工作区…")}
          </span>
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={props.context().loading}
            onClick={() => void props.onRefresh()}
          >
            {t("刷新")}
          </Button>
        </div>
      </header>
      <div class="settings-v2-tab-body arforge-control-center-body">
        <Show when={props.context().error}>
          <Notice tone="warning">{props.context().error}</Notice>
        </Show>
        <Show when={!props.context().directory && props.context().loading}>
          <div class="settings-v2-loading" role="status" aria-live="polite">
            {t("正在解析工作区…")}
          </div>
        </Show>
        <Show when={props.context().directory}>{props.children}</Show>
      </div>
    </TabsV2.Content>
  )
}
function SystemOverview(props: { api: () => OperationsApi; location: () => LocationInput; ready: () => boolean }) {
  const t = useControlCenterText()
  const [state, setState] = createStore({
    loading: false,
    error: "",
    health: undefined as Awaited<ReturnType<OperationsApi["health"]["get"]>> | undefined,
    agents: [] as Awaited<ReturnType<OperationsApi["agents"]["list"]>>["data"],
    capabilityHealth: undefined as
      | Awaited<ReturnType<OperationsApi["agentCapabilities"]["health"]>>["data"]
      | undefined,
    capabilities: [] as Awaited<ReturnType<OperationsApi["agentCapabilities"]["list"]>>["data"]["items"],
    systemOverview: undefined as
      | Awaited<ReturnType<OperationsApi["agentCapabilities"]["systemOverview"]>>["data"]
      | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "" })
    try {
      const [health, agents, capabilityHealth, capabilities, systemOverview] = await Promise.all([
        props.api().health.get(),
        props.api().agents.list(props.location()),
        props.api().agentCapabilities.health(props.location()),
        props.api().agentCapabilities.list(props.location()),
        props.api().agentCapabilities.systemOverview(props.location()),
      ])
      setState({
        health,
        agents: [...agents.data],
        capabilityHealth: capabilityHealth.data,
        capabilities: [...capabilities.data.items],
        systemOverview: systemOverview.data,
      })
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  createEffect(
    on(
      () => props.ready(),
      (ready) => {
        if (ready) void refresh()
      },
    ),
  )
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-overview">
      <div class="flex justify-end">
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {t("\u5237\u65B0")}
        </Button>
      </div>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <div class="grid gap-3 md:grid-cols-3">
        <MetricCard
          label={t("Server")}
          value={state.health ? t("\u53EF\u8FDE\u63A5") : state.loading ? t("\u68C0\u67E5\u4E2D") : t("\u672A\u77E5")}
        />
        <MetricCard
          label={t("Agent \u5F15\u64CE")}
          value={state.capabilityHealth?.status ?? (state.loading ? t("\u68C0\u67E5\u4E2D") : t("\u672A\u77E5"))}
        />
        <MetricCard label={t("Agent \u6570\u91CF")} value={state.agents.length} />
      </div>
      <div class="rounded-md border border-border-weak-base p-3">
        <h2 class="text-13-medium text-text-strong">{t("\u80FD\u529B\u6E05\u5355")}</h2>
        <div class="mt-3 grid gap-2 md:grid-cols-2">
          <For each={state.capabilities}>
            {(item) => (
              <article class="rounded-md bg-background-weak p-3">
                <div class="text-12-medium text-text-strong">{item.name}</div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {item.enabled ? "enabled" : "disabled"} · {item.kind} · {item.description}
                </div>
              </article>
            )}
          </For>
        </div>
      </div>
      <Show when={state.systemOverview}>
        {(overview) => (
          <div class="rounded-md border border-border-weak-base p-3">
            <h2 class="text-13-medium text-text-strong">{t("Runtime \u6DF1\u5EA6\u72B6\u6001")}</h2>
            <div class="mt-3 grid gap-2">
              <For each={overview().sections}>
                {(section) => (
                  <details class="rounded-md bg-background-weak p-3">
                    <summary class="cursor-pointer text-12-medium text-text-strong">{section.title}</summary>
                    <pre class="mt-3 max-h-72 select-text overflow-auto whitespace-pre-wrap break-all text-10-regular text-text-weak">
                      {JSON.stringify(section.data, null, 2)}
                    </pre>
                  </details>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}
function ProviderControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
  onNavigate: (value: string) => void
}) {
  const t = useControlCenterText()
  type IntegrationList = Awaited<ReturnType<OperationsApi["integrations"]["list"]>>["data"]
  type CredentialConnection = Extract<
    IntegrationList[number]["connections"][number],
    {
      type: "credential"
    }
  >
  const [state, setState] = createStore({
    loading: false,
    saving: false,
    error: "",
    notice: "",
    integrations: [] as IntegrationList,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "" })
    try {
      const result = await props.api().integrations.list(props.location())
      setState("integrations", [...result.data])
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    setState({ saving: true, error: "", notice: "" })
    try {
      await action()
      await refresh()
      setState("notice", notice)
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("saving", false)
    }
  }
  const rename = (connection: CredentialConnection) => {
    const label = window.prompt(t("\u65B0\u7684\u51ED\u636E\u6807\u7B7E\uFF1A"), connection.label)?.trim()
    if (!label || label === connection.label) return
    void mutate(
      () => props.api().credentials.update({ ...props.location(), credentialID: connection.id, label }),
      t("\u51ED\u636E\u6807\u7B7E\u5DF2\u66F4\u65B0\u3002"),
    )
  }
  const remove = (connection: CredentialConnection) => {
    if (
      !window.confirm(
        t("删除凭据“{{label}}”？依赖该凭据的 Provider 将无法继续调用。", {
          label: connection.label,
        }),
      )
    )
      return
    void mutate(
      () => props.api().credentials.remove({ ...props.location(), credentialID: connection.id }),
      t("\u51ED\u636E\u5DF2\u5220\u9664\u3002"),
    )
  }
  createEffect(
    on(
      () => props.ready(),
      (ready) => {
        if (ready) void refresh()
      },
    ),
  )
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-providers">
      <div class="flex flex-wrap justify-between gap-2">
        <Button type="button" size="small" variant="secondary" onClick={() => props.onNavigate("providers")}>
          {t("\u6253\u5F00\u6A21\u578B\u4E0E Provider \u8BBE\u7F6E")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={state.loading || state.saving}
          onClick={() => void refresh()}
        >
          {t("\u5237\u65B0\u8FDE\u63A5")}
        </Button>
      </div>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <Show when={state.notice}>
        <Notice>{state.notice}</Notice>
      </Show>
      <For each={state.integrations}>
        {(integration) => (
          <article class="rounded-md border border-border-weak-base p-3">
            <div class="text-13-medium text-text-strong">{integration.name}</div>
            <div class="mt-1 text-11-regular text-text-weak">
              {integration.methods.length}
              {t("\u79CD\u8FDE\u63A5\u65B9\u5F0F")}
            </div>
            <div class="mt-3 flex flex-col gap-2">
              <For each={integration.connections}>
                {(connection) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-weak p-2">
                    <div class="text-11-regular text-text-strong">
                      {connection.type === "credential"
                        ? connection.label
                        : t("环境变量 {{name}}", { name: connection.name })}
                    </div>
                    <Show when={connection.type === "credential" ? connection : undefined}>
                      {(credential) => (
                        <div class="flex gap-2">
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.saving}
                            onClick={() => rename(credential())}
                          >
                            {t("\u91CD\u547D\u540D")}
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={state.saving}
                            onClick={() => remove(credential())}
                          >
                            {t("\u5220\u9664\u2026")}
                          </Button>
                        </div>
                      )}
                    </Show>
                  </div>
                )}
              </For>
              <Show when={integration.connections.length === 0}>
                <div class="text-11-regular text-text-weak">{t("\u5C1A\u672A\u8FDE\u63A5\u3002")}</div>
              </Show>
            </div>
          </article>
        )}
      </For>
    </section>
  )
}
function SavedPermissionControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  type SavedRule = Awaited<ReturnType<OperationsApi["permissions"]["listSaved"]>>[number]
  type PendingRequest = Awaited<ReturnType<OperationsApi["permissions"]["listRequests"]>>["data"][number]
  const [state, setState] = createStore({
    loading: false,
    error: "",
    notice: "",
    saved: [] as SavedRule[],
    pending: [] as PendingRequest[],
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "" })
    try {
      const [saved, pending] = await Promise.all([
        props.api().permissions.listSaved(),
        props.api().permissions.listRequests(props.location()),
      ])
      setState({ saved: [...saved], pending: [...pending.data] })
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  const remove = async (rule: SavedRule) => {
    if (
      !window.confirm(
        t("撤销 {{action}} 对 {{resource}} 的持久权限？", {
          action: rule.action,
          resource: rule.resource,
        }),
      )
    )
      return
    try {
      await props.api().permissions.removeSaved({ id: rule.id })
      setState("notice", t("\u6301\u4E45\u6743\u9650\u5DF2\u64A4\u9500\u3002"))
      await refresh()
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    }
  }
  createEffect(
    on(
      () => props.ready(),
      (ready) => {
        if (ready) void refresh()
      },
    ),
  )
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-permissions">
      <div class="flex justify-end">
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {t("\u5237\u65B0")}
        </Button>
      </div>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <Show when={state.notice}>
        <Notice>{state.notice}</Notice>
      </Show>
      <div class="grid gap-3 md:grid-cols-2">
        <MetricCard label={t("\u5F85\u5904\u7406\u8BF7\u6C42")} value={state.pending.length} />
        <MetricCard label={t("\u5DF2\u4FDD\u5B58\u89C4\u5219")} value={state.saved.length} />
      </div>
      <div class="flex flex-col gap-2">
        <For each={state.saved}>
          {(rule) => (
            <article class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-weak-base p-3">
              <div>
                <div class="text-12-medium text-text-strong">{rule.action}</div>
                <div class="mt-1 break-all text-11-regular text-text-weak">{rule.resource}</div>
                <div class="mt-1 text-10-regular text-text-weak">
                  {t("Project:")}
                  {rule.projectID}
                </div>
              </div>
              <Button size="small" variant="ghost" onClick={() => void remove(rule)}>
                {t("\u64A4\u9500\u2026")}
              </Button>
            </article>
          )}
        </For>
        <Show when={!state.loading && state.saved.length === 0}>
          <Notice>{t("\u5F53\u524D\u6CA1\u6709\u6301\u4E45\u6743\u9650\u89C4\u5219\u3002")}</Notice>
        </Show>
      </div>
    </section>
  )
}
function MemoryControl(props: { api: () => OperationsApi; location: () => LocationInput; ready: () => boolean }) {
  const t = useControlCenterText()
  type Page = Awaited<ReturnType<OperationsApi["memories"]["list"]>>
  type Item = Page["items"][number]
  type Facets = Awaited<ReturnType<OperationsApi["memories"]["facets"]>>
  type Quality = Awaited<ReturnType<OperationsApi["memories"]["recallQuality"]>>
  type Semantic = Awaited<ReturnType<OperationsApi["memories"]["semantic"]>>
  const [state, setState] = createStore({
    loading: false,
    saving: false,
    error: "",
    notice: "",
    query: "",
    semantic: false,
    items: [] as Item[],
    selected: [] as Item["id"][],
    facets: undefined as Facets | undefined,
    quality: undefined as Quality | undefined,
    semanticResult: undefined as Semantic | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "", semanticResult: undefined })
    try {
      const [page, facets, quality] = await Promise.all([
        props.api().memories.list({
          ...props.location(),
          ...(state.query.trim() && !state.semantic ? { query: state.query.trim() } : {}),
          includeGlobal: "true",
          limit: 100,
        }),
        props.api().memories.facets({ ...props.location(), includeGlobal: "true" }),
        props.api().memories.recallQuality(props.location()),
      ])
      if (state.semantic && state.query.trim()) {
        const semantic = await props.api().memories.semantic({
          ...props.location(),
          query: state.query.trim(),
          includeGlobal: "true",
          topK: 20,
        })
        setState({
          semanticResult: semantic,
          items: semantic.items.map((hit) => hit.memory),
        })
      } else {
        setState("items", [...page.items])
      }
      setState({ facets, quality })
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  const mutate = async (action: () => Promise<unknown>, notice: string) => {
    if (state.saving) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await action()
      await refresh()
      setState("notice", notice)
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("saving", false)
    }
  }
  const edit = (item: Item) => {
    const content = window.prompt(t("\u7F16\u8F91\u8BB0\u5FC6\u5185\u5BB9\uFF1A"), item.content)?.trim()
    if (!content || content === item.content) return
    void mutate(
      () => props.api().memories.update({ ...props.location(), memoryID: item.id, content }),
      t("\u8BB0\u5FC6\u5DF2\u66F4\u65B0\u3002"),
    )
  }
  const remove = (item: Item) => {
    if (!window.confirm(t("删除记忆 {{id}}？此操作不会删除关联会话。", { id: item.id }))) return
    void mutate(
      () => props.api().memories.delete({ ...props.location(), memoryID: item.id }),
      t("\u8BB0\u5FC6\u5DF2\u5220\u9664\u3002"),
    )
  }
  const removeSelected = () => {
    if (state.selected.length === 0) return
    if (!window.confirm(t("批量删除选中的 {{count}} 条记忆？", { count: state.selected.length }))) return
    void mutate(
      () => props.api().memories.deleteMany({ ...props.location(), ids: state.selected }),
      t("\u9009\u4E2D\u7684\u8BB0\u5FC6\u5DF2\u6279\u91CF\u5220\u9664\u3002"),
    )
    setState("selected", [])
  }
  const toggle = (id: Item["id"]) =>
    setState(
      "selected",
      state.selected.includes(id) ? state.selected.filter((value) => value !== id) : [...state.selected, id],
    )
  createEffect(
    on(
      () => props.ready(),
      (ready) => {
        if (ready) void refresh()
      },
    ),
  )
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-memory">
      <div class="grid gap-3 md:grid-cols-3">
        <MetricCard label={t("\u5F53\u524D\u7ED3\u679C")} value={state.items.length} />
        <MetricCard
          label={t("Top-1 \u53EC\u56DE\u7387")}
          value={state.quality ? `${Math.round(state.quality.top1Rate * 100)}%` : "—"}
        />
        <MetricCard label={t("MRR")} value={state.quality ? state.quality.meanReciprocalRank.toFixed(2) : "—"} />
      </div>
      <form
        class="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void refresh()
        }}
      >
        <input
          class="h-9 min-w-[240px] flex-1 rounded-md border border-border-weak-base bg-background-base px-3 text-12-regular text-text-strong"
          value={state.query}
          onInput={(event) => setState("query", event.currentTarget.value)}
          placeholder={t("\u641C\u7D22\u6301\u4E45\u8BB0\u5FC6")}
        />
        <label class="flex items-center gap-2 text-11-regular text-text-weak">
          <input
            type="checkbox"
            checked={state.semantic}
            onChange={(event) => setState("semantic", event.currentTarget.checked)}
          />
          {t("\u6DF7\u5408\u8BED\u4E49\u68C0\u7D22")}
        </label>
        <Button type="submit" size="small" variant="secondary" disabled={state.loading}>
          {t("\u641C\u7D22")}
        </Button>
        <Button size="small" variant="ghost" disabled={!state.selected.length || state.saving} onClick={removeSelected}>
          {t("\u5220\u9664\u6240\u9009\u2026")}
        </Button>
      </form>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <Show when={state.notice}>
        <Notice>{state.notice}</Notice>
      </Show>
      <Show when={state.facets}>
        {(facets) => (
          <div class="flex flex-wrap gap-2 text-10-regular text-text-weak">
            <For each={facets().types.slice(0, 8)}>
              {(item) => (
                <span class="rounded-full bg-background-weak px-2 py-1">
                  {item.value} · {item.count}
                </span>
              )}
            </For>
            <For each={facets().tags.slice(0, 8)}>
              {(item) => (
                <span class="rounded-full bg-background-weak px-2 py-1">
                  #{item.value} · {item.count}
                </span>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class="flex flex-col gap-2">
        <For each={state.items}>
          {(item) => (
            <article class="rounded-md border border-border-weak-base p-3">
              <div class="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label={t("选择 {{id}}", { id: item.id })}
                  checked={state.selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <div class="min-w-0 flex-1">
                  <div class="whitespace-pre-wrap text-12-regular text-text-strong">{item.content}</div>
                  <div class="mt-2 flex flex-wrap gap-2 text-10-regular text-text-weak">
                    <span>{item.type}</span>
                    <span>{item.scope}</span>
                    <span>
                      {t("importance")}
                      {item.importance}
                    </span>
                    <For each={item.tags}>{(tag) => <span>#{tag}</span>}</For>
                  </div>
                </div>
                <div class="flex shrink-0 gap-2">
                  <Button size="small" variant="ghost" disabled={state.saving} onClick={() => edit(item)}>
                    {t("\u7F16\u8F91")}
                  </Button>
                  <Button size="small" variant="ghost" disabled={state.saving} onClick={() => remove(item)}>
                    {t("\u5220\u9664\u2026")}
                  </Button>
                </div>
              </div>
            </article>
          )}
        </For>
      </div>
      <Show when={state.quality}>{(quality) => <Notice>{quality().caveat}</Notice>}</Show>
    </section>
  )
}
function PrivateOperations(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  type Overview = Awaited<ReturnType<OperationsApi["privateOperations"]["overview"]>>["data"]
  const [state, setState] = createStore({
    loading: false,
    error: "",
    overview: undefined as Overview | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState({ loading: true, error: "" })
    try {
      const result = await props.api().privateOperations.overview(props.location())
      setState("overview", result.data)
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  createEffect(on(() => props.ready(), (ready) => ready && void refresh()))
  const rows = [
    [
      t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5"),
      "arforge doctor --json",
      t(
        "\u53EA\u8BFB\uFF1B\u68C0\u67E5\u7EDF\u4E00\u8FD0\u884C\u65F6\u3001PostgreSQL\u3001\u79C1\u4EBA\u76EE\u5F55\u4E0E Agent",
      ),
    ],
    [
      t("\u4F7F\u7528\u7EDF\u8BA1"),
      "arforge stats",
      t(
        "\u53EA\u8BFB\uFF1B\u4F1A\u626B\u63CF\u6301\u4E45\u4F1A\u8BDD\u7EDF\u8BA1 token\u3001\u6210\u672C\u548C\u5DE5\u5177\u4F7F\u7528",
      ),
    ],
    [
      t("\u51ED\u636E\u626B\u63CF"),
      t("arforge secrets-scan <\u76EE\u5F55> --json"),
      t("\u53EA\u8F93\u51FA\u547D\u4E2D\u7C7B\u522B\u548C\u8DEF\u5F84\uFF0C\u4E0D\u8F93\u51FA\u51ED\u636E\u503C"),
    ],
    [
      t("\u65E5\u5FD7\u4FDD\u7559\u9884\u89C8"),
      "arforge logs-prune 30 --json",
      t("\u9ED8\u8BA4\u53EA\u9884\u89C8\uFF1B\u5B9E\u9645\u5220\u9664\u5FC5\u987B\u663E\u5F0F\u8FFD\u52A0 --apply"),
    ],
    [
      t("PostgreSQL \u5907\u4EFD"),
      "python scripts/postgres_private_backup.py",
      t(
        "\u751F\u6210\u53EF\u6062\u590D\u5907\u4EFD\uFF1B\u5BC6\u7801\u4E0D\u5F97\u8FDB\u5165\u754C\u9762\u6216\u65E5\u5FD7",
      ),
    ],
    [
      t("\u6062\u590D\u6F14\u7EC3"),
      "python scripts/postgres_restore_drill.py",
      t("\u53EA\u5141\u8BB8\u6062\u590D\u5230\u9694\u79BB\u6F14\u7EC3\u5E93\uFF0C\u4E0D\u8986\u76D6\u751F\u4EA7\u5E93"),
    ],
  ] as const
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-private-operations">
      <Notice tone="warning">
        {t(
          "`clear-data`\u3001\u771F\u5B9E\u6570\u636E\u5E93\u6062\u590D\u548C\u65E5\u5FD7\u5B9E\u9645\u5220\u9664\u5C5E\u4E8E\u7BA1\u7406\u6A21\u5F0F\u64CD\u4F5C\u3002\u666E\u901A\u63A7\u5236\u4E2D\u5FC3\u4E0D\u4F1A\u76F4\u63A5\u6267\u884C\u5B83\u4EEC\u3002",
        )}
      </Notice>
      <div class="flex justify-end">
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {t("\u5237\u65B0")}
        </Button>
      </div>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <Show when={state.overview}>
        {(overview) => (
          <>
            <div class="grid gap-3 md:grid-cols-3">
              <MetricCard
                label={t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5")}
                value={`${overview().doctor.passed}/${overview().doctor.checks.length}`}
              />
              <MetricCard label={t("\u4F7F\u7528\u7EDF\u8BA1")} value={`${overview().usage.tokens.total} token`} />
              <MetricCard label="Cost" value={`$${overview().usage.cost.toFixed(4)}`} />
            </div>
            <div class="grid gap-3 xl:grid-cols-2">
              <article class="rounded-md border border-border-weak-base p-3">
                <h3 class="text-12-medium text-text-strong">{t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5")}</h3>
                <div class="mt-2 flex flex-col gap-2">
                  <For each={overview().doctor.checks}>
                    {(check) => (
                      <div class="flex items-start justify-between gap-3 text-11-regular">
                        <span class="text-text-strong">
                          {check.ok ? "✓" : "✗"} {check.label}
                        </span>
                        <span class="text-right text-text-weak">{check.detail}</span>
                      </div>
                    )}
                  </For>
                </div>
              </article>
              <article class="rounded-md border border-border-weak-base p-3">
                <h3 class="text-12-medium text-text-strong">{t("PostgreSQL \u5907\u4EFD")}</h3>
                <div class="mt-2 text-11-regular text-text-weak">
                  <div>{overview().backup.available ? overview().backup.createdAt ?? "✓" : "—"}</div>
                  <div>
                    {overview().backup.database ?? "PostgreSQL"} · {overview().backup.bytes} B · AES-256-CBC{" "}
                    {overview().backup.checksumVerified ? "✓ SHA-256" : "—"}
                  </div>
                  <div>restore list {overview().backup.restoreListVerified ? "✓" : "—"}</div>
                </div>
              </article>
              <article class="rounded-md border border-border-weak-base p-3">
                <h3 class="text-12-medium text-text-strong">{t("\u6062\u590D\u6F14\u7EC3")}</h3>
                <div class="mt-2 text-11-regular text-text-weak">
                  <div>{overview().recoveryDrill.completedAt ?? "—"}</div>
                  <div>
                    {overview().recoveryDrill.tables} tables · {overview().recoveryDrill.sourceRows}/
                    {overview().recoveryDrill.restoredRows} rows · Δ {overview().recoveryDrill.differences}
                  </div>
                </div>
              </article>
              <article class="rounded-md border border-border-weak-base p-3">
                <h3 class="text-12-medium text-text-strong">
                  {t("\u51ED\u636E\u626B\u63CF")} / {t("\u65E5\u5FD7\u4FDD\u7559\u9884\u89C8")}
                </h3>
                <div class="mt-2 text-11-regular text-text-weak">
                  <div>
                    {overview().secrets.filesScanned} files · {overview().secrets.findingFiles} hit files ·{" "}
                    {overview().secrets.findings} signals
                  </div>
                  <div>
                    {overview().logs.files} log files · {overview().logs.bytes} B · {overview().logs.retentionDays} days
                  </div>
                </div>
              </article>
            </div>
          </>
        )}
      </Show>
      <div class="overflow-hidden rounded-md border border-border-weak-base">
        <For each={rows}>
          {(row) => (
            <article class="grid gap-2 border-b border-border-weak-base p-3 last:border-b-0 md:grid-cols-[140px_1fr_1.4fr]">
              <div class="text-12-medium text-text-strong">{row[0]}</div>
              <code class="select-text break-all text-11-regular text-text-strong">{row[1]}</code>
              <div class="text-11-regular text-text-weak">{row[2]}</div>
            </article>
          )}
        </For>
      </div>
    </section>
  )
}
function ProjectCopyControl(props: { api: () => OperationsApi; location: () => LocationInput; info: LocationInfo }) {
  const t = useControlCenterText()
  type CopyEntry = Awaited<ReturnType<OperationsApi["projectCopies"]["list"]>>[number]
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    destination: "",
    entries: [] as CopyEntry[],
    error: "",
    notice: "",
  })
  const load = async () => {
    setState({ loading: true, error: "" })
    try {
      const entries = await props.api().projectCopies.list({
        ...props.location(),
        projectID: props.info.project.id,
      })
      setState("entries", [...entries])
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("loading", false)
    }
  }
  onMount(() => void load())
  const create = async () => {
    const destination = state.destination.trim()
    if (!destination) return
    setState({ saving: true, error: "", notice: "" })
    try {
      const result = await props.api().projectCopies.create({
        ...props.location(),
        projectID: props.info.project.id,
        strategy: "git_worktree",
        directory: destination,
      })
      setState({
        destination: "",
        notice: t("项目副本已创建：{{directory}}", { directory: result.directory }),
      })
      await load()
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("saving", false)
    }
  }
  const refresh = async () => {
    setState({ saving: true, error: "", notice: "" })
    try {
      await props.api().projectCopies.refresh({
        ...props.location(),
        projectID: props.info.project.id,
      })
      await load()
      setState(
        "notice",
        t("\u5DF2\u6839\u636E Git worktree \u4E8B\u5B9E\u5237\u65B0\u9879\u76EE\u526F\u672C\u767B\u8BB0\u3002"),
      )
    } catch (error) {
      setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      setState("saving", false)
    }
  }
  const remove = async (directory: string) => {
    if (!window.confirm(t("移除项目副本 {{directory}}？未提交修改会阻止非强制移除。", { directory }))) return
    setState({ saving: true, error: "", notice: "" })
    try {
      await props.api().projectCopies.remove({
        ...props.location(),
        projectID: props.info.project.id,
        directory,
        force: false,
      })
      await load()
      setState("notice", t("\u9879\u76EE\u526F\u672C\u5DF2\u5B89\u5168\u79FB\u9664\u3002"))
    } catch (error) {
      setState(
        "error",
        t("{{error}}。如确需强制移除，请在专用管理流程中检查未提交修改后执行。", {
          error: publicError(error, t("Unknown control-center error")),
        }),
      )
    } finally {
      setState("saving", false)
    }
  }
  return (
    <section class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-13-medium text-text-strong">{t("\u9879\u76EE\u526F\u672C / Git worktree")}</h2>
          <p class="mt-1 text-11-regular text-text-weak">
            {t("\u5F53\u524D\u9879\u76EE")}
            {props.info.project.id}
            {t(
              "\u3002\u521B\u5EFA\u548C\u79FB\u9664\u90FD\u901A\u8FC7 Project Copy \u670D\u52A1\uFF0C\u4E0D\u76F4\u63A5\u64CD\u4F5C\u6587\u4EF6\u7CFB\u7EDF\u3002",
            )}
          </p>
        </div>
        <Button size="small" variant="ghost" disabled={state.saving} onClick={() => void refresh()}>
          {t("\u5237\u65B0\u767B\u8BB0")}
        </Button>
      </div>
      <div class="flex flex-wrap gap-2">
        <input
          class="h-9 min-w-[280px] flex-1 rounded-md border border-border-weak-base bg-background-base px-3 text-12-regular text-text-strong"
          value={state.destination}
          onInput={(event) => setState("destination", event.currentTarget.value)}
          placeholder={t("\u65B0 worktree \u7684\u7EDD\u5BF9\u76EE\u5F55")}
        />
        <Button
          size="small"
          variant="secondary"
          disabled={state.saving || !state.destination.trim()}
          onClick={() => void create()}
        >
          {t("\u521B\u5EFA\u526F\u672C")}
        </Button>
      </div>
      <Show when={state.loading}>
        <p class="text-11-regular text-text-weak">
          {t("\u6B63\u5728\u8BFB\u53D6\u9879\u76EE\u526F\u672C\u767B\u8BB0\u2026")}
        </p>
      </Show>
      <For each={state.entries.filter((entry) => entry.type === "copy")}>
        {(entry) => (
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-weak p-2">
            <div class="flex min-w-0 flex-col gap-1">
              <code class="select-text break-all text-11-regular">{entry.directory}</code>
              <span class="text-10-regular text-text-weak">
                {entry.strategy ?? t("\u5DF2\u767B\u8BB0\u526F\u672C")}
              </span>
            </div>
            <Button size="small" variant="ghost" disabled={state.saving} onClick={() => void remove(entry.directory)}>
              {t("\u79FB\u9664\u2026")}
            </Button>
          </div>
        )}
      </For>
      <Show when={!state.loading && state.entries.every((entry) => entry.type !== "copy")}>
        <p class="text-11-regular text-text-weak">
          {t("\u5F53\u524D\u6CA1\u6709\u5DF2\u767B\u8BB0\u7684\u9879\u76EE\u526F\u672C\u3002")}
        </p>
      </Show>
      <Show when={state.error}>
        <Notice tone="warning">{state.error}</Notice>
      </Show>
      <Show when={state.notice}>
        <Notice>{state.notice}</Notice>
      </Show>
    </section>
  )
}
function CapabilityCoverage() {
  const t = useControlCenterText()
  const total = CONTROL_CENTER_CAPABILITY_MAP.reduce((sum, entry) => sum + entry.methods.length, 0)
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-coverage">
      <div class="grid gap-3 md:grid-cols-3">
        <MetricCard label={t("\u5DF2\u767B\u8BB0 API \u65B9\u6CD5")} value={total} />
        <MetricCard label={t("\u672A\u5F52\u5C5E")} value={0} />
        <MetricCard label={t("\u91CD\u590D\u5F52\u5C5E")} value={0} />
      </div>
      <For each={CONTROL_CENTER_CAPABILITY_MAP}>
        {(entry) => (
          <article class="rounded-md border border-border-weak-base p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="text-12-medium text-text-strong">{entry.feature}</div>
              <div class="text-10-regular text-text-weak">
                {entry.surface} · {entry.risk} · {entry.methods.length}
              </div>
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <For each={entry.methods}>
                {(method) => <code class="rounded bg-background-weak px-1.5 py-1 text-10-regular">{method}</code>}
              </For>
            </div>
          </article>
        )}
      </For>
    </section>
  )
}
function MetricCard(props: { label: string; value: string | number }) {
  const t = useControlCenterText()
  return (
    <div class="rounded-md border border-border-weak-base bg-background-base p-3">
      <div class="text-10-regular text-text-weak">{props.label}</div>
      <div class="mt-1 text-16-medium text-text-strong">{props.value}</div>
    </div>
  )
}
function Notice(props: { tone?: "normal" | "warning"; children: JSX.Element }) {
  return (
    <div
      role={props.tone === "warning" ? "alert" : "status"}
      aria-live={props.tone === "warning" ? "assertive" : "polite"}
      aria-atomic="true"
      class="rounded-md border p-3 text-11-regular"
      classList={{
        "border-border-weak-base bg-background-weak text-text-weak": props.tone !== "warning",
        "border-border-warning bg-background-base text-text-warning": props.tone === "warning",
      }}
    >
      {props.children}
    </div>
  )
}
