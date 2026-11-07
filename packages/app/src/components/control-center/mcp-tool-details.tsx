import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import type { OperationsApi } from "@/utils/server"
import { createScopeRequestGuard } from "@/utils/scope-request"
import { matchesMcpToolDetailsSource } from "@/utils/mcp-tool-detail-source"
import { ManagementStatus } from "../settings-v2/management-status"

type Capability = Awaited<ReturnType<OperationsApi["mcp"]["capabilities"]>>["data"][number]
type Details = Awaited<ReturnType<OperationsApi["mcp"]["toolDetails"]>>["data"]

export function McpToolDetails(props: {
  api: () => { mcp: Pick<OperationsApi["mcp"], "toolDetails"> }
  location: () => { location: { directory: string; workspace?: string } }
  capability: Capability
  ready: () => boolean
}) {
  const language = useLanguage(),
    source = useServerSDK()
  const [state, setState] = createStore({ loading: false, error: "", value: undefined as Details | undefined })
  let disposed = false
  const [displayedOwner, setDisplayedOwner] = createSignal<ReturnType<typeof source>>()
  const key = () =>
    JSON.stringify([
      source().scope,
      props.location(),
      props.capability.server,
      props.capability.id,
      props.capability.generation,
      props.ready(),
    ])
  const guard = createScopeRequestGuard(key)
  const copy = () =>
    language.locale().startsWith("zh")
      ? {
          title: "工具详情",
          description: "工具描述",
          input: "输入参数",
          output: "输出结构",
          definition: "完整工具定义",
          loading: "正在读取工具资料…",
          retry: "重新读取",
          unavailable: "当前工具资料不可用。请刷新服务列表后重试。",
          readOnly: "这里仅展示服务提供的工具资料，不会执行工具。",
        }
      : {
          title: "Tool details",
          description: "Description",
          input: "Input parameters",
          output: "Output schema",
          definition: "Complete tool definition",
          loading: "Reading tool details…",
          retry: "Read again",
          unavailable: "The current tool details are unavailable. Refresh the server list and try again.",
          readOnly: "These are the server's advertised tool details. Viewing them does not execute the tool.",
        }
  const description = () => {
    const value = state.value?.definition.description
    return typeof value === "string" ? value : undefined
  }
  const load = async () => {
    if (disposed || !props.ready() || props.capability.kind !== "tool" || state.loading) return
    const token = guard.capture(),
      owner = source(),
      api = props.api()
    const request = {
      ...props.location(),
      server: props.capability.server,
      capabilityID: props.capability.id,
      generation: props.capability.generation,
    }
    const current = () => !disposed && props.ready() && source() === owner && guard.isCurrent(token)
    setState({ loading: true, error: "", value: undefined })
    try {
      const result = await api.mcp.toolDetails(request)
      if (!current()) return
      if (!matchesMcpToolDetailsSource(result, request)) throw new Error("Tool details source mismatch")
      setDisplayedOwner(() => owner)
      setState("value", result.data)
    } catch {
      if (current()) setState("error", copy().unavailable)
    } finally {
      if (current()) setState("loading", false)
    }
  }
  createEffect(
    on(
      () => [key(), source()] as const,
      () => {
        guard.invalidate()
        setDisplayedOwner(undefined)
        setState({ loading: false, error: "", value: undefined })
        if (props.ready()) void load()
      },
    ),
  )
  onCleanup(() => {
    disposed = true
    guard.invalidate()
  })
  return (
    <section
      class="arforge-management-task-form min-w-0"
      data-testid="mcp-tool-details"
      aria-label={copy().title}
      aria-busy={state.loading}
    >
      <h4>{copy().title}</h4>
      <Show when={state.loading}>
        <p role="status">{copy().loading}</p>
      </Show>
      <ManagementStatus error={state.error} />
      <Show when={source() === displayedOwner() ? state.value : undefined}>
        {(value) => (
          <>
            <Show when={description()}>
              {(description) => (
                <div>
                  <h5>{copy().description}</h5>
                  <p class="whitespace-pre-wrap break-words">{description()}</p>
                </div>
              )}
            </Show>
            <For each={["inputSchema", "outputSchema"] as const}>
              {(field) => (
                <Show when={value().definition[field] !== undefined}>
                  <details open={field === "inputSchema"} class="arforge-management-raw-details min-w-0">
                    <summary>{field === "inputSchema" ? copy().input : copy().output}</summary>
                    <pre
                      class="max-h-72 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-12-regular"
                      style={{ "overflow-wrap": "anywhere" }}
                    >
                      {JSON.stringify(value().definition[field], null, 2)}
                    </pre>
                  </details>
                </Show>
              )}
            </For>
            <details class="arforge-management-raw-details min-w-0">
              <summary>{copy().definition}</summary>
              <pre
                class="max-h-72 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-background-stronger p-3 text-12-regular"
                style={{ "overflow-wrap": "anywhere" }}
              >
                {JSON.stringify(value().definition, null, 2)}
              </pre>
            </details>
          </>
        )}
      </Show>
      <p class="arforge-management-search-scope">{copy().readOnly}</p>
      <ButtonV2 variant="ghost" disabled={!props.ready() || state.loading} onClick={() => void load()}>
        {copy().retry}
      </ButtonV2>
    </section>
  )
}
