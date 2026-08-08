import { For, Show, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"

type AuditEvent = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["evolutionAuditEvents"]>
>["data"]["items"][number]

const ACTION_LABELS: Readonly<Record<string, { label: string; auto: boolean; color: string }>> = {
  candidate_created: { label: "发现失败并生成候选", auto: true, color: "#8b8b8b" },
  candidate_evaluated: { label: "隔离评测", auto: true, color: "#818cf8" },
  candidate_approved: { label: "人工批准", auto: false, color: "#22c55e" },
  candidate_rejected: { label: "人工拒绝", auto: false, color: "#ef4444" },
  canary_started: { label: "灰度运行", auto: true, color: "#f59e0b" },
  candidate_promoted: { label: "晋升生效", auto: true, color: "#22c55e" },
  candidate_rolled_back: { label: "回滚", auto: true, color: "#ef4444" },
  exposure_prepared: { label: "曝光准备", auto: true, color: "#8b8b8b" },
}

function actionInfo(action: string): { label: string; auto: boolean; color: string } {
  const known = ACTION_LABELS[action]
  if (known) return known
  const auto = action.startsWith("candidate_") || action.startsWith("canary_") || action.startsWith("exposure_")
  return { label: action, auto, color: "#8b8b8b" }
}

function isHumanAction(event: AuditEvent): boolean {
  const info = actionInfo(event.action)
  if (!info.auto) return true
  const metadata = (event.metadata ?? {}) as Record<string, unknown>
  if (metadata.automatic === false) return true
  const actor = event.actor ?? ""
  return actor.startsWith("user:") || actor.startsWith("admin:")
}

function shortID(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id
}

interface CandidateChain {
  readonly id: string
  readonly events: ReadonlyArray<AuditEvent>
  readonly status: { label: string; color: string; pendingHuman: boolean }
}

function chainStatus(events: ReadonlyArray<AuditEvent>): CandidateChain["status"] {
  const actions = events.map((event) => event.action)
  if (actions.includes("candidate_rolled_back"))
    return { label: "已回滚", color: "#ef4444", pendingHuman: false }
  if (actions.includes("candidate_promoted")) return { label: "已晋升生效", color: "#22c55e", pendingHuman: false }
  if (actions.includes("candidate_rejected")) return { label: "已拒绝", color: "#8b8b8b", pendingHuman: false }
  if (actions.includes("candidate_approved")) return { label: "灰度或生效中", color: "#f59e0b", pendingHuman: false }
  if (actions.includes("candidate_evaluated"))
    return { label: "待人工审批", color: "#f59e0b", pendingHuman: true }
  return { label: "评测中", color: "#818cf8", pendingHuman: false }
}

function buildChains(events: ReadonlyArray<AuditEvent>): ReadonlyArray<CandidateChain> {
  const byCandidate = new Map<string, AuditEvent[]>()
  for (const event of events) {
    if (event.subject_kind !== "candidate" || !event.subject_id) continue
    const list = byCandidate.get(event.subject_id) ?? []
    list.push(event)
    byCandidate.set(event.subject_id, list)
  }
  return [...byCandidate.entries()]
    .map(([id, chain]) => {
      chain.sort((a, b) => a.sequence - b.sequence)
      return { id, events: chain, status: chainStatus(chain) }
    })
    .toSorted((a, b) => b.events.at(-1)!.sequence - a.events.at(-1)!.sequence)
    .slice(0, 20)
}

export function EvolutionTimeline(props: {
  api: () => OperationsApi
  location: () => unknown
  ready: () => boolean
}) {
  const [state, setState] = createStore({
    loading: false,
    error: "",
    events: undefined as ReadonlyArray<AuditEvent> | undefined,
    chainValid: false,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState("loading", true)
    try {
      const result = await props.api().agentCapabilities.evolutionAuditEvents({ limit: 200 })
      setState({ events: result.data.items, chainValid: result.data.valid, error: "" })
    } catch (error) {
      setState("error", String(error instanceof Error ? error.message : error))
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
  const chains = createMemo(() => buildChains(state.events ?? []))
  const pendingHuman = createMemo(() => chains().filter((chain) => chain.status.pendingHuman).length)

  return (
    <section>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap">
        <button class="arforge-btn" disabled={state.loading} onClick={() => void refresh()}>
          {state.loading ? "刷新中…" : "刷新"}
        </button>
        <span style="font-size:12px;color:var(--v2-text-text-muted)">
          迭代 {chains().length} 条 · 待审批 {pendingHuman()} 条
          {state.chainValid ? " · 审计链完整" : " · 审计链异常"}
        </span>
      </div>
      <Show when={state.error}>
        <p style="color:#ef4444;font-size:12px">{state.error}</p>
      </Show>
      <Show when={!state.events && !state.error}>
        <p style="font-size:12px;color:var(--v2-text-text-muted)">
          暂无进化迭代记录。系统发现失败模式后会自动生成候选并进入迭代流程。
        </p>
      </Show>
      <Show when={state.events}>
        <p style="font-size:12px;color:var(--v2-text-text-muted);margin:0 0 10px">
          系统自动完成：发现失败 → 生成候选 → 隔离评测 → 灰度 → 晋升或回滚。
          <b style="color:#f59e0b">待人工审批</b>的迭代需要你确认。
        </p>
      </Show>
      <For each={chains()}>
        {(chain) => (
          <article
            style="margin-bottom:8px;padding:10px 12px;border-radius:10px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
          >
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span style="font-family:monospace;font-size:12px">{shortID(chain.id)}</span>
              <span style="flex:1" />
              <span
                style={`font-size:11px;padding:1px 8px;border-radius:10px;font-weight:600;color:${chain.status.color};background:${chain.status.color}22`}
              >
                {chain.status.label}
              </span>
              {chain.status.pendingHuman ? (
                <span
                  style="font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600"
                >
                  人工
                </span>
              ) : (
                <span
                  style="font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(34,197,94,0.14);color:#22c55e;font-weight:600"
                >
                  自动
                </span>
              )}
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <For each={chain.events}>
                {(event) => {
                  const info = actionInfo(event.action)
                  return (
                    <span
                      style="display:flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
                    >
                      <i style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${info.color}`} />
                      {info.label}
                      <Show when={!info.auto}>
                        <b style="color:#f59e0b">(人工)</b>
                      </Show>
                    </span>
                  )
                }}
              </For>
            </div>
          </article>
        )}
      </For>
    </section>
  )
}
