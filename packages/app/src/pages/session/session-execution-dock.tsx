import type { JSX } from "solid-js"
import { Index, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@arforge-ai/ui/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  buildExecutionTrace,
  type ExecutionTraceKind,
  type ExecutionTraceStep,
} from "./execution-trace-model"
import "./session-execution-dock.css"
import "@/components/preview/workbench-review.css"
import { ExecutionStepDetail } from "./execution-step-detail"
import { SessionExecutionHistory } from "./session-execution-history"

type Copy = ReturnType<typeof copy>

function copy(locale: string) {
  const chinese = locale === "zh" || locale === "zht"
  return chinese
    ? {
        title: "可视化执行",
        expand: "展开可视化执行",
        collapse: "收起可视化执行",
        idle: "等待下一项任务",
        running: "正在实时执行",
        retry: "正在重试",
        complete: "本轮执行完成",
        empty: "开始执行后，这里会实时展示推理摘要、工具调用和文件变更。",
        detail: "查看详情",
        hideDetail: "收起详情",
        completed: "已完成",
        failed: "失败",
        current: "进行中",
        pending: "等待中",
        subagents: "真实子 Agent",
        active: "活跃",
        used: "本轮",
        kinds: {
          reasoning: "分析任务",
          context: "检索上下文",
          command: "执行命令",
          edit: "修改文件",
          agent: "调度子 Agent",
          verify: "验证结果",
          tool: "调用工具",
          answer: "生成答复",
          retry: "重试请求",
        } satisfies Record<ExecutionTraceKind, string>,
      }
    : {
        title: "Visual execution",
        expand: "Expand visual execution",
        collapse: "Collapse visual execution",
        idle: "Waiting for the next task",
        running: "Executing live",
        retry: "Retrying",
        complete: "Execution complete",
        empty: "Reasoning summaries, tool calls, and file changes will appear here as the task runs.",
        detail: "Show details",
        hideDetail: "Hide details",
        completed: "Completed",
        failed: "Failed",
        current: "In progress",
        pending: "Pending",
        subagents: "Live Subagents",
        active: "active",
        used: "this turn",
        kinds: {
          reasoning: "Analyze task",
          context: "Inspect context",
          command: "Run commands",
          edit: "Modify files",
          agent: "Coordinate agents",
          verify: "Verify result",
          tool: "Use tool",
          answer: "Deliver answer",
          retry: "Retry request",
        } satisfies Record<ExecutionTraceKind, string>,
      }
}

function stepIcon(kind: ExecutionTraceKind): JSX.Element {
  const name = {
    reasoning: "brain",
    context: "magnifying-glass",
    command: "console",
    edit: "pencil-line",
    agent: "subagent",
    verify: "checklist",
    tool: "status",
    answer: "prompt",
    retry: "warning",
  } as const
  return <Icon name={name[kind]} size="small" />
}

function statusLabel(step: ExecutionTraceStep, words: Copy) {
  if (step.status === "completed") return words.completed
  if (step.status === "error") return words.failed
  if (step.status === "running") return words.current
  return words.pending
}

function elapsed(step: ExecutionTraceStep) {
  if (step.startedAt === undefined || step.endedAt === undefined || step.endedAt < step.startedAt) return undefined
  const duration = step.endedAt - step.startedAt
  if (duration < 1_000) return `${Math.round(duration)} ms`
  if (duration < 60_000) return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)} s`
  return `${Math.floor(duration / 60_000)}m ${Math.round((duration % 60_000) / 1_000)}s`
}

export function SessionExecutionDock(props: { opened: boolean; onOpenChange: (opened: boolean) => void }) {
  const language = useLanguage()
  const sync = useSync()
  const { params, sessionKey } = useSessionLayout()
  const words = createMemo(() => copy(language.locale()))
  const [state, setState] = createStore({
    tab: "current" as "current" | "history",
    selectedStep: undefined as string | null | undefined,
    selectionScope: "",
  })

  const messages = createMemo(() => {
    const sessionID = params.id
    return sessionID ? (sync().data.message[sessionID] ?? []) : []
  })
  const trace = createMemo(() => {
    const sessionID = params.id
    return buildExecutionTrace({
      messages: messages(),
      parts: (messageID) => sync().data.part[messageID] ?? [],
      status: sessionID ? (sync().data.session_status[sessionID] ?? { type: "idle" }) : { type: "idle" },
    })
  })
  const running = createMemo(() => trace().status !== "idle")
  const activeStep = createMemo(() =>
    trace().steps.findLast((step) => step.status === "running" || step.status === "pending"),
  )
  const currentStep = createMemo(() => activeStep() ?? trace().steps.at(-1))
  const selectedStep = createMemo(() => state.selectedStep === null ? undefined :
    trace().steps.find((step) => step.id === state.selectedStep || step.sections?.some((section) => section.source === state.selectedStep)) ?? currentStep())
  createEffect(() => {
    const scope = sessionKey() + "\u0000" + (trace().userMessageID ?? "")
    if (state.selectionScope === scope) return
    setState({ selectionScope: scope, selectedStep: undefined })
  })
  const turnStartedAt = createMemo(() => messages().findLast((message) => message.role === "user")?.time.created ?? 0)
  const turnChildren = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []
    const linked = new Set(trace().steps.flatMap((step) => (step.agentSessionID ? [step.agentSessionID] : [])))
    return sync().data.session.filter((session) => {
      if (session.parentID !== sessionID) return false
      if (linked.has(session.id)) return true
      return (session.time?.created ?? 0) >= turnStartedAt()
    })
  })
  const activeSubagents = createMemo(() =>
    turnChildren().filter((session) => (sync().data.session_status[session.id] ?? { type: "idle" }).type !== "idle"),
  )
  const usedSubagents = createMemo(() => turnChildren().length)
  const headline = createMemo(() => {
    if (trace().status === "retry") return words().retry
    if (running()) return words().running
    if (trace().failed > 0) return words().failed
    if (trace().steps.length > 0) return words().complete
    return words().idle
  })
  const actionLabel = createMemo(() => {
    if (!running()) return headline()
    const step = currentStep()
    if (!step) return headline()
    return `${words().kinds[step.kind]}${step.count > 1 ? ` × ${step.count}` : ""}`
  })

  createEffect(() => {
    if (!props.opened) return
    const id = activeStep()?.id
    if (!id) return
    queueMicrotask(() => {
      const escaped = typeof CSS === "undefined" ? id : CSS.escape(id)
      document.querySelector(`[data-execution-step="${escaped}"]`)?.scrollIntoView({ block: "nearest" })
    })
  })

  return (
    <aside
      id="execution-trace-panel"
      class="arforge-review-workbench execution-dock shrink-0 min-h-0 h-full rounded-l-[16px] rounded-r-none border border-r-0 border-v2-border-border-muted bg-v2-background-bg-base overflow-hidden"
      classList={{ "execution-dock--open": props.opened, "execution-dock--running": running() }}
      aria-label={words().title}
    >
      <Show
        when={props.opened}
        fallback={
          <button
            type="button"
            class="execution-dock__rail"
            onClick={() => props.onOpenChange(true)}
            aria-label={words().expand}
            aria-expanded="false"
            aria-controls="execution-trace-content"
          >
            <span class="execution-dock__rail-indicator" data-status={running() ? "running" : "idle"}>
              <Icon name="console" size="small" />
            </span>
            <span class="execution-dock__rail-label">{words().title}</span>
            <Show when={trace().steps.length > 0}>
              <span class="execution-dock__rail-count">{trace().steps.length}</span>
            </Show>
          </button>
        }
      >
        <div id="execution-trace-content" class="execution-dock__content">
          <header class="execution-dock__header">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h2 class="truncate text-[14px] font-[600] leading-5 text-v2-text-text-base">{words().title}</h2>
              </div>
              <p class="mt-0.5 truncate text-[12px] leading-4 text-v2-text-text-muted" aria-live="polite">
                {headline()}
              </p>
            </div>
            <div class="execution-dock__header-actions">
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="normal"
                aria-label={words().collapse}
                aria-expanded="true"
                aria-controls="execution-trace-content"
                onClick={() => props.onOpenChange(false)}
                icon={<Icon name="chevron-double-right" size="small" />}
              />
            </div>
          </header>
          <div class="execution-dock__view-tabs" role="tablist" aria-label={language.locale().startsWith("zh") ? "执行视图" : "Execution views"}
            onKeyDown={(event) => {
              if (event.isComposing || event.keyCode === 229 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
              const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
              const index = controls.findIndex(control => control === document.activeElement)
              const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length
              const target = controls[next]
              if (!target) return
              event.preventDefault()
              setState("tab", target.dataset.executionView === "history" ? "history" : "current")
              target.focus()
            }}>
            <button type="button" role="tab" id="execution-current-tab" data-execution-view="current" aria-controls="execution-current-view"
              aria-selected={state.tab === "current"} tabIndex={state.tab === "current" ? 0 : -1} onClick={() => setState("tab", "current")}>
              {language.locale().startsWith("zh") ? "当前执行" : "Current execution"}
            </button>
            <button type="button" role="tab" id="execution-history-tab" data-execution-view="history" aria-controls="execution-history-view"
              aria-selected={state.tab === "history"} tabIndex={state.tab === "history" ? 0 : -1} onClick={() => setState("tab", "history")}>
              {language.locale().startsWith("zh") ? "历史记录" : "History"}
            </button>
          </div>
          <Show when={state.tab === "current"} fallback={<div id="execution-history-view" class="execution-history-view" role="tabpanel" aria-labelledby="execution-history-tab"><SessionExecutionHistory /></div>}>
          <div id="execution-current-view" class="execution-current-view" role="tabpanel" aria-labelledby="execution-current-tab">
          <div class="execution-dock__activity" aria-live="polite">
            <span>{actionLabel()}</span>
            <span class="execution-dock__subagent-count">
              {words().subagents} · {words().active} {activeSubagents().length} · {words().used} {usedSubagents()}
            </span>
          </div>

          <Show when={trace().steps.length > 0} fallback={<div class="execution-dock__empty">{words().empty}</div>}>
            <div class="execution-dock__summary">
              <span>
                {words().completed} {trace().completed}/{trace().steps.length}
              </span>
              <Show when={trace().failed > 0}>
                <span class="execution-dock__failed">
                  {words().failed} {trace().failed}
                </span>
              </Show>
            </div>
            <div class="execution-workbench">
            <ol class="execution-dock__steps" aria-label={words().title}>
              {/* Trace objects are rebuilt for every streaming packet. Preserve each existing DOM slot so its
                  entrance animation runs once instead of replaying across the whole list. */}
              <Index each={trace().steps}>
                {(step, index) => {
                  const expandable = () => !!step().detail
                  const expanded = () => selectedStep()?.id === step().id
                  const label = () => `${words().kinds[step().kind]}${step().count > 1 ? ` × ${step().count}` : ""}`
                  return (
                    <li
                      class="execution-step"
                      classList={{
                        "execution-step--active": step().status === "running" || step().status === "pending",
                      }}
                      data-status={step().status}
                      data-execution-step={step().id}
                      style={{ "--execution-index": Math.min(index, 8) }}
                    >
                      <span class="execution-step__marker" aria-hidden="true">
                        {stepIcon(step().kind)}
                      </span>
                      <button
                        type="button"
                        class="execution-step__button"
                        disabled={!expandable()}
                        aria-expanded={expandable() ? expanded() : undefined}
                        aria-label={
                          [expandable() ? `${expanded() ? words().hideDetail : words().detail}: ${label()}` : label(), step().title, statusLabel(step(), words()), elapsed(step())].filter(Boolean).join(" · ")
                        }
                        title={[label(), step().title, statusLabel(step(), words()), elapsed(step())].filter(Boolean).join(" · ")}
                        onClick={() => expandable() && setState("selectedStep", expanded() ? null : step().sections?.[0]?.source ?? step().id)}
                      >
                        <span class="execution-step__title">{step().title ? `${label()} · ${step().title}` : label()}</span>
                        <Show when={elapsed(step())}>{(duration) => <span class="execution-step__duration">{duration()}</span>}</Show>
                        <span class="execution-step__status" data-status={step().status}>
                          {statusLabel(step(), words())}
                        </span>
                        <Show when={expandable()}>
                          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                        </Show>
                      </button>
                    </li>
                  )
                }}
              </Index>
            </ol>
            <Show when={selectedStep()}>{(step) => <ExecutionStepDetail step={step()} chinese={language.locale().startsWith("zh")} />}</Show>
            </div>
          </Show>
          </div>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
