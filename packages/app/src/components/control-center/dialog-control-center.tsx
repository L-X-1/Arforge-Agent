import { ManagementViews, type ManagementView } from "./management-views"
import { McpManagement } from "./mcp-management"
import { ManagementDangerZone } from "./management-danger-zone"
import { ManagementDetail } from "./management-detail"
import { ManagementCollection } from "./management-collection"
import { useManagementSessionNavigation } from "./management-source-navigation"
import { managementListPage, memoryListPreview } from "./memory-list-presentation"
import { useConfirmAction } from "@/components/confirm-action"
import { createManagementConfirmationGuard } from "./management-confirmation"
import { bindManagementApi, createManagementScope } from "@/components/settings-v2/management-async"
import { managementErrorText } from "@/components/settings-v2/management-state"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import "@/components/settings-v2/management-review.css"
import { useControlCenterText } from "@/components/control-center/control-center-text"
import { Button } from "@arforge-ai/ui/button"
import { TabsV2 } from "@arforge-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, on, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard, type ScopeRequestToken } from "@/utils/scope-request"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { CONTROL_CENTER_CAPABILITY_MAP } from "@/capabilities/control-center-map"
import { SessionExtensionControl } from "@/components/session/session-extension-control"
import { SessionRunHistory } from "@/components/session/session-run-history"
import { AgentDeepDiagnostics } from "./agent-deep-diagnostics"
import { AgentExtensionInsights } from "./agent-extension-insights"
import {
  DiagnosticsWorkbench,
  MemoryLearningGovernance,
  createWorkbenchReads,
  WorkbenchReadStatus,
  useWorkbenchWriteReason,
} from "./capability-workbench"
import { ManagementActionToolbar } from "./management-action-toolbar"
import "./workbench-detail-polish.css"
import { EvolutionWorkbench } from "./evolution-workbench"
import { ExperienceCandidateWorkbench, SkillLifecycleWorkbench, TenantPlatformWorkbench } from "./governance-workbench"
import { RuntimeInsightWorkbench } from "./runtime-insight-workbench"
import { PersonalWorkspaceNavigation } from "./personal-workspace-navigation"
import { parseCustomAgentAdmissionSection } from "./custom-agent-admission-presentation"
import "./control-center.css"
type LocationInfo = Awaited<ReturnType<OperationsApi["location"]["get"]>>
type LocationInput = {
  location: {
    directory: string
    workspace?: string
  }
}
const publicError = managementErrorText
type ArforgeSettingsProps = {
  value: string
  sessionID?: string
  onNavigate: (value: string) => void
}

export function ArforgeSettingsPanels(props: ArforgeSettingsProps) {
  const serverSDK = useServerSDK()
  return (
    <Show when={serverSDK()} keyed>
      {(sdk) => <ArforgeSettingsContent {...props} sdk={sdk} />}
    </Show>
  )
}

function ArforgeSettingsContent(props: ArforgeSettingsProps & { sdk: ServerSDK }) {
  const t = useControlCenterText()
  const language = useLanguage()
  const viewLabel = (zh: string, zht: string, en: string) =>
    language.locale() === "zh" ? zh : language.locale() === "zht" ? zht : en
  const serverSDK = useServerSDK()
  const [state, setState] = createStore({
    loading: true,
    error: "",
    location: undefined as LocationInfo | undefined,
  })
  const scope = createManagementScope(props.sdk, "", () => ({ source: serverSDK(), sessionID: "" }))
  onCleanup(scope.dispose)
  const scopedAPI = bindManagementApi(props.sdk.operationsApi, scope)
  const api = () => scopedAPI
  const location = createMemo<LocationInput>(() => ({
    location: {
      directory: state.location?.directory ?? "",
      ...(state.location?.workspaceID ? { workspace: state.location.workspaceID } : {}),
    },
  }))
  const personalWorkspaceSession = createMemo(() => (props.value === "arforge-workspace" ? props.sessionID : undefined))
  const loadLocation = async () => {
    if (!scope.live()) return
    const current = scope.next("personal-workspace-location")
    const targetSession = personalWorkspaceSession()
    setState({ loading: true, error: "" })
    try {
      // Canonical session navigation resolves its own directory. Re-entering
      // Personal Workspace must use that session source, not the server default.
      const session = targetSession ? await api().sessions.get({ sessionID: targetSession }) : undefined
      if (!current()) return
      const next = await api().location.get(
        session
          ? {
              location: {
                directory: session.location.directory,
                ...(session.location.workspaceID ? { workspace: session.location.workspaceID } : {}),
              },
            }
          : undefined,
      )
      if (current()) setState("location", next)
    } catch (error) {
      if (current()) setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      if (current()) setState("loading", false)
    }
  }
  onMount(() => void loadLocation())
  createEffect(on(personalWorkspaceSession, () => void loadLocation(), { defer: true }))
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
  const views_arforge_integrations: ManagementView[] = [
    {
      id: "providers",
      label: () => t("模型与服务商（Provider）"),
      render: () => (
        <ProviderControl
          api={api}
          location={location}
          ready={() => !state.loading && !!state.location}
          onNavigate={props.onNavigate}
        />
      ),
    },
    {
      id: "mcp",
      label: () => "MCP",
      render: () => (
        <McpManagement
          api={api}
          location={location}
          sessionID={props.sessionID}
          ready={() => !state.loading && !!state.location}
        />
      ),
    },
  ]
  const views_arforge_memory: ManagementView[] = [
    {
      id: "entries",
      label: () => t("记忆与学习（Memory / Learning）"),
      render: () => <MemoryControl api={api} location={location} ready={() => !state.loading && !!state.location} />,
    },
    {
      id: "governance",
      label: () => viewLabel("学习与召回", "學習與召回", "Learning and recall"),
      render: () => (
        <MemoryLearningGovernance
          api={api}
          location={location}
          sessionID={props.sessionID}
          ready={() => !state.loading && !!state.location}
        />
      ),
    },
  ]
  const views_arforge_evolution: ManagementView[] = [
    {
      id: "evolution",
      label: () => t("受控自主进化"),
      render: () => (
        <EvolutionWorkbench api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
    {
      id: "experience",
      label: () => viewLabel("经验候选", "經驗候選", "Experience candidates"),
      render: () => (
        <ExperienceCandidateWorkbench api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
  ]
  const views_arforge_extensions: ManagementView[] = [
    {
      id: "catalog",
      label: () => t("Workflow, plugin, and skill management"),
      render: () => (
        <Show when={!state.loading && state.location}>
          <SessionExtensionControl api={api} location={location} sessionID={props.sessionID} />
        </Show>
      ),
    },
    {
      id: "insights",
      label: () => t("Agent 扩展语义层"),
      render: () => (
        <AgentExtensionInsights api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
    {
      id: "lifecycle",
      label: () => viewLabel("技能生命周期", "技能生命週期", "Skill lifecycle"),
      render: () => (
        <SkillLifecycleWorkbench api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
  ]
  const views_arforge_diagnostics: ManagementView[] = [
    {
      id: "history",
      label: () => t("诊断与运行报告"),
      render: () => (
        <Show when={!state.loading && state.location}>
          <SessionRunHistory api={api} location={location} />
        </Show>
      ),
    },
    {
      id: "deep",
      label: () => t("Agent 深度诊断"),
      render: () => (
        <AgentDeepDiagnostics api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
    {
      id: "queries",
      label: () => t("诊断与运行报告"),
      render: () => (
        <DiagnosticsWorkbench api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
  ]
  const views_arforge_operations: ManagementView[] = [
    {
      id: "copy",
      label: () => viewLabel("项目复制", "專案複製", "Project copy"),
      render: () => (
        <Show when={state.location}>
          {(value) => <ProjectCopyControl api={api} location={location} info={value()} />}
        </Show>
      ),
    },
    {
      id: "operations",
      label: () => t("数据库与本地运维"),
      render: () => (
        <PrivateOperations api={api} location={location} ready={() => !state.loading && !!state.location} />
      ),
    },
    {
      id: "tenant",
      label: () => viewLabel("租户与数据治理", "租戶與資料治理", "Tenant and data governance"),
      render: () => (
        <TenantPlatformWorkbench
          api={api}
          scopeKey={() =>
            `${props.sdk.url}\u0000${state.location?.directory ?? ""}\u0000${state.location?.workspaceID ?? ""}`
          }
          ready={() => !state.loading && !!state.location}
        />
      ),
    },
  ]
  return (
    <>
      <Show when={props.value === "arforge-workspace"}>
        <ControlPanel
          {...panelProps(
            "arforge-workspace",
            t("个人工作区"),
            t(
              "统一查看项目（Project）、工作区（Location）、会话（Session）、任务（Task）、运行记录（Run）与后台任务的安全状态。",
            ),
          )}
        >
          <PersonalWorkspaceNavigation
            sdk={props.sdk}
            live={scope.live}
            api={api}
            location={location}
            ready={() => !state.loading && !state.error && !!state.location}
            sessionID={props.sessionID}
            onNavigate={props.onNavigate}
          />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-overview"}>
        <ControlPanel
          {...panelProps(
            "arforge-overview",
            t("系统概览"),
            t("查看 Server、当前工作区和 Agent 引擎是否正常；此页面不会修改数据。"),
          )}
        >
          <SystemOverview
            api={api}
            location={location}
            ready={() => !state.loading && !!state.location}
            onNavigate={props.onNavigate}
          />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-integrations"}>
        <ControlPanel
          {...panelProps(
            "arforge-integrations",
            t("模型与服务商（Provider）"),
            t("管理模型服务连接和凭据；具体模型选择仍在“模型”设置中完成。"),
          )}
        >
          <ManagementViews label={"arforge-integrations"} views={views_arforge_integrations} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-permissions"}>
        <ControlPanel
          {...panelProps(
            "arforge-permissions",
            t("权限与安全"),
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
            t("记忆与学习（Memory / Learning）"),
            t("查看、搜索和管理当前工作区长期保留的记忆，并检查召回质量。"),
          )}
        >
          <ManagementViews label={"arforge-memory"} views={views_arforge_memory} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-evolution"}>
        <ControlPanel
          {...panelProps(
            "arforge-evolution",
            t("受控自主进化"),
            t("审查学习证据提出的策略候选，并通过隔离评测、人工批准、灰度和回滚治理能力变化。"),
          )}
        >
          <ManagementViews label={"arforge-evolution"} views={views_arforge_evolution} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-runtime"}>
        <ControlPanel
          {...panelProps(
            "arforge-runtime",
            t("运行时透视"),
            t("上下文分层编译、模型路由决策、独立验证、审计链与运行状态的可视化。"),
          )}
        >
          <RuntimeInsightWorkbench
            api={api}
            location={location}
            sessionID={props.sessionID}
            ready={() => !state.loading && !!state.location}
          />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-extensions"}>
        <ControlPanel
          {...panelProps(
            "arforge-extensions",
            t("工作流、插件与技能（Workflow / Plugin / Skill）"),
            t("运行 Workflow，管理 Plugin 和 Skill；安装与启用分开确认，并通过同一 typed Server API 执行。"),
          )}
        >
          <ManagementViews label={"arforge-extensions"} views={views_arforge_extensions} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-diagnostics"}>
        <ControlPanel
          {...panelProps(
            "arforge-diagnostics",
            t("诊断与运行报告"),
            t("查看真实运行记录和诊断结果；报告只读取现有数据。"),
          )}
        >
          <ManagementViews label={"arforge-diagnostics"} views={views_arforge_diagnostics} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-operations"}>
        <ControlPanel
          {...panelProps(
            "arforge-operations",
            t("数据库与本地运维"),
            t("破坏性运维不伪装成普通按钮；此处明确展示当前安全入口和执行边界。"),
          )}
        >
          <ManagementViews label={"arforge-operations"} views={views_arforge_operations} />
        </ControlPanel>
      </Show>
      <Show when={props.value === "arforge-coverage"}>
        <ControlPanel
          {...panelProps(
            "arforge-coverage",
            t("开发者：能力映射"),
            t("供开发者核对前端功能与 Server API 的覆盖关系。"),
          )}
        >
          <CapabilityCoverage onNavigate={props.onNavigate} />
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
    <TabsV2.Content
      value={props.value}
      class="settings-v2-panel arforge-control-center-panel"
      aria-busy={props.context().loading}
    >
      <header class="settings-v2-tab-header arforge-control-center-header" data-management-toolbar>
        <h2 class="settings-v2-tab-title">{props.title}</h2>
        <p class="arforge-control-center-description">{props.description}</p>
        <div class="arforge-control-center-context" data-management-scope>
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
        <ManagementStatus
          loading={props.context().loading}
          initialLoading={props.context().loading && !props.context().directory}
          error={props.context().error}
          scope={props.context().directory}
          onRetry={() => void props.onRefresh()}
        />
        <Show when={props.context().directory}>{props.children}</Show>
      </div>
    </TabsV2.Content>
  )
}
export function SystemOverview(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
  onNavigate?: (value: string) => void
}) {
  const t = useControlCenterText()
  const language = useLanguage()
  const reads = createWorkbenchReads([
    "health",
    "agents",
    "capabilityHealth",
    "capabilities",
    "systemOverview",
  ] as const)
  type ReadKey = (typeof reads.parts)[number]["key"]
  const [state, setState] = createStore({
    loading: false,
    saving: false,
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
  const locationScopeKey = () => {
    const value = props.location().location
    return `${value.directory}\u0000${value.workspace ?? ""}`
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let refreshQueued = false
  let activeRequest: ScopeRequestToken | undefined
  const refresh = async (force = false, only?: ReadKey) => {
    if (!props.ready()) return
    if (activeRequest && !force) {
      refreshQueued = true
      return
    }
    if (force) refreshQueued = false
    scopeGuard.current()
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    activeRequest = request
    setState("loading", true)
    const api = props.api()
    const current = () => scopeGuard.isCurrent(request)
    try {
      await Promise.all([
        !only || only === "health"
          ? reads.read(
              "health",
              () => api.health.get(),
              (value) => setState("health", value),
              current,
            )
          : undefined,
        !only || only === "agents"
          ? reads.read(
              "agents",
              () => api.agents.list(requestedLocation),
              (value) => setState("agents", [...value.data]),
              current,
            )
          : undefined,
        !only || only === "capabilityHealth"
          ? reads.read(
              "capabilityHealth",
              () => api.agentCapabilities.health(requestedLocation),
              (value) => setState("capabilityHealth", value.data),
              current,
            )
          : undefined,
        !only || only === "capabilities"
          ? reads.read(
              "capabilities",
              () => api.agentCapabilities.list(requestedLocation),
              (value) => setState("capabilities", [...value.data.items]),
              current,
            )
          : undefined,
        !only || only === "systemOverview"
          ? reads.read(
              "systemOverview",
              () => api.agentCapabilities.systemOverview(requestedLocation),
              (value) => setState("systemOverview", value.data),
              current,
            )
          : undefined,
      ])
    } finally {
      if (activeRequest !== request) return
      activeRequest = undefined
      setState("loading", false)
      if (refreshQueued && props.ready()) {
        refreshQueued = false
        void refresh()
      }
    }
  }
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => `${props.ready() ? "ready" : "not-ready"}\u0000${locationScopeKey()}`,
      (scopeKey) => {
        scopeGuard.current()
        const currentScopeKey = locationScopeKey()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== currentScopeKey
        previousScopeKey = currentScopeKey
        refreshQueued = false
        if (!props.ready()) {
          scopeGuard.invalidate()
          reads.invalidate()
          activeRequest = undefined
          setState("loading", false)
          return
        }
        if (scopeChanged) {
          reads.reset()
          setState({
            loading: false,
            error: "",
            health: undefined,
            agents: [],
            capabilityHealth: undefined,
            capabilities: [],
            systemOverview: undefined,
          })
        }
        void refresh(scopeChanged)
      },
    ),
  )
  const labels = () =>
    language.locale().startsWith("zh")
      ? {
          objects: "系统对象",
          available: "已启用",
          disabled: "未启用",
          details: "原始状态数据",
          diag: "查看诊断",
          runtime: "查看运行时",
          workspace: "查看工作区",
          source: "来源",
          updated: "上次读取",
          state: "状态",
        }
      : {
          objects: "System objects",
          available: "Enabled",
          disabled: "Disabled",
          details: "Raw status data",
          diag: "Open diagnostics",
          runtime: "Open runtime",
          workspace: "Open workspace",
          source: "Source",
          updated: "Last read",
          state: "Status",
        }
  const objects = createMemo(() => [
    ...state.capabilities.map((capability) => ({
      kind: "capability" as const,
      id: capability.name,
      title: capability.name,
      capability,
    })),
    ...(state.systemOverview?.sections.map((section) => ({
      kind: "section" as const,
      id: section.id,
      title: section.title,
      section,
    })) ?? []),
  ])
  return (
    <section
      data-workbench-detail=""
      class="flex flex-col gap-4"
      data-testid="control-center-overview"
      aria-busy={state.loading}
    >
      <div class="arforge-management-detail-actions">
        <Button size="small" variant="ghost" disabled={state.loading} onClick={() => void refresh()}>
          {t("刷新")}
        </Button>
        <Show when={props.onNavigate}>
          <Button size="small" variant="secondary" onClick={() => props.onNavigate?.("arforge-diagnostics")}>
            {labels().diag}
          </Button>
          <Button size="small" variant="secondary" onClick={() => props.onNavigate?.("arforge-runtime")}>
            {labels().runtime}
          </Button>
          <Button size="small" variant="secondary" onClick={() => props.onNavigate?.("arforge-workspace")}>
            {labels().workspace}
          </Button>
        </Show>
      </div>
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={(key) =>
          key === "health"
            ? t("Server")
            : key === "agents"
              ? t("Agent 数量")
              : key === "capabilityHealth"
                ? t("Agent 引擎")
                : key === "capabilities"
                  ? t("能力清单")
                  : t("Runtime 深度状态")
        }
        retry={(key) => void refresh(false, key)}
      />
      <div class="arforge-management-metrics">
        <MetricCard label={t("Server")} value={state.health ? t("可连接") : state.loading ? t("检查中") : t("未知")} />
        <MetricCard
          label={t("Agent 引擎")}
          value={state.capabilityHealth?.status ?? (state.loading ? t("检查中") : t("未知"))}
        />
        <MetricCard
          label={t("Agent 数量")}
          value={reads.parts.find((part) => part.key === "agents")?.loaded ? state.agents.length : "—"}
        />
      </div>
      <ManagementCollection
        label={labels().objects}
        scope={locationScopeKey()}
        scopeLabel={props.location().location.directory}
        items={objects()}
        identity={(item) => `${item.kind}:${item.id}`}
        title={(item) => item.title}
        description={(item) => (item.kind === "capability" ? item.capability.description : item.section.id)}
        status={(item) =>
          item.kind === "capability" ? (
            <span class="arforge-management-search-scope">
              {item.capability.enabled ? labels().available : labels().disabled}
            </span>
          ) : undefined
        }
      >
        {(item) => (
          <div class="flex flex-col gap-4">
            <dl class="arforge-management-definition">
              <div>
                <dt>{labels().source}</dt>
                <dd>
                  <code>{props.location().location.directory}</code>
                </dd>
              </div>
              <div>
                <dt>ID</dt>
                <dd>
                  <code>{item.id}</code>
                </dd>
              </div>
              <Show when={item.kind === "capability" ? item.capability : undefined}>
                {(capability) => (
                  <>
                    <div>
                      <dt>{labels().state}</dt>
                      <dd>
                        {capability().enabled ? labels().available : labels().disabled} · {capability().kind}
                      </dd>
                    </div>
                    <div>
                      <dt>{item.title}</dt>
                      <dd>{capability().description}</dd>
                    </div>
                  </>
                )}
              </Show>
            </dl>
            <Show when={item.kind === "section" ? item.section : undefined}>
              {(section) => (
                <>
                  <Show
                    when={
                      section().id === "subagent-roles" ? parseCustomAgentAdmissionSection(section().data) : undefined
                    }
                  >
                    {(value) => (
                      <div class="mt-3 grid gap-2" data-testid="custom-agent-admission-card">
                        <div class="grid gap-2 text-11-regular text-text-weak sm:grid-cols-3">
                          <span>profiles · {value().count}</span>
                          <span>errors · {value().errors.length}</span>
                          <span>truncated · {String(value().truncated)}</span>
                        </div>
                        <For each={value().items}>
                          {(item) => (
                            <article class="rounded-md border border-border-weak-base p-2 text-11-regular">
                              <div class="flex flex-wrap items-center justify-between gap-2">
                                <code class="text-text-strong">{item.role}</code>
                                <span class={item.decision === "admitted" ? "text-text-success" : "text-text-warning"}>
                                  {item.decision} · {item.status}
                                </span>
                              </div>
                              <p class="mt-1 text-text-weak">{item.reason}</p>
                              <div class="flex flex-wrap gap-2 text-10-regular text-text-weak">
                                <span>declared {item.declared_tool_count}</span>
                                <span>canonical {item.canonical_tool_count}</span>
                                <span>unsupported {item.unsupported_tool_count}</span>
                                <Show when={item.descriptor_digest}>
                                  {(digest) => <code title={digest()}>{digest().slice(0, 12)}…</code>}
                                </Show>
                              </div>
                              <Show when={item.violations.length > 0}>
                                <ul class="mt-1 list-disc pl-4 text-10-regular text-text-warning">
                                  <For each={item.violations}>{(violation) => <li>{violation}</li>}</For>
                                </ul>
                              </Show>
                            </article>
                          )}
                        </For>
                        <For each={value().errors}>
                          {(error) => (
                            <div class="text-10-regular text-text-warning">
                              {error.file}: {error.error}
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                  <details class="arforge-management-raw-details">
                    <summary>{labels().details}</summary>
                    <pre>{JSON.stringify(section().data, null, 2)}</pre>
                  </details>
                </>
              )}
            </Show>
          </div>
        )}
      </ManagementCollection>
    </section>
  )
}
export function ProviderControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
  onNavigate: (value: string) => void
}) {
  const t = useControlCenterText()
  const confirmAction = useConfirmAction()
  const reads = createWorkbenchReads(["connections"] as const)
  type ReadKey = (typeof reads.parts)[number]["key"]
  const writeReason = useWorkbenchWriteReason()
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
    inspectedIntegration: "",
    integrationDetailOpen: 0,
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const captureConfirmation = createManagementConfirmationGuard({
    source: props.api,
    key: () => `${props.ready()}\u0000${locationScopeKey()}`,
    blocked: () => !props.ready() || state.loading || state.saving || !reads.fresh(),
    invalidate: scopeGuard.invalidate,
  })
  const canWrite = () => props.ready() && !state.loading && !state.saving && reads.fresh()
  const inspectedIntegration = createMemo(() =>
    state.integrations.find((item) => item.id === state.inspectedIntegration),
  )
  let previousScopeKey: string | undefined

  const refresh = async (
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
    only?: ReadKey,
  ) => {
    if (!props.ready() || state.loading) return
    setState("loading", true)
    const api = props.api()
    const current = () => scopeGuard.isCurrent(request)
    try {
      await reads.read(
        "connections",
        () => api.integrations.list(requestedLocation),
        (value) => setState("integrations", [...value.data]),
        current,
      )
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const mutate = async (
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<unknown>,
    notice: string,
  ) => {
    if (!canWrite()) return
    const requestedLocation = props.location()
    const request = scopeGuard.capture()
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      await action(requestedLocation, request)
      if (!scopeGuard.isCurrent(request)) return
      await refresh(requestedLocation, request)
      if (scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("saving", false)
    }
  }
  const rename = (connection: CredentialConnection) => {
    const label = window.prompt(t("\u65B0\u7684\u51ED\u636E\u6807\u7B7E\uFF1A"), connection.label)?.trim()
    if (!label || label === connection.label) return
    void mutate(
      (location) => props.api().credentials.update({ ...location, credentialID: connection.id, label }),
      t("\u51ED\u636E\u6807\u7B7E\u5DF2\u66F4\u65B0\u3002"),
    )
  }
  const remove = async (connection: CredentialConnection) => {
    const confirmation = captureConfirmation()
    const request = scopeGuard.capture()
    const requestedLocation = { location: { ...props.location().location } }
    const credentialID = connection.id
    const label = connection.label
    const isCurrent = () =>
      confirmation.canWrite() &&
      scopeGuard.isCurrent(request) &&
      state.integrations.some((integration) =>
        integration.connections.some(
          (item) => item.type === "credential" && item.id === credentialID && item.label === label,
        ),
      )
    if (!isCurrent()) return
    if (
      !(await confirmAction(t("删除凭据“{{label}}”？依赖该凭据的 Provider 将无法继续调用。", { label }), {
        isCurrent,
        danger: true,
      }))
    )
      return
    if (!isCurrent()) return
    await mutate(
      () => confirmation.source.credentials.remove({ ...requestedLocation, credentialID }),
      t("\u51ED\u636E\u5DF2\u5220\u9664\u3002"),
    )
  }
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        // Observe the source change before the new read captures its token.
        captureConfirmation()
        scopeGuard.current()
        const currentScopeKey = locationScopeKey()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== currentScopeKey
        previousScopeKey = currentScopeKey
        if (!props.ready()) {
          reads.invalidate()
          setState({ loading: false, saving: false })
          return
        }
        if (scopeChanged) {
          reads.reset()
          setState({ loading: false, saving: false, error: "", notice: "", integrations: [], inspectedIntegration: "" })
        }
        void refresh()
      },
    ),
  )
  return (
    <section
      data-workbench-detail=""
      class="flex flex-col gap-4"
      data-testid="control-center-providers"
      aria-busy={state.loading || state.saving}
    >
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
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={(key) => t("\u5237\u65B0\u8FDE\u63A5")}
        retry={(key) => void refresh(props.location(), scopeGuard.capture(), key)}
      />
      <ManagementStatus saving={state.saving} error={state.error} />
      <ManagementStatus notice={state.notice} />
      <p class="workbench-detail-disabled-reason" role="status">
        {writeReason(state.loading || state.saving, reads.fresh())}
      </p>
      <ManagementStatus
        empty={props.ready() && !state.loading && reads.fresh() && state.integrations.length === 0}
        onRetry={() => void refresh()}
      />
      <div class="arforge-management-master-detail" data-testid="integration-master-detail">
        <div class="arforge-management-master-content">
          <div class="arforge-management-entity-list">
            <For each={state.integrations}>
              {(integration) => (
                <div class="arforge-management-entity-row" data-density="double">
                  <button
                    type="button"
                    class="arforge-management-entity-select"
                    data-management-detail-id={integration.id}
                    onClick={() =>
                      setState({
                        inspectedIntegration: integration.id,
                        integrationDetailOpen: state.integrationDetailOpen + 1,
                      })
                    }
                  >
                    <span class="arforge-management-entity-preview">{integration.name}</span>
                    <span class="arforge-management-entity-meta">
                      <code>{integration.id}</code>
                      <span>
                        {integration.methods.length}
                        {t("\u79CD\u8FDE\u63A5\u65B9\u5F0F")}
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>
        <Show when={inspectedIntegration()}>
          {(integration) => (
            <ManagementDetail
              identity={integration().id}
              openRequest={state.integrationDetailOpen}
              title={integration().name}
            >
              <article>
                <div class="text-13-medium text-text-strong">{integration().name}</div>
                <div class="mt-1 text-11-regular text-text-weak">
                  {integration().methods.length}
                  {t("\u79CD\u8FDE\u63A5\u65B9\u5F0F")}
                </div>
                <div class="mt-3 flex flex-col gap-2">
                  <For each={integration().connections}>
                    {(connection) => (
                      <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-weak p-2">
                        <div class="text-11-regular text-text-strong">
                          {connection.type === "credential"
                            ? connection.label
                            : t("环境变量 {{name}}", { name: connection.name })}
                        </div>
                        <Show when={connection.type === "credential" ? connection : undefined}>
                          {(credential) => (
                            <ManagementActionToolbar
                              actions={[
                                {
                                  id: "rename-credential",
                                  label: t("\u91CD\u547D\u540D"),
                                  run: () => rename(credential()),
                                  disabled: !canWrite(),
                                },
                              ]}
                              disabledReason={writeReason(state.loading || state.saving, reads.fresh())}
                            />
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={integration().connections.length === 0}>
                    <div class="text-11-regular text-text-weak">{t("\u5C1A\u672A\u8FDE\u63A5\u3002")}</div>
                  </Show>
                </div>
                <Show when={integration().connections.some((connection) => connection.type === "credential")}>
                  <ManagementDangerZone scope={`${props.location().location.directory} · ${integration().name}`}>
                    <For each={integration().connections}>
                      {(connection) => (
                        <Show when={connection.type === "credential" ? connection : undefined}>
                          {(credential) => (
                            <ManagementActionToolbar
                              actions={[
                                {
                                  id: "delete-credential",
                                  label: `${t("\u5220\u9664\u2026")} ${credential().label}`,
                                  run: () => remove(credential()),
                                  disabled: !canWrite(),
                                  danger: true,
                                },
                              ]}
                              disabledReason={writeReason(state.loading || state.saving, reads.fresh())}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </ManagementDangerZone>
                </Show>
              </article>
            </ManagementDetail>
          )}
        </Show>
      </div>
    </section>
  )
}
export function SavedPermissionControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  const confirmAction = useConfirmAction()
  const language = useLanguage()
  const openSession = useManagementSessionNavigation(props.api)
  const labels = () =>
    language.locale().startsWith("zh")
      ? {
          list: "待处理请求与已保存规则",
          pending: "待处理",
          saved: "已保存",
          action: "操作",
          source: "来源会话",
          sourceMessage: "来源消息 / 工具调用",
          resource: "资源与范围",
          open: "打开来源会话处理",
          opening: "正在定位来源…",
          human: "需要人工确认",
        }
      : {
          list: "Pending requests and saved rules",
          pending: "Pending",
          saved: "Saved",
          action: "Action",
          source: "Source Session",
          sourceMessage: "Source message / tool call",
          resource: "Resources and scope",
          open: "Open source Session",
          opening: "Resolving source…",
          human: "Human confirmation required",
        }
  const reads = createWorkbenchReads(["saved", "pending"] as const)
  type ReadKey = (typeof reads.parts)[number]["key"]
  const writeReason = useWorkbenchWriteReason()
  type SavedRule = Awaited<ReturnType<OperationsApi["permissions"]["listSaved"]>>[number]
  type PendingRequest = Awaited<ReturnType<OperationsApi["permissions"]["listRequests"]>>["data"][number]
  const [state, setState] = createStore({
    loading: false,
    saving: false,
    error: "",
    notice: "",
    saved: [] as SavedRule[],
    pending: [] as PendingRequest[],
    opening: "",
    navigationError: "",
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const captureConfirmation = createManagementConfirmationGuard({
    source: props.api,
    key: () => `${props.ready()}\u0000${locationScopeKey()}`,
    blocked: () => !props.ready() || state.loading || state.saving || !reads.fresh(),
    invalidate: scopeGuard.invalidate,
  })
  const canWrite = () => props.ready() && !state.loading && !state.saving && reads.fresh()
  let previousScopeKey: string | undefined

  const refresh = async (
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
    only?: ReadKey,
  ) => {
    if (!props.ready() || state.loading) return
    setState("loading", true)
    const api = props.api()
    const current = () => scopeGuard.isCurrent(request)
    try {
      await Promise.all([
        !only || only === "saved"
          ? reads.read(
              "saved",
              () => api.permissions.listSaved(),
              (value) => setState("saved", [...value]),
              current,
            )
          : undefined,
        !only || only === "pending"
          ? reads.read(
              "pending",
              () => api.permissions.listRequests(requestedLocation),
              (value) => setState("pending", [...value.data]),
              current,
            )
          : undefined,
      ])
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const remove = async (rule: SavedRule) => {
    const confirmation = captureConfirmation()
    const request = scopeGuard.capture()
    const requestedLocation = { location: { ...props.location().location } }
    const id = rule.id
    const action = rule.action
    const resource = rule.resource
    const isCurrent = () =>
      confirmation.canWrite() &&
      scopeGuard.isCurrent(request) &&
      state.saved.some((item) => item.id === id && item.action === action && item.resource === resource)
    if (!isCurrent()) return
    if (
      !(await confirmAction(t("撤销 {{action}} 对 {{resource}} 的持久权限？", { action, resource }), {
        isCurrent,
        danger: true,
      }))
    )
      return
    if (!isCurrent()) return
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      await confirmation.source.permissions.removeSaved({ id })
      if (!confirmation.isCurrent() || !scopeGuard.isCurrent(request)) return
      await refresh(requestedLocation, request)
      if (confirmation.isCurrent() && scopeGuard.isCurrent(request))
        setState("notice", t("\u6301\u4E45\u6743\u9650\u5DF2\u64A4\u9500\u3002"))
    } catch (error) {
      if (confirmation.isCurrent() && scopeGuard.isCurrent(request))
        setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      if (confirmation.isCurrent() && scopeGuard.isCurrent(request)) setState("saving", false)
    }
  }
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        scopeGuard.current()
        const currentScopeKey = locationScopeKey()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== currentScopeKey
        previousScopeKey = currentScopeKey
        if (!props.ready()) {
          reads.invalidate()
          setState({ loading: false, saving: false, opening: "", navigationError: "" })
          return
        }
        if (scopeChanged) {
          reads.reset()
          setState({
            loading: false,
            saving: false,
            error: "",
            notice: "",
            saved: [],
            pending: [],
            opening: "",
            navigationError: "",
          })
        }
        void refresh()
      },
    ),
  )
  const openPending = async (item: PendingRequest) => {
    const request = scopeGuard.capture()
    const requestedLocation = { ...props.location().location }
    const current = () =>
      props.ready() &&
      scopeGuard.isCurrent(request) &&
      reads.parts.some((part) => part.key === "pending" && part.fresh) &&
      state.pending.some((row) => row.id === item.id && row.sessionID === item.sessionID && row.action === item.action)
    if (state.opening || state.loading || !current()) return
    setState({ opening: item.id, navigationError: "" })
    try {
      await openSession(item.sessionID, requestedLocation, current)
    } catch (error) {
      if (current()) setState("navigationError", publicError(error, t("Unknown control-center error")))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("opening", "")
    }
  }
  return (
    <section
      data-workbench-detail=""
      class="flex flex-col gap-4"
      data-testid="control-center-permissions"
      aria-busy={state.loading || state.saving}
    >
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={(key) => (key === "saved" ? labels().saved : labels().pending)}
        retry={(key) => void refresh(props.location(), scopeGuard.capture(), key)}
      />
      <ManagementStatus saving={state.saving} error={state.error} />
      <ManagementStatus notice={state.notice} />
      <ManagementStatus error={state.navigationError} />
      <p class="workbench-detail-disabled-reason" role="status">
        {writeReason(state.loading || state.saving, reads.fresh())}
      </p>
      <ManagementCollection<SavedRule | PendingRequest>
        label={labels().list}
        scope={locationScopeKey()}
        scopeLabel={props.location().location.directory}
        items={[...state.pending, ...state.saved]}
        identity={(item) => `${"sessionID" in item ? "pending" : "saved"}:${item.id}`}
        title={(item) => item.action}
        description={(item) =>
          "sessionID" in item ? `${item.sessionID} · ${item.resources.join(" · ")}` : item.resource
        }
        searchText={(item) => item.id}
        status={(item) => (
          <span class="arforge-management-search-scope">{"sessionID" in item ? labels().pending : labels().saved}</span>
        )}
        toolbar={
          <Button size="small" variant="ghost" disabled={state.loading || state.saving} onClick={() => void refresh()}>
            {t("刷新")}
          </Button>
        }
      >
        {(item) => (
          <div class="flex flex-col gap-4">
            <dl class="arforge-management-definition">
              <div>
                <dt>ID</dt>
                <dd>
                  <code>{item.id}</code>
                </dd>
              </div>
              <div>
                <dt>{labels().action}</dt>
                <dd>{item.action}</dd>
              </div>
            </dl>
            <Show when={"sessionID" in item ? item : undefined}>
              {(pending) => (
                <>
                  <dl class="arforge-management-definition">
                    <div>
                      <dt>{labels().source}</dt>
                      <dd>
                        <code>{pending().sessionID}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{labels().resource}</dt>
                      <dd>
                        <For each={pending().resources}>
                          {(resource) => (
                            <p>
                              <code>{resource}</code>
                            </p>
                          )}
                        </For>
                      </dd>
                    </div>
                    <Show when={pending().source}>
                      <div>
                        <dt>{labels().sourceMessage}</dt>
                        <dd>
                          <code>
                            {pending().source?.messageID} · {pending().source?.callID}
                          </code>
                        </dd>
                      </div>
                    </Show>
                    <Show when={pending().requiresHumanConfirmation}>
                      <div>
                        <dt>{labels().pending}</dt>
                        <dd>{labels().human}</dd>
                      </div>
                    </Show>
                  </dl>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={
                      !props.ready() ||
                      state.loading ||
                      !!state.opening ||
                      !reads.parts.some((part) => part.key === "pending" && part.fresh)
                    }
                    aria-busy={state.opening === pending().id}
                    onClick={() => void openPending(pending())}
                  >
                    {state.opening === pending().id ? labels().opening : labels().open}
                  </Button>
                </>
              )}
            </Show>
            <Show when={"resource" in item ? item : undefined}>
              {(saved) => (
                <>
                  <dl class="arforge-management-definition">
                    <div>
                      <dt>{labels().resource}</dt>
                      <dd>
                        <code>{saved().resource}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t("Project:")}</dt>
                      <dd>
                        <code>{saved().projectID}</code>
                      </dd>
                    </div>
                  </dl>
                  <ManagementDangerZone scope={`${saved().action} · ${saved().resource}`}>
                    <ManagementActionToolbar
                      actions={[
                        {
                          id: "revoke-permission",
                          label: t("撤销…"),
                          run: () => remove(saved()),
                          disabled: !canWrite(),
                          danger: true,
                        },
                      ]}
                      disabledReason={writeReason(state.loading || state.saving, reads.fresh())}
                    />
                  </ManagementDangerZone>
                </>
              )}
            </Show>
          </div>
        )}
      </ManagementCollection>
    </section>
  )
}
export function MemoryControl(props: {
  api: () => OperationsApi
  location: () => LocationInput
  ready: () => boolean
}) {
  const t = useControlCenterText()
  const language = useLanguage()
  const confirmAction = useConfirmAction()
  const reads = createWorkbenchReads(["items", "facets", "quality"] as const)
  type ReadKey = (typeof reads.parts)[number]["key"]
  const writeReason = useWorkbenchWriteReason()
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
    inspectedID: "",
    detailOpen: 0,
    page: 0,
    total: 0,
    facets: undefined as Facets | undefined,
    quality: undefined as Quality | undefined,
    semanticResult: undefined as Semantic | undefined,
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return value.directory + "\u0000" + (value.workspace ?? "")
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  const captureConfirmation = createManagementConfirmationGuard({
    source: props.api,
    key: () => `${props.ready()}\u0000${locationScopeKey()}`,
    blocked: () => !props.ready() || state.loading || state.saving || !reads.fresh(),
    invalidate: scopeGuard.invalidate,
  })
  const canWrite = () => props.ready() && !state.loading && !state.saving && reads.fresh()
  const inspected = createMemo(() => state.items.find((item) => item.id === state.inspectedID))
  const page = createMemo(() => managementListPage(state.items, state.page))
  const inspect = (id: string) => setState({ inspectedID: id, detailOpen: state.detailOpen + 1 })
  const copy = () =>
    language.locale().startsWith("zh")
      ? {
          details: "记忆详情",
          metadata: "来源与元数据",
          version: "版本",
          source: "来源",
          strength: "强度",
          review: "复核级别",
          created: "创建时间",
          updated: "更新时间",
          reviewed: "复核时间",
          related: "关联对象",
          previous: "上一页",
          next: "下一页",
          pagination: "记忆列表分页",
          read: "已读取",
          total: "服务器记录数",
        }
      : {
          details: "Memory details",
          metadata: "Source and metadata",
          version: "Version",
          source: "Source",
          strength: "Strength",
          review: "Review level",
          created: "Created",
          updated: "Updated",
          reviewed: "Reviewed",
          related: "Related object",
          previous: "Previous",
          next: "Next",
          pagination: "Memory list pages",
          read: "Loaded",
          total: "Server records",
        }
  let previousScopeKey: string | undefined

  const refresh = async (
    requestedLocation = props.location(),
    request: ScopeRequestToken = scopeGuard.capture(),
    only?: ReadKey,
  ) => {
    if (!props.ready() || state.loading) return
    const query = state.query.trim()
    const semanticMode = state.semantic
    setState("loading", true)
    const api = props.api()
    const current = () => scopeGuard.isCurrent(request)
    try {
      await Promise.all([
        !only || only === "items"
          ? reads.read(
              "items",
              async () => {
                const page = await api.memories.list({
                  ...requestedLocation,
                  ...(query && !semanticMode ? { query } : {}),
                  includeGlobal: "true",
                  limit: 100,
                })
                const semantic =
                  semanticMode && query
                    ? await api.memories.semantic({
                        ...requestedLocation,
                        query,
                        includeGlobal: "true",
                        topK: 20,
                      })
                    : undefined
                return { page, semantic }
              },
              (value) =>
                setState({
                  items: value.semantic ? value.semantic.items.map((hit) => hit.memory) : [...value.page.items],
                  total: value.page.total,
                  semanticResult: value.semantic,
                }),
              current,
            )
          : undefined,
        !only || only === "facets"
          ? reads.read(
              "facets",
              () => api.memories.facets({ ...requestedLocation, includeGlobal: "true" }),
              (value) => setState("facets", value),
              current,
            )
          : undefined,
        !only || only === "quality"
          ? reads.read(
              "quality",
              () => api.memories.recallQuality(requestedLocation),
              (value) => setState("quality", value),
              current,
            )
          : undefined,
      ])
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  const mutate = async (
    action: (location: LocationInput, request: ScopeRequestToken) => Promise<unknown>,
    notice: string,
  ) => {
    if (!canWrite()) return
    const requestedLocation = props.location()
    const request = scopeGuard.capture()
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      await action(requestedLocation, request)
      if (!scopeGuard.isCurrent(request)) return
      await refresh(requestedLocation, request)
      if (scopeGuard.isCurrent(request)) setState("notice", notice)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", publicError(error, t("Unknown control-center error")))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("saving", false)
    }
  }
  const edit = (item: Item) => {
    const content = window.prompt(t("\u7F16\u8F91\u8BB0\u5FC6\u5185\u5BB9\uFF1A"), item.content)?.trim()
    if (!content || content === item.content) return
    void mutate(
      (location) => props.api().memories.update({ ...location, memoryID: item.id, content }),
      t("\u8BB0\u5FC6\u5DF2\u66F4\u65B0\u3002"),
    )
  }
  const remove = async (item: Item) => {
    const confirmation = captureConfirmation()
    const request = scopeGuard.capture()
    const payload = {
      location: { ...props.location().location },
      memoryID: item.id,
      expectedVersion: item.version,
      actionID: AgentRuntime.ActionID.create(),
      redactionEvidenceID: AgentRuntime.EvidenceID.create(),
      reason: `Control Center confirmed memory deletion: ${item.id}`,
    }
    const isCurrent = () =>
      confirmation.canWrite() &&
      scopeGuard.isCurrent(request) &&
      state.items.some((value) => value.id === payload.memoryID && value.version === payload.expectedVersion)
    if (!isCurrent()) return
    if (
      !(await confirmAction(t("删除记忆 {{id}}？此操作不会删除关联会话。", { id: payload.memoryID }), {
        isCurrent,
        danger: true,
      }))
    )
      return
    if (!isCurrent()) return
    await mutate(
      () => confirmation.source.memories.maintenanceDelete(payload),
      t("\u8BB0\u5FC6\u5DF2\u5220\u9664\u3002"),
    )
  }
  const removeSelected = async () => {
    const confirmation = captureConfirmation()
    const request = scopeGuard.capture()
    if (!confirmation.canWrite() || state.selected.length === 0) return
    const selected = [...state.selected]
    const selectedItems = selected.map((id) => state.items.find((item) => item.id === id))
    if (selectedItems.some((item) => item === undefined)) {
      setState("error", t("Unknown control-center error"))
      return
    }
    const payload = {
      location: { ...props.location().location },
      items: selectedItems.map((item) => ({
        memoryID: item!.id,
        expectedVersion: item!.version,
        actionID: AgentRuntime.ActionID.create(),
        redactionEvidenceID: AgentRuntime.EvidenceID.create(),
        reason: `Control Center confirmed bulk memory deletion: ${item!.id}`,
      })),
    }
    const sameSelection = () =>
      state.selected.length === selected.length && state.selected.every((id, index) => id === selected[index])
    const isCurrent = () =>
      confirmation.canWrite() &&
      scopeGuard.isCurrent(request) &&
      sameSelection() &&
      payload.items.every((item) =>
        state.items.some((value) => value.id === item.memoryID && value.version === item.expectedVersion),
      )
    if (!isCurrent()) return
    if (
      !(await confirmAction(t("批量删除选中的 {{count}} 条记忆？", { count: selected.length }), {
        isCurrent,
        danger: true,
      }))
    )
      return
    if (!isCurrent()) return
    await mutate(async (_location, mutationRequest) => {
      await confirmation.source.memories.maintenanceDeleteMany(payload)
      if (confirmation.isCurrent() && scopeGuard.isCurrent(mutationRequest) && sameSelection()) setState("selected", [])
    }, t("\u9009\u4E2D\u7684\u8BB0\u5FC6\u5DF2\u6279\u91CF\u5220\u9664\u3002"))
  }
  const toggle = (id: Item["id"]) =>
    setState(
      "selected",
      state.selected.includes(id) ? state.selected.filter((value) => value !== id) : [...state.selected, id],
    )
  createEffect(
    on(
      () => (props.ready() ? "ready" : "not-ready") + "\u0000" + locationScopeKey(),
      (scopeKey) => {
        // A later confirmation observer must not expire this scope's new read.
        captureConfirmation()
        scopeGuard.current()
        const currentScopeKey = locationScopeKey()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== currentScopeKey
        previousScopeKey = currentScopeKey
        if (!props.ready()) {
          reads.invalidate()
          setState({ loading: false, saving: false })
          return
        }
        if (scopeChanged) {
          reads.reset()
          setState({
            loading: false,
            saving: false,
            error: "",
            notice: "",
            items: [],
            selected: [],
            inspectedID: "",
            page: 0,
            total: 0,
            facets: undefined,
            quality: undefined,
            semanticResult: undefined,
          })
        }
        void refresh()
      },
    ),
  )
  return (
    <section
      data-workbench-detail=""
      class="flex flex-col gap-4"
      data-testid="control-center-memory"
      aria-busy={state.loading || state.saving}
    >
      <div class="grid gap-3 md:grid-cols-3">
        <MetricCard
          label={t("\u5F53\u524D\u7ED3\u679C")}
          value={reads.parts.find((part) => part.key === "items")?.loaded ? state.items.length : "—"}
        />
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
          setState("page", 0)
          void refresh()
        }}
      >
        <input
          class="h-9 min-w-[240px] flex-1 rounded-md border border-border-weak-base bg-background-base px-3 text-12-regular text-text-strong"
          aria-label={t("\u641C\u7D22\u6301\u4E45\u8BB0\u5FC6")}
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
        <Button type="submit" size="small" variant="secondary" disabled={state.loading || state.saving}>
          {t("\u641C\u7D22")}
        </Button>
        <span class="arforge-management-search-scope">
          {t("Project:")} {props.location().location.directory}
        </span>
        <Show when={state.query}>
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={state.loading || state.saving}
            onClick={() => {
              setState({ query: "", page: 0 })
              void refresh()
            }}
          >
            {language.t("common.clear")}
          </Button>
        </Show>
      </form>
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={(key) =>
          key === "items"
            ? t("\u5F53\u524D\u7ED3\u679C")
            : key === "quality"
              ? t("Top-1 \u53EC\u56DE\u7387")
              : t("\u641C\u7D22\u6301\u4E45\u8BB0\u5FC6")
        }
        retry={(key) => void refresh(props.location(), scopeGuard.capture(), key)}
      />
      <ManagementStatus saving={state.saving} error={state.error} />
      <ManagementStatus notice={state.notice} />
      <p class="workbench-detail-disabled-reason" role="status">
        {writeReason(state.loading || state.saving, reads.fresh())}
      </p>
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
      <div class="arforge-management-master-detail" data-testid="memory-master-detail">
        <div class="arforge-management-master-content">
          <div class="arforge-management-entity-list" data-testid="memory-compact-list">
            <For each={page().items}>
              {(item) => (
                <div class="arforge-management-entity-row" data-density="double">
                  <input
                    type="checkbox"
                    aria-label={t("选择 {{id}}", { id: item.id })}
                    checked={state.selected.includes(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <button
                    type="button"
                    class="arforge-management-entity-select"
                    data-management-detail-id={item.id}
                    aria-expanded={state.inspectedID === item.id}
                    onClick={() => inspect(item.id)}
                  >
                    <span class="arforge-management-entity-preview">{memoryListPreview(item.content) || item.id}</span>
                    <span class="arforge-management-entity-meta">
                      <span>{item.type}</span>
                      <span>{item.scope}</span>
                      <span>
                        {t("importance")}
                        {item.importance}
                      </span>
                      <code>{item.id}</code>
                    </span>
                  </button>
                </div>
              )}
            </For>
          </div>
          <Show when={reads.parts.find((part) => part.key === "items")?.loaded}>
            <nav class="arforge-management-list-pagination" aria-label={copy().pagination}>
              <span>
                {copy().read} {state.items.length} · {copy().total} {state.total}
              </span>
              <Button
                type="button"
                size="small"
                variant="ghost"
                disabled={page().index === 0}
                onClick={() => setState("page", page().index - 1)}
              >
                {copy().previous}
              </Button>
              <span>
                {page().index + 1} / {page().pages}
              </span>
              <Button
                type="button"
                size="small"
                variant="ghost"
                disabled={page().index + 1 >= page().pages}
                onClick={() => setState("page", page().index + 1)}
              >
                {copy().next}
              </Button>
            </nav>
          </Show>
        </div>
        <Show when={inspected()}>
          {(item) => (
            <ManagementDetail
              identity={item().id}
              openRequest={state.detailOpen}
              title={`${copy().details} · ${item().id}`}
            >
              <article class="arforge-management-memory-inspector" data-testid="memory-inspector">
                <div class="whitespace-pre-wrap text-12-regular text-text-strong">{item().content}</div>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  disabled={!canWrite()}
                  onClick={() => edit(item())}
                >
                  {t("\u7F16\u8F91")}
                </Button>
                <dl aria-label={copy().metadata}>
                  <dt>ID</dt>
                  <dd>
                    <code>{item().id}</code>
                  </dd>
                  <dt>{copy().version}</dt>
                  <dd>{item().version}</dd>
                  <dt>{t("importance")}</dt>
                  <dd>{item().importance}</dd>
                  <dt>Type / Scope</dt>
                  <dd>
                    {item().type} · {item().scope}
                  </dd>
                  <dt>{copy().source}</dt>
                  <dd>{item().source}</dd>
                  <dt>Tags</dt>
                  <dd>
                    <For each={item().tags}>{(tag) => <span class="mr-2">#{tag}</span>}</For>
                  </dd>
                  <dt>
                    {copy().strength} / {copy().review}
                  </dt>
                  <dd>
                    {item().strength} / {item().reviewLevel}
                  </dd>
                  <dt>{copy().created}</dt>
                  <dd>{new Date(item().time.created).toLocaleString(language.intl())}</dd>
                  <dt>{copy().updated}</dt>
                  <dd>{new Date(item().time.updated).toLocaleString(language.intl())}</dd>
                  <Show when={item().time.reviewed}>
                    {(value) => (
                      <>
                        <dt>{copy().reviewed}</dt>
                        <dd>{new Date(value()).toLocaleString(language.intl())}</dd>
                      </>
                    )}
                  </Show>
                  <Show when={item().projectID}>
                    <dt>Project</dt>
                    <dd>{item().projectID}</dd>
                  </Show>
                  <Show when={item().workspacePath}>
                    <dt>Workspace</dt>
                    <dd>{item().workspacePath}</dd>
                  </Show>
                  <Show when={item().relatedTo}>
                    <dt>{copy().related}</dt>
                    <dd>{item().relatedTo}</dd>
                  </Show>
                </dl>
                <ManagementDangerZone
                  scope={`${props.location().location.directory} · ${item().scope} · ${item().id} · v${item().version}`}
                >
                  <ManagementActionToolbar
                    actions={[
                      {
                        id: "delete-memory",
                        label: t("\u5220\u9664\u2026"),
                        run: () => remove(item()),
                        disabled: !canWrite(),
                        danger: true,
                      },
                    ]}
                    disabledReason={writeReason(state.loading || state.saving, reads.fresh())}
                  />
                </ManagementDangerZone>
              </article>
            </ManagementDetail>
          )}
        </Show>
      </div>
      <ManagementStatus
        empty={props.ready() && !state.loading && reads.fresh() && state.items.length === 0}
        onRetry={() => void refresh()}
      />
      <ManagementDangerZone scope={`${props.location().location.directory} · ${state.selected.length}`}>
        <Button
          size="small"
          variant="ghost"
          disabled={!state.selected.length || !canWrite()}
          onClick={() => void removeSelected()}
        >
          {t("\u5220\u9664\u6240\u9009\u2026")}
        </Button>
      </ManagementDangerZone>
      <Show when={state.quality}>{(quality) => <Notice>{quality().caveat}</Notice>}</Show>
    </section>
  )
}
function PrivateOperations(props: { api: () => OperationsApi; location: () => LocationInput; ready: () => boolean }) {
  const t = useControlCenterText()
  const reads = createWorkbenchReads(["overview"] as const)
  const locationScopeKey = () => JSON.stringify(props.location().location)
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  type Overview = Awaited<ReturnType<OperationsApi["privateOperations"]["overview"]>>["data"]
  const [state, setState] = createStore({
    loading: false,
    error: "",
    overview: undefined as Overview | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    const request = scopeGuard.capture()
    const api = props.api()
    const requestedLocation = props.location()
    setState("loading", true)
    try {
      await reads.read(
        "overview",
        () => api.privateOperations.overview(requestedLocation),
        (value) => setState("overview", value.data),
        () => scopeGuard.isCurrent(request),
      )
    } finally {
      if (scopeGuard.isCurrent(request)) setState("loading", false)
    }
  }
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => [props.ready(), locationScopeKey()] as const,
      ([ready, key]) => {
        scopeGuard.current()
        if (previousScopeKey !== undefined && previousScopeKey !== key) {
          reads.reset()
          setState({ loading: false, overview: undefined })
        }
        previousScopeKey = key
        if (!ready) {
          scopeGuard.invalidate()
          reads.invalidate()
          setState("loading", false)
          return
        }
        void refresh()
      },
    ),
  )
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
    <section
      data-workbench-detail=""
      class="flex flex-col gap-4"
      data-testid="control-center-private-operations"
      aria-busy={state.loading ? "true" : "false"}
    >
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
      <div data-testid="private-operations-loading">
        <WorkbenchReadStatus
          reads={reads}
          loading={state.loading}
          scope={props.location().location.directory}
          label={() => t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5")}
          retry={() => void refresh()}
        />
      </div>
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
            <ManagementCollection
              label={t("统一健康检查")}
              scope={locationScopeKey()}
              scopeLabel={props.location().location.directory}
              items={[
                {
                  id: "snapshot-0",
                  title: t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5"),
                  description: `${overview().doctor.passed}/${overview().doctor.checks.length}`,
                  render: () => (
                    <article class="rounded-md border border-border-weak-base p-3">
                      <h3 class="arforge-management-section-title text-text-strong">
                        {t("\u7EDF\u4E00\u5065\u5EB7\u68C0\u67E5")}
                      </h3>
                      <div class="mt-2 flex flex-col gap-2">
                        <For each={overview().doctor.checks}>
                          {(check) => (
                            <div class="flex items-start justify-between gap-3 arforge-management-copy">
                              <span class="text-text-strong">
                                {check.ok ? "✓" : "✗"} {check.label}
                              </span>
                              <span class="text-right text-text-weak">{check.detail}</span>
                            </div>
                          )}
                        </For>
                      </div>
                    </article>
                  ),
                },
                {
                  id: "snapshot-1",
                  title: t("PostgreSQL \u5907\u4EFD"),
                  description: overview().backup.createdAt ?? "—",
                  render: () => (
                    <article class="rounded-md border border-border-weak-base p-3">
                      <h3 class="arforge-management-section-title text-text-strong">{t("PostgreSQL \u5907\u4EFD")}</h3>
                      <div class="mt-2 arforge-management-copy text-text-weak">
                        <div>{overview().backup.available ? (overview().backup.createdAt ?? "✓") : "—"}</div>
                        <div>
                          {overview().backup.database ?? "PostgreSQL"} · {overview().backup.bytes} B · AES-256-CBC{" "}
                          {overview().backup.checksumVerified ? "✓ SHA-256" : "—"}
                        </div>
                        <div>restore list {overview().backup.restoreListVerified ? "✓" : "—"}</div>
                      </div>
                    </article>
                  ),
                },
                {
                  id: "snapshot-2",
                  title: t("\u6062\u590D\u6F14\u7EC3"),
                  description: overview().recoveryDrill.completedAt ?? "—",
                  render: () => (
                    <article class="rounded-md border border-border-weak-base p-3">
                      <h3 class="arforge-management-section-title text-text-strong">{t("\u6062\u590D\u6F14\u7EC3")}</h3>
                      <div class="mt-2 arforge-management-copy text-text-weak">
                        <div>{overview().recoveryDrill.completedAt ?? "—"}</div>
                        <div>
                          {overview().recoveryDrill.tables} tables · {overview().recoveryDrill.sourceRows}/
                          {overview().recoveryDrill.restoredRows} rows · Δ {overview().recoveryDrill.differences}
                        </div>
                      </div>
                    </article>
                  ),
                },
                {
                  id: "snapshot-3",
                  title: t("\u51ED\u636E\u626B\u63CF") + " / " + t("\u65E5\u5FD7\u4FDD\u7559\u9884\u89C8"),
                  description: `${overview().secrets.findings} · ${overview().logs.files}`,
                  render: () => (
                    <article class="rounded-md border border-border-weak-base p-3">
                      <h3 class="arforge-management-section-title text-text-strong">
                        {t("\u51ED\u636E\u626B\u63CF")} / {t("\u65E5\u5FD7\u4FDD\u7559\u9884\u89C8")}
                      </h3>
                      <div class="mt-2 arforge-management-copy text-text-weak">
                        <div>
                          {overview().secrets.filesScanned} files · {overview().secrets.findingFiles} hit files ·{" "}
                          {overview().secrets.findings} signals
                        </div>
                        <div>
                          {overview().logs.files} log files · {overview().logs.bytes} B ·{" "}
                          {overview().logs.retentionDays} days
                        </div>
                      </div>
                    </article>
                  ),
                },
              ]}
              identity={(item) => item.id}
              title={(item) => item.title}
              description={(item) => item.description}
            >
              {(item) => item.render()}
            </ManagementCollection>
          </>
        )}
      </Show>
      <ManagementCollection
        label={t("数据库与本地运维")}
        scope={locationScopeKey()}
        scopeLabel={props.location().location.directory}
        items={rows}
        identity={(row) => row[1]}
        title={(row) => row[0]}
        description={(row) => row[1]}
        searchText={(row) => row[2]}
      >
        {(row) => (
          <article class="grid gap-2 border-b border-border-weak-base p-3 last:border-b-0 md:grid-cols-[140px_1fr_1.4fr]">
            <div class="arforge-management-section-title text-text-strong">{row[0]}</div>
            <code class="select-text break-all arforge-management-copy text-text-strong">{row[1]}</code>
            <div class="arforge-management-copy text-text-weak">{row[2]}</div>
          </article>
        )}
      </ManagementCollection>
    </section>
  )
}
function ProjectCopyControl(props: { api: () => OperationsApi; location: () => LocationInput; info: LocationInfo }) {
  const t = useControlCenterText()
  const language = useLanguage()
  const confirmAction = useConfirmAction()
  const reads = createWorkbenchReads(["copies"] as const)
  const writeReason = useWorkbenchWriteReason()
  const copyErrorText = (error: unknown) => {
    const fallback = t("Unknown control-center error")
    if (!error || typeof error !== "object" || !("name" in error) || error.name !== "ProjectCopyError")
      return publicError(error, fallback)
    // ProjectCopyError messages can contain arbitrary Git subprocess output.
    const details = "data" in error ? error.data : undefined
    if (!details || typeof details !== "object" || !("forceRequired" in details) || details.forceRequired !== true)
      return fallback
    if (language.locale() === "zh") return "项目副本包含未提交修改或未跟踪文件。"
    if (language.locale() === "zht") return "專案副本包含未提交修改或未追蹤檔案。"
    return "The worktree contains modified or untracked files."
  }
  const captureConfirmation = createManagementConfirmationGuard({
    source: props.api,
    key: () => JSON.stringify([props.location().location, props.info.project.id]),
    blocked: () => state.loading || state.saving || !reads.fresh(),
  })
  type CopyEntry = Awaited<ReturnType<OperationsApi["projectCopies"]["list"]>>[number]
  const [state, setState] = createStore({
    loading: true,
    saving: false,
    destination: "",
    entries: [] as CopyEntry[],
    error: "",
    notice: "",
  })
  const canWrite = () => !state.loading && !state.saving && reads.fresh()
  const load = async () => {
    const confirmation = captureConfirmation()
    const requestedLocation = { location: { ...props.location().location } }
    const projectID = props.info.project.id
    setState("loading", true)
    try {
      await reads.read(
        "copies",
        () => confirmation.source.projectCopies.list({ ...requestedLocation, projectID }),
        (value) => setState("entries", [...value]),
        confirmation.isCurrent,
      )
    } finally {
      if (confirmation.isCurrent()) setState("loading", false)
    }
  }
  createEffect(
    on(
      () => JSON.stringify([props.location().location, props.info.project.id]),
      () => {
        reads.reset()
        setState({ loading: false, saving: false, entries: [], error: "", notice: "" })
        void load()
      },
    ),
  )
  const create = async () => {
    const destination = state.destination.trim()
    if (!destination || !canWrite()) return
    const confirmation = captureConfirmation()
    const payload = {
      ...props.location(),
      projectID: props.info.project.id,
      strategy: "git_worktree" as const,
      directory: destination,
    }
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      const result = await confirmation.source.projectCopies.create(payload)
      if (!confirmation.isCurrent()) return
      setState({
        destination: state.destination.trim() === destination ? "" : state.destination,
        notice: t("项目副本已创建：{{directory}}", { directory: result.directory }),
      })
      await load()
    } catch (error) {
      if (confirmation.isCurrent()) setState("error", copyErrorText(error))
    } finally {
      if (confirmation.isCurrent()) setState("saving", false)
    }
  }
  const refresh = async () => {
    if (!canWrite()) return
    const confirmation = captureConfirmation()
    const payload = { ...props.location(), projectID: props.info.project.id }
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      await confirmation.source.projectCopies.refresh(payload)
      if (!confirmation.isCurrent()) return
      await load()
      if (confirmation.isCurrent())
        setState(
          "notice",
          t("\u5DF2\u6839\u636E Git worktree \u4E8B\u5B9E\u5237\u65B0\u9879\u76EE\u526F\u672C\u767B\u8BB0\u3002"),
        )
    } catch (error) {
      if (confirmation.isCurrent()) setState("error", copyErrorText(error))
    } finally {
      if (confirmation.isCurrent()) setState("saving", false)
    }
  }
  const remove = async (directory: string) => {
    const confirmation = captureConfirmation()
    const payload = {
      location: { ...props.location().location },
      projectID: props.info.project.id,
      directory,
      force: false,
    }
    const isCurrent = () =>
      confirmation.canWrite() && state.entries.some((entry) => entry.type === "copy" && entry.directory === directory)
    if (!isCurrent()) return
    if (
      !(await confirmAction(t("移除项目副本 {{directory}}？未提交修改会阻止非强制移除。", { directory }), {
        isCurrent,
        danger: true,
      }))
    )
      return
    if (!isCurrent()) return
    setState({ saving: true, error: "", notice: "" })
    try {
      reads.invalidate()
      await confirmation.source.projectCopies.remove(payload)
      if (!confirmation.isCurrent()) return
      await load()
      if (confirmation.isCurrent())
        setState("notice", t("\u9879\u76EE\u526F\u672C\u5DF2\u5B89\u5168\u79FB\u9664\u3002"))
    } catch (error) {
      if (confirmation.isCurrent())
        setState(
          "error",
          t("{{error}}。如确需强制移除，请在专用管理流程中检查未提交修改后执行。", {
            error: copyErrorText(error),
          }),
        )
    } finally {
      if (confirmation.isCurrent()) setState("saving", false)
    }
  }
  return (
    <section data-workbench-detail="" class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
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
        <Button size="small" variant="ghost" disabled={!canWrite()} onClick={() => void refresh()}>
          {t("\u5237\u65B0\u767B\u8BB0")}
        </Button>
      </div>
      <div class="flex flex-wrap gap-2">
        <input
          class="h-9 min-w-[280px] flex-1 rounded-md border border-border-weak-base bg-background-base px-3 text-12-regular text-text-strong"
          aria-label={t("\u65B0 worktree \u7684\u7EDD\u5BF9\u76EE\u5F55")}
          value={state.destination}
          onInput={(event) => setState("destination", event.currentTarget.value)}
          placeholder={t("\u65B0 worktree \u7684\u7EDD\u5BF9\u76EE\u5F55")}
        />
        <Button
          size="small"
          variant="secondary"
          disabled={!canWrite() || !state.destination.trim()}
          onClick={() => void create()}
        >
          {t("\u521B\u5EFA\u526F\u672C")}
        </Button>
      </div>
      <For each={state.entries.filter((entry) => entry.type === "copy")}>
        {(entry) => (
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background-weak p-2">
            <div class="flex min-w-0 flex-col gap-1">
              <code class="select-text break-all text-11-regular">{entry.directory}</code>
              <span class="text-10-regular text-text-weak">
                {entry.strategy ?? t("\u5DF2\u767B\u8BB0\u526F\u672C")}
              </span>
            </div>
            <ManagementActionToolbar
              actions={[
                {
                  id: "remove-project-copy",
                  label: t("\u79FB\u9664\u2026"),
                  run: () => remove(entry.directory),
                  disabled: !canWrite(),
                  danger: true,
                },
              ]}
              disabledReason={writeReason(state.loading || state.saving, reads.fresh())}
            />
          </div>
        )}
      </For>
      <ManagementStatus
        empty={!state.loading && reads.fresh() && state.entries.every((entry) => entry.type !== "copy")}
        emptyText={t("\u5F53\u524D\u6CA1\u6709\u5DF2\u767B\u8BB0\u7684\u9879\u76EE\u526F\u672C\u3002")}
        onRetry={() => void load()}
      />
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={() => t("\u9879\u76EE\u526F\u672C / Git worktree")}
        retry={() => void load()}
      />
      <ManagementStatus
        saving={state.saving}
        error={state.error}
        onRetry={!state.loading && !state.saving ? () => void load() : undefined}
      />
      <ManagementStatus notice={state.notice} />
      <p class="workbench-detail-disabled-reason" role="status">
        {writeReason(state.loading || state.saving, reads.fresh())}
      </p>
    </section>
  )
}
function CapabilityCoverage(props: { onNavigate?: (value: string) => void }) {
  const t = useControlCenterText()
  const language = useLanguage()
  const copy = () =>
    language.locale().startsWith("zh")
      ? {
          list: "能力与接口映射",
          groups: "功能组",
          methods: "已登记方法",
          duplicates: "重复映射",
          owner: "界面归属",
          risk: "动作边界",
          evidence: "验证证据",
          unverified: "这里只表示静态接口映射，不代表本轮交互或运行验证通过。",
          inspect: "查看真实诊断与证据",
        }
      : {
          list: "Capabilities and API mapping",
          groups: "Feature groups",
          methods: "Mapped methods",
          duplicates: "Duplicate mappings",
          owner: "Surface owner",
          risk: "Action boundary",
          evidence: "Verification evidence",
          unverified: "Static API mapping only; this does not prove interaction or runtime verification.",
          inspect: "Open diagnostics and evidence",
        }
  const methods = () => CONTROL_CENTER_CAPABILITY_MAP.flatMap((entry) => [...entry.methods])
  return (
    <section class="flex flex-col gap-4" data-testid="control-center-coverage">
      <div class="arforge-management-metrics">
        <MetricCard label={copy().groups} value={CONTROL_CENTER_CAPABILITY_MAP.length} />
        <MetricCard label={copy().methods} value={new Set(methods()).size} />
        <MetricCard label={copy().duplicates} value={methods().length - new Set(methods()).size} />
      </div>
      <p class="arforge-management-search-scope">{copy().unverified}</p>
      <ManagementCollection
        label={copy().list}
        scope="static-capability-map"
        items={CONTROL_CENTER_CAPABILITY_MAP}
        identity={(entry) => entry.feature}
        title={(entry) => entry.feature}
        description={(entry) => `${entry.surface} · ${entry.risk} · ${entry.methods.length}`}
        searchText={(entry) => entry.methods.join(" ")}
      >
        {(entry) => (
          <div class="flex flex-col gap-4">
            <dl class="arforge-management-definition">
              <div>
                <dt>{copy().owner}</dt>
                <dd>{entry.surface}</dd>
              </div>
              <div>
                <dt>{copy().risk}</dt>
                <dd>{entry.risk}</dd>
              </div>
              <div>
                <dt>{copy().methods}</dt>
                <dd>
                  <For each={entry.methods}>
                    {(method) => (
                      <p>
                        <code>{method}</code>
                      </p>
                    )}
                  </For>
                </dd>
              </div>
              <div>
                <dt>{copy().evidence}</dt>
                <dd>{copy().unverified}</dd>
              </div>
            </dl>
            <Show when={props.onNavigate}>
              <Button size="small" variant="secondary" onClick={() => props.onNavigate?.("arforge-diagnostics")}>
                {copy().inspect}
              </Button>
            </Show>
          </div>
        )}
      </ManagementCollection>
    </section>
  )
}
function MetricCard(props: { label: string; value: string | number }) {
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
