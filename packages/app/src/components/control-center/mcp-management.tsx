import { For, Show, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { pathKey } from "@/utils/path-key"
import { ManagementStatus } from "../settings-v2/management-status"
import { managementErrorText } from "../settings-v2/management-state"
import { ManagementCollection } from "./management-collection"
import { WorkbenchReadStatus, createWorkbenchReads } from "./capability-workbench"
import { useManagementSessionNavigation } from "./management-source-navigation"
import { mcpStatusLabelKey } from "../mcp-status"
import { McpToolDetails } from "./mcp-tool-details"
import { McpConnectionEditor, type McpEntry } from "./mcp-connection-editor"

type Location = { location: { directory: string; workspace?: string } }
type Resources = Awaited<ReturnType<OperationsApi["mcp"]["resourceCatalog"]>>["data"]
type Capability = Awaited<ReturnType<OperationsApi["mcp"]["capabilities"]>>["data"][number]
type Item =
  | { kind: "server"; name: string; status: string }
  | { kind: "resource"; value: Resources["resources"][number] }
  | { kind: "template"; value: Resources["templates"][number] }
  | { kind: "capability"; value: Capability }

export function McpManagement(props: {
  api: () => OperationsApi
  location: () => Location
  sessionID?: string
  ready: () => boolean
}) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const openSession = useManagementSessionNavigation(props.api)
  const [state, setState] = createStore({
    loading: false,
    busy: "",
    error: "",
    notice: "",
    resources: undefined as Resources | undefined,
    capabilities: [] as Capability[],
    editorOpen: false,
    editorName: undefined as string | undefined,
    configBusy: false,
    sourceEpoch: 0,
  })
  const reads = createWorkbenchReads(["connections", "resources", "capabilities"] as const)
  const key = () =>
    JSON.stringify([serverSDK().scope, props.location().location.directory, props.location().location.workspace])
  const guard = createScopeRequestGuard(key)
  const directory = createMemo(() =>
    props.ready() && props.location().location.directory
      ? serverSync().ensureDirSyncContext(props.location().location.directory)
      : undefined,
  )
  const copy = () =>
    language.locale().startsWith("zh")
      ? {
          title: "MCP 服务、资源与工具",
          refresh: "刷新",
          server: "服务",
          resource: "资源",
          template: "资源模板",
          tool: "能力",
          toolKind: "工具",
          promptKind: "提示词",
          resourcePermission: "资源权限",
          templatePermission: "模板权限",
          kind: "能力类型",
          description: "说明",
          referenceID: "资源标识",
          connect: "连接",
          disconnect: "断开连接",
          authorize: "继续授权",
          pending: "正在连接",
          source: "来源",
          status: "状态",
          boundary: "权限与访问范围",
          open: "打开来源会话",
          reference: "资源引用由来源会话的附件入口完成，保留原草稿与鉴权。",
          session: "请先打开准确来源会话，再添加资源引用。",
          acknowledged: "连接操作已返回，请核对当前状态。",
          wait: "请等待当前操作完成；读取失败时先刷新。",
          add: "添加服务",
          edit: "编辑连接配置",
          saved: "MCP 连接配置已保存。",
        }
      : {
          title: "MCP servers, resources and tools",
          refresh: "Refresh",
          server: "Server",
          resource: "Resource",
          template: "Resource template",
          tool: "Capability",
          toolKind: "Tool",
          promptKind: "Prompt",
          resourcePermission: "Resource access",
          templatePermission: "Template access",
          kind: "Capability type",
          description: "Description",
          referenceID: "Resource reference",
          connect: "Connect",
          disconnect: "Disconnect",
          authorize: "Continue authorization",
          pending: "Connecting",
          source: "Source",
          status: "Status",
          boundary: "Permission and access scope",
          open: "Open source Session",
          reference:
            "Attach resources from the source Session. Its draft and authorization stay with the existing attachment owner.",
          session: "Open the exact source Session before attaching resources.",
          acknowledged: "The connection operation returned. Check its current status.",
          wait: "Wait for the current operation. Refresh failed reads first.",
          add: "Add server",
          edit: "Edit connection configuration",
          saved: "MCP connection configuration saved.",
        }
  const connections = () =>
    Object.entries(directory()?.data.mcp ?? {}).map(([name, value]) => ({
      kind: "server" as const,
      name,
      status: value.status,
    }))
  const connectionFresh = () => reads.parts.some((part) => part.key === "connections" && part.fresh)
  const connectionMessage = (name: string) => {
    const value = directory()?.data.mcp[name]
    return value && "error" in value
      ? managementErrorText(value.error, "")
      : value && "reason" in value
        ? managementErrorText(value.reason, "")
        : ""
  }
  const items = (): Item[] => [
    ...connections(),
    ...(state.resources?.resources.map((value) => ({ kind: "resource" as const, value })) ?? []),
    ...(state.resources?.templates.map((value) => ({ kind: "template" as const, value })) ?? []),
    ...state.capabilities.map((value) => ({ kind: "capability" as const, value })),
  ]
  const title = (item: Item) => (item.kind === "server" ? item.name : item.value.name)
  const identity = (item: Item) =>
    item.kind === "server"
      ? `server:${item.name}`
      : JSON.stringify([
          item.kind,
          item.value.server,
          item.kind === "resource" ? item.value.uri : item.kind === "template" ? item.value.uriTemplate : item.value.id,
        ])
  const statusLabel = (status: string) => {
    const label = mcpStatusLabelKey(status)
    return label ? language.t(label) : status
  }
  const rowDescription = (item: Item) => {
    if (item.kind === "server") return `${copy().server} · ${statusLabel(item.status)}`
    const kind =
      item.kind === "resource"
        ? copy().resource
        : item.kind === "template"
          ? copy().template
          : item.value.kind === "tool"
            ? copy().toolKind
            : item.value.kind === "prompt"
              ? copy().promptKind
              : item.value.kind === "resource"
                ? copy().resourcePermission
                : copy().templatePermission
    return `${kind} · ${item.value.server}`
  }
  const refresh = async () => {
    if (!props.ready() || !directory() || state.loading) return
    const token = guard.capture(),
      location = props.location(),
      api = props.api(),
      sync = serverSync()
    const current = () => props.ready() && guard.isCurrent(token) && serverSync() === sync
    setState("loading", true)
    try {
      await Promise.all([
        reads.read(
          "connections",
          () =>
            sync.queryClient.fetchQuery({
              ...sync.queryOptions.mcp(pathKey(location.location.directory)),
              staleTime: 0,
            }),
          () => undefined,
          current,
        ),
        reads.read(
          "resources",
          () => api.mcp.resourceCatalog(location),
          (value) => setState("resources", value.data),
          current,
        ),
        reads.read(
          "capabilities",
          () => api.mcp.capabilities(location),
          (value) => setState("capabilities", [...value.data]),
          current,
        ),
      ])
    } finally {
      if (guard.isCurrent(token)) setState("loading", false)
    }
  }
  createEffect(
    on(
      () => [props.ready(), key(), serverSDK()] as const,
      () => {
        guard.invalidate()
        reads.reset()
        setState({
          loading: false,
          busy: "",
          error: "",
          notice: "",
          resources: undefined,
          capabilities: [],
          editorOpen: false,
          editorName: undefined,
          configBusy: false,
          sourceEpoch: state.sourceEpoch + 1,
        })
        if (props.ready()) void refresh()
      },
    ),
  )
  const toggle = async (item: Extract<Item, { kind: "server" }>) => {
    const token = guard.capture(),
      owner = directory(),
      source = serverSDK(),
      sync = serverSync()
    const current = () =>
      props.ready() &&
      guard.isCurrent(token) &&
      serverSDK() === source &&
      serverSync() === sync &&
      directory() === owner
    if (
      !owner ||
      state.busy ||
      state.configBusy ||
      state.loading ||
      !connectionFresh() ||
      !current() ||
      owner.data.mcp[item.name]?.status !== item.status ||
      item.status === "pending"
    )
      return
    setState({ busy: item.name, error: "", notice: "" })
    try {
      await owner.mcp.toggle(item.name)
      if (!current()) return
      setState("notice", copy().acknowledged)
      reads.invalidate()
      await refresh()
    } catch (error) {
      if (current()) setState("error", managementErrorText(error, copy().wait))
    } finally {
      if (current()) setState("busy", "")
    }
  }
  const navigate = async () => {
    const sessionID = props.sessionID,
      token = guard.capture()
    if (!sessionID || state.busy || !props.ready()) return
    setState({ busy: "source", error: "" })
    try {
      await openSession(sessionID, { ...props.location().location }, () => props.ready() && guard.isCurrent(token))
    } catch (error) {
      if (guard.isCurrent(token)) setState("error", managementErrorText(error, copy().wait))
    } finally {
      if (guard.isCurrent(token)) setState("busy", "")
    }
  }
  const loadConnections = async () => {
    if (!props.ready()) throw new Error("MCP source is unavailable")
    const source = serverSDK(),
      location = { ...props.location().location },
      token = guard.capture()
    const result = await source.client.config.get(location, { throwOnError: true })
    if (!props.ready() || serverSDK() !== source || !guard.isCurrent(token)) throw new Error("MCP source changed")
    return result.data.mcp ?? {}
  }
  const saveConnection = async (name: string, value: McpEntry) => {
    if (!props.ready() || state.configBusy || state.busy) throw new Error("MCP source is unavailable")
    const source = serverSDK(),
      location = { ...props.location().location },
      token = guard.capture()
    const current = () => props.ready() && serverSDK() === source && guard.isCurrent(token)
    setState("configBusy", true)
    try {
      // The existing workspace config writer owns merging, validation and
      // persistence. Never replace the global config or any other MCP entry.
      await source.client.config.update({ ...location, config: { mcp: { [name]: value } } }, { throwOnError: true })
      if (current()) reads.invalidate()
    } finally {
      if (current()) {
        setState("configBusy", false)
        void refresh()
      }
    }
  }
  return (
    <section class="arforge-management-task-form" data-testid="mcp-management">
      <WorkbenchReadStatus
        reads={reads}
        loading={state.loading}
        scope={props.location().location.directory}
        label={(part) =>
          part === "connections" ? copy().server : part === "resources" ? copy().resource : copy().tool
        }
        retry={() => void refresh()}
      />
      <ManagementStatus error={state.error} notice={state.notice} acknowledged={!!state.error && !!state.notice} />
      <ManagementCollection
        label={copy().title}
        scope={key()}
        scopeLabel={props.location().location.directory}
        items={items()}
        identity={identity}
        title={title}
        description={rowDescription}
        searchText={(item) => identity(item)}
        toolbar={
          <>
            <ButtonV2
              variant="ghost"
              disabled={state.loading || !!state.busy || state.configBusy}
              onClick={() => void refresh()}
            >
              {copy().refresh}
            </ButtonV2>
            <ButtonV2
              variant="neutral"
              disabled={!props.ready() || !!state.busy || state.configBusy || state.editorOpen}
              onClick={() => setState({ editorOpen: true, editorName: undefined })}
            >
              {copy().add}
            </ButtonV2>
          </>
        }
      >
        {(item) => (
          <div class="arforge-management-task-form">
            <dl class="arforge-management-definition">
              <div>
                <dt>{copy().source}</dt>
                <dd>
                  <code>{props.location().location.directory}</code>
                </dd>
              </div>
              <div>
                <dt>{copy().server}</dt>
                <dd>{item.kind === "server" ? item.name : item.value.server}</dd>
              </div>
              <Show when={item.kind === "server" ? item : undefined}>
                {(server) => (
                  <div>
                    <dt>{copy().status}</dt>
                    <dd>{statusLabel(server().status)}</dd>
                  </div>
                )}
              </Show>
              <Show when={item.kind === "resource" ? item.value : undefined}>
                {(resource) => (
                  <>
                    <div>
                      <dt>URI</dt>
                      <dd>
                        <code>{resource().uri}</code>
                      </dd>
                    </div>
                    <Show when={resource().description}>
                      <div>
                        <dt>{copy().description}</dt>
                        <dd>{resource().description}</dd>
                      </div>
                    </Show>
                    <Show when={resource().mimeType}>
                      <div>
                        <dt>MIME</dt>
                        <dd>{resource().mimeType}</dd>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={item.kind === "template" ? item.value : undefined}>
                {(template) => (
                  <>
                    <div>
                      <dt>URI</dt>
                      <dd>
                        <code>{template().uriTemplate}</code>
                      </dd>
                    </div>
                    <Show when={template().description}>
                      <div>
                        <dt>{copy().description}</dt>
                        <dd>{template().description}</dd>
                      </div>
                    </Show>
                    <Show when={template().mimeType}>
                      <div>
                        <dt>MIME</dt>
                        <dd>{template().mimeType}</dd>
                      </div>
                    </Show>
                  </>
                )}
              </Show>
              <Show when={item.kind === "capability" ? item.value : undefined}>
                {(capability) => (
                  <>
                    <div>
                      <dt>ID</dt>
                      <dd>
                        <code>{capability().id}</code> · {capability().generation}
                      </dd>
                    </div>
                    <div>
                      <dt>{copy().kind}</dt>
                      <dd>{capability().kind}</dd>
                    </div>
                    <Show when={capability().reference}>
                      <div>
                        <dt>{copy().referenceID}</dt>
                        <dd>
                          <code>{capability().reference}</code>
                        </dd>
                      </div>
                    </Show>
                    <div>
                      <dt>{copy().boundary}</dt>
                      <dd>
                        {capability().permission}
                        <For each={capability().patterns}>
                          {(pattern) => (
                            <p>
                              <code>{pattern}</code>
                            </p>
                          )}
                        </For>
                      </dd>
                    </div>
                  </>
                )}
              </Show>
            </dl>
            <Show when={item.kind === "capability" && item.value.kind === "tool" ? item.value : undefined}>
              {(tool) => (
                <McpToolDetails api={props.api} location={props.location} capability={tool()} ready={props.ready} />
              )}
            </Show>
            <Show when={item.kind === "server" ? item : undefined}>
              {(server) => (
                <>
                  <Show when={connectionMessage(server().name)}>
                    <p class="arforge-management-search-scope" role="status">
                      {connectionMessage(server().name)}
                    </p>
                  </Show>
                  <ButtonV2
                    disabled={
                      state.loading ||
                      !!state.busy ||
                      state.configBusy ||
                      !connectionFresh() ||
                      server().status === "pending"
                    }
                    aria-busy={state.busy === server().name}
                    onClick={() => void toggle(server())}
                  >
                    {server().status === "connected"
                      ? copy().disconnect
                      : server().status === "needs_auth"
                        ? copy().authorize
                        : server().status === "pending"
                          ? copy().pending
                          : copy().connect}
                  </ButtonV2>
                  <ButtonV2
                    variant="neutral"
                    disabled={!props.ready() || !!state.busy || state.configBusy || state.editorOpen}
                    onClick={() => setState({ editorOpen: true, editorName: server().name })}
                  >
                    {copy().edit}
                  </ButtonV2>
                  <Show when={state.loading || state.busy || !connectionFresh()}>
                    <p class="arforge-management-search-scope">{copy().wait}</p>
                  </Show>
                </>
              )}
            </Show>
            <p class="arforge-management-search-scope">{copy().reference}</p>
            <Show when={props.sessionID} fallback={<ManagementStatus readOnly={copy().session} />}>
              <ButtonV2 variant="neutral" disabled={!props.ready() || !!state.busy} onClick={() => void navigate()}>
                {copy().open}
              </ButtonV2>
            </Show>
          </div>
        )}
      </ManagementCollection>
      <Show when={state.editorOpen}>
        <McpConnectionEditor
          name={state.editorName}
          scope={`${key()}\u0000${state.sourceEpoch}`}
          ready={props.ready()}
          load={loadConnections}
          save={saveConnection}
          onClose={() => setState({ editorOpen: false, editorName: undefined })}
          onSaved={() => setState("notice", copy().saved)}
        />
      </Show>
    </section>
  )
}
