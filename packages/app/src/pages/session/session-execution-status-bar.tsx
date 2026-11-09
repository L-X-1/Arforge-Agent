import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { ExecutionTrace } from "./execution-trace-model"
import { countVerificationOutcomes, type ExecutionEvidence } from "./execution-evidence"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"

export function SessionExecutionStatusBar(props: {
  trace: ExecutionTrace
  evidence: ExecutionEvidence
  label: string
  opened: boolean
  onOpen: () => void
}) {
  const language = useLanguage()
  const zh = () => language.locale().startsWith("zh")
  const running = () => props.trace.status !== "idle" || props.trace.phase === "approval"
  const [clock, setClock] = createStore({ now: Date.now() })
  const timing = createMemo(() => {
    const starts = props.trace.steps
      .map((step) => step.startedAt)
      .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time > 0)
    const ends = props.trace.steps
      .map((step) => step.endedAt)
      .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
    return { start: starts.length ? Math.min(...starts) : props.trace.startedAt, end: ends.length ? Math.max(...ends) : undefined }
  })
  createEffect(() => {
    if (!running() || timing().start === undefined) return
    setClock("now", Date.now())
    const timer = window.setInterval(() => setClock("now", Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })
  const current = createMemo(() => {
    const steps = props.trace.steps
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === "running") return steps[i]
    return steps[steps.length - 1]
  })
  const elapsed = createMemo(() => {
    const { start, end } = timing()
    if (start === undefined || (!running() && end === undefined)) return undefined
    const seconds = Math.max(0, Math.floor(((running() ? clock.now : end!) - start) / 1000))
    return seconds + (zh() ? " 秒" : "s")
  })
  const stepSummary = createMemo(() => {
    const approval = props.trace.approval
    if (approval) {
      const command = approval.tool.state.input.command
      return (typeof command === "string" ? command : approval.tool.tool).replace(/\s+/g, " ").trim().slice(0, 80)
    }
    if (!running() || props.trace.phase === "started") return undefined
    const step = current()
    if (!step) return undefined
    if (step.kind === "answer") return zh() ? "生成答复" : "Deliver answer"
    if (step.kind === "reasoning") return zh() ? "分析任务" : "Analyze task"
    return (step.title || step.preview)?.replace(/\s+/g, " ").trim().slice(0, 80)
  })
  const counts = createMemo(() => {
    const files = new Set(props.evidence.files.map((file) => file.file)).size
    const { passed, failed, incomplete } = countVerificationOutcomes(props.evidence.verifications)
    const results = [
      files ? (zh() ? `${files} 个文件` : `${files} ${files === 1 ? "file" : "files"}`) : undefined,
      passed ? (zh() ? `${passed} 条验证通过` : `${passed} passed`) : undefined,
      failed ? (zh() ? `${failed} 条验证失败` : `${failed} failed`) : undefined,
      incomplete && !running() ? (zh() ? `${incomplete} 条验证未完成` : `${incomplete} incomplete`) : undefined,
    ].filter(Boolean).join(" · ")
    if (results) return results
    const steps = props.trace.phase === "started" ? 0 : props.trace.steps.length
    if (steps) return zh() ? `${steps} 步` : `${steps} ${steps === 1 ? "step" : "steps"}`
  })
  const summary = createMemo(() =>
    [props.label, stepSummary(), elapsed(), counts()]
      .filter(Boolean)
      .join(" · "),
  )
  return (
    <div class="flex min-h-8 shrink-0 items-center border-t border-v2-border-border-muted px-4">
      <button
        type="button"
        data-component="execution-status-bar"
        data-execution-phase={props.trace.phase}
        class="group flex h-8 min-w-0 max-w-full items-center gap-2 whitespace-nowrap rounded-lg border-0 bg-transparent px-2 text-left transition-colors duration-140 hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
        onClick={props.onOpen}
        aria-label={summary()}
        title={summary()}
        aria-expanded={props.opened}
        aria-controls={props.opened ? "execution-trace-panel" : undefined}
      >
        <span
          class="relative block size-2 shrink-0 rounded-full bg-v2-icon-icon-muted"
          data-running={running() && props.trace.phase !== "approval" ? "" : undefined}
          data-state={props.trace.phase === "approval" ? "warning" : undefined}
          aria-hidden="true"
        />
        <span class="shrink-0 text-[12px] font-normal leading-none text-v2-text-text-muted" aria-live="polite">{props.label}</span>
        <Show when={stepSummary()}>
          <span class="min-w-0 truncate text-[12px] text-v2-text-text-muted" title={stepSummary()}>
            {stepSummary()}
          </span>
        </Show>
        <Show when={elapsed()}>
          {(value) => <span class="shrink-0 text-[12px] tabular-nums text-v2-text-text-muted">{value()}</span>}
        </Show>
        <Show when={counts()}>
          {(value) => (
            <span class="min-w-0 truncate rounded-full bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[12px] font-normal leading-none text-v2-text-text-muted">
              {value()}
            </span>
          )}
        </Show>
        <IconV2 name="chevron-down" class="shrink-0 -rotate-90 text-v2-icon-icon-muted" />
      </button>
    </div>
  )
}
