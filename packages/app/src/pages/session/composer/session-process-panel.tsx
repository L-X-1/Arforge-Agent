import { For, Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "../session-layout"
import type { OperationsApi } from "@/utils/server"

type Snapshot = Awaited<ReturnType<OperationsApi["runtimeInsight"]["snapshot"]>>
type AuditEvent = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["evolutionAuditEvents"]>
>["data"]["items"][number]
type Candidate = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["evolutionCandidates"]>
>["data"]["items"][number]

const AUTO = (
  <span
    style="display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(34,197,94,0.14);color:#22c55e;font-weight:600;margin-left:8px"
  >
    自动
  </span>
)

const HUMAN = (
  <span
    style="display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600;margin-left:8px"
  >
    人工
  </span>
)

function runLabel(status: string): { text: string; color: string } {
  if (status === "running") return { text: "进行中", color: "#22c55e" }
  if (status === "completed") return { text: "已完成", color: "#818cf8" }
  if (status === "failed") return { text: "失败", color: "#ef4444" }
  if (status === "interrupted") return { text: "中断", color: "#f59e0b" }
  return { text: status, color: "#8b8b8b" }
}

const EVOLUTION_LABELS: Readonly<Record<string, string>> = {
  candidate_created: "发现失败并生成候选",
  candidate_evaluated: "隔离评测",
  candidate_approved: "人工批准",
  candidate_rejected: "人工拒绝",
  canary_started: "灰度运行",
  candidate_promoted: "晋升生效",
  candidate_rolled_back: "回滚",
}

function evolutionLabel(action: string): string {
  return EVOLUTION_LABELS[action] ?? action
}

const EVOLUTION_STAGES = ["发现失败", "生成候选", "隔离测试", "你审批", "灰度生效"] as const

function candidateStage(status: Candidate["state"]["status"]): number {
  if (status === "proposed") return 3
  if (status === "evaluated") return 4
  if (status === "approved" || status === "canary") return 5
  return 5
}

function sectionTitle(text: string) {
  return (
    <div style="color:var(--v2-text-text-muted);margin-bottom:6px;font-size:12px">{text}</div>
  )
}

function box() {
  return "padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
}

/**
 * 右侧面板下半部：运行过程（自动记录）+ 自主学习与进化（可操作）。
 * 展示自动记录的事实；人工操作集中在这里：审批进化候选、校验审计链。
 */
export function SessionProcessPanel() {
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const [state, setState] = createStore({
    loading: false,
    expanded: true,
    verifying: false,
    verifyMessage: "",
    actingCandidate: "",
    actionError: "",
    data: undefined as Snapshot | undefined,
    evolution: undefined as ReadonlyArray<AuditEvent> | undefined,
    candidates: undefined as ReadonlyArray<Candidate> | undefined,
  })
  const sessionID = () => params.id

  const refresh = async () => {
    if (!sessionID() || state.loading) return
    setState("loading", true)
    try {
      const [snapshot, evolution, candidates] = await Promise.all([
        serverSDK().operationsApi.runtimeInsight.snapshot({ limit: "100" }),
        serverSDK().operationsApi.agentCapabilities.evolutionAuditEvents({ limit: 100 }),
        serverSDK().operationsApi.agentCapabilities.evolutionCandidates({ limit: 50 }),
      ])
      setState({ data: snapshot, evolution: evolution.data.items, candidates: candidates.data.items })
    } catch {
      // 面板只读展示，失败静默
    } finally {
      setState("loading", false)
    }
  }
  const verifyAudit = async () => {
    if (state.verifying) return
    setState("verifying", true)
    try {
      const result = await serverSDK().operationsApi.runtimeInsight.auditVerify()
      setState(
        "verifyMessage",
        result.valid ? `审计链校验通过（${result.count} 条记录均未被篡改）。` : `审计链异常：${result.issue ?? "记录被篡改"}`,
      )
    } finally {
      setState("verifying", false)
    }
  }
  const transitionCandidate = async (candidate: Candidate, action: "approve" | "reject") => {
    if (state.actingCandidate) return
    const label = action === "approve" ? "批准" : "拒绝"
    if (!window.confirm(`${label}进化候选：${candidate.title}\n\n${candidate.rationale.slice(0, 200)}`)) return
    setState({ actingCandidate: candidate.candidate_id, actionError: "" })
    try {
      await serverSDK().operationsApi.agentCapabilities.evolutionTransition({
        ...params,
        candidateID: candidate.candidate_id,
        action,
        expectedRevision: candidate.state.revision,
        reason: `由对话界面${label}`,
      })
      await refresh()
    } catch (error) {
      setState("actionError", `${label}失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setState("actingCandidate", "")
    }
  }

  createEffect(
    on(
      () => sessionID(),
      (id) => {
        if (id) void refresh()
      },
    ),
  )
  onCleanup(
    sdk().event.on("session.status", (evt) => {
      if (evt.properties.sessionID !== sessionID()) return
      void refresh()
    }),
  )

  const runs = createMemo(() => (state.data?.runs ?? []).filter((run) => run.sessionID === sessionID()).slice(0, 2))
  const latestRun = createMemo(() => runs()[0])
  const routing = createMemo(
    () => (state.data?.routing ?? []).filter((decision) => decision.sessionID === sessionID()).slice(0, 2),
  )
  const verifications = createMemo(
    () => (state.data?.verifications ?? []).filter((verification) => verification.sessionID === sessionID()).slice(0, 2),
  )
  const memoryRecalls = createMemo(() =>
    (state.data?.recalls ?? [])
      .map((recall) => ({ ...recall, hits: recall.hits.filter((hit) => hit.score >= 0.1) }))
      .filter((recall) => recall.hits.length > 0)
      .slice(0, 5),
  )
  const auditEntries = createMemo(() => {
    return (state.data?.audit ?? []).filter((entry) => entry.metadata?.sessionID === sessionID()).slice(0, 4)
  })
  const auditTotal = createMemo(
    () =>
      (state.data?.audit ?? []).filter((entry) => entry.metadata?.sessionID === sessionID()).length,
  )
  const pendingCandidates = createMemo(
    () => (state.candidates ?? []).filter((candidate) => candidate.state.status === "proposed" || candidate.state.status === "evaluated"),
  )
  const evolutionEvents = createMemo(() => (state.evolution ?? []).slice(0, 3))
  const hasContent = createMemo(
    () => runs().length > 0 || routing().length > 0 || verifications().length > 0 || memoryRecalls().length > 0 || auditTotal() > 0 || pendingCandidates().length > 0 || evolutionEvents().length > 0,
  )

  return (
    <section data-component="session-process-panel" style="padding:12px 14px 14px;display:grid;gap:12px">
      <button
        type="button"
        onClick={() => setState("expanded", !state.expanded)}
        style="display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;text-align:left;padding:0"
      >
        <span style="font-size:13px;font-weight:600">运行过程</span>
        {AUTO}
        <span style="flex:1" />
        <Show when={latestRun()}>
          {(run) => {
            const label = runLabel(run().status)
            return (
              <span style="font-size:12px;color:var(--v2-text-text-muted);display:flex;align-items:center;gap:6px">
                <i style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${label.color}`} />
                {label.text}
              </span>
            )
          }}
        </Show>
        <span style="font-size:12px;color:var(--v2-text-text-muted)">{state.expanded ? "收起" : "展开"}</span>
      </button>

      <Show when={state.expanded}>
        <Show when={!hasContent()}>
          <p style="margin:0;color:var(--v2-text-text-muted);font-size:12px;line-height:1.6">
            开始一次对话后，这里会自动显示运行过程与进化迭代。
          </p>
        </Show>

        {/* 自主学习与进化（可操作） */}
        <Show when={pendingCandidates().length > 0 || evolutionEvents().length > 0}>
          <div>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              <span style="font-size:12px;font-weight:600">自主学习与进化</span>
              {AUTO}
              <Show when={pendingCandidates().length > 0}>{HUMAN}</Show>
            </div>
            <Show when={pendingCandidates().length === 0}>
              <p style="margin:4px 0 0;font-size:12px;color:var(--v2-text-text-muted)">
                系统自动完成：发现失败 → 生成候选 → 隔离测试 → 灰度 → 晋升或回滚。
              </p>
            </Show>

            {/* 五阶段进度条 */}
            <div style="display:flex;align-items:center;gap:2px;margin:8px 0 4px">
              <For each={EVOLUTION_STAGES}>
                {(stage, index) => {
                  const active = pendingCandidates().some(
                    (candidate) => candidateStage(candidate.state.status) === index() + 1,
                  )
                  const passed = pendingCandidates().some(
                    (candidate) => candidateStage(candidate.state.status) > index() + 1,
                  )
                  const reached = active || passed
                  return (
                    <>
                      <span
                        style={`flex:1;text-align:center;font-size:10px;line-height:1.3;padding:3px 2px;border-radius:6px;font-weight:${active ? 600 : 400};color:${active ? "#f59e0b" : reached ? "#22c55e" : "var(--v2-text-text-muted)"};background:${active ? "rgba(245,158,11,0.12)" : "transparent"}`}
                      >
                        {index() + 1} {stage}
                      </span>
                      <Show when={index() < EVOLUTION_STAGES.length - 1}>
                        <span style="color:var(--v2-text-text-muted);font-size:10px">→</span>
                      </Show>
                    </>
                  )
                }}
              </For>
            </div>

            <For each={pendingCandidates()}>
              {(candidate) => (
                <div style={`${box()};margin-top:6px`}>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span style="font-size:12px;font-weight:600">{candidate.title.slice(0, 50)}</span>
                    <Show
                      when={candidate.evaluation?.gate_passed}
                      fallback={
                        <span
                          style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600"
                        >
                          {candidate.state.status === "proposed" ? "隔离测试进行中" : "等待你审批"}
                        </span>
                      }
                    >
                      <span
                        style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(34,197,94,0.14);color:#22c55e;font-weight:600"
                      >
                        测试通过 · 等你审批
                      </span>
                    </Show>
                  </div>
                  <div style="font-size:12px;color:var(--v2-text-text-muted);margin:2px 0 6px">
                    为什么：{candidate.rationale.slice(0, 90)}
                    {candidate.evidence_refs.length > 0
                      ? `（依据 ${candidate.evidence_refs.length} 条）`
                      : ""}
                  </div>
                  <div style="font-size:11px;margin:0 0 6px">
                    <Show
                      when={candidate.evaluation?.gate_passed}
                      fallback={
                        <span style="color:#ef4444">隔离测试未通过，不建议批准</span>
                      }
                    >
                      <span style="color:#22c55e">隔离测试已通过，可以放心审批</span>
                    </Show>
                  </div>
                  <div style="display:flex;gap:8px">
                    <button
                      type="button"
                      disabled={state.actingCandidate === candidate.candidate_id}
                      onClick={() => void transitionCandidate(candidate, "approve")}
                      style="font-size:12px;padding:4px 12px;border-radius:8px;border:none;cursor:pointer;background:rgba(34,197,94,0.15);color:#22c55e;font-weight:600"
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      disabled={state.actingCandidate === candidate.candidate_id}
                      onClick={() => void transitionCandidate(candidate, "reject")}
                      style="font-size:12px;padding:4px 12px;border-radius:8px;border:none;cursor:pointer;background:rgba(239,68,68,0.12);color:#ef4444;font-weight:600"
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              )}
            </For>
            <Show when={state.actionError}>
              <p style="margin:6px 0 0;font-size:12px;color:#ef4444">{state.actionError}</p>
            </Show>
            <Show when={evolutionEvents().length > 0 && pendingCandidates().length === 0}>
              <div style="display:grid;gap:2px;margin-top:6px;font-size:12px;color:var(--v2-text-text-muted)">
                <For each={evolutionEvents()}>
                  {(event) => (
                    <div style="display:flex;gap:8px;align-items:center">
                      <span
                        style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${event.action === "candidate_approved" || event.action === "candidate_promoted" ? "#22c55e" : event.action === "candidate_rejected" || event.action === "candidate_rolled_back" ? "#ef4444" : "#818cf8"}`}
                      />
                      <span>{evolutionLabel(event.action)}</span>
                      <span style="font-family:monospace">
                        {event.subject_id ? event.subject_id.slice(0, 8) : ""}
                      </span>
                      {event.action === "candidate_approved" || event.action === "candidate_rejected" ? (
                        <span style="font-size:11px;color:#f59e0b;font-weight:600">(人工)</span>
                      ) : null}
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* 会话状态 */}
        <Show when={runs().length > 0}>
          <div>
            {sectionTitle("会话状态 · 自动记录")}
            <For each={runs()}>
              {(run) => {
                const label = runLabel(run.status)
                return (
                  <div style={`${box()};margin-bottom:4px;display:flex;align-items:center;gap:8px`}>
                    <i style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${label.color}`} />
                    <span>
                      {label.text} · {new Date(run.startedAt).toLocaleTimeString()}
                    </span>
                    <Show when={run.status === "interrupted" || run.status === "failed"}>
                      <span style="color:var(--v2-text-text-muted)">可发送消息或用 /continue 继续</span>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* 模型选择 */}
        <Show when={routing().length > 0}>
          <div>
            {sectionTitle("模型选择 · 自动")}
            <For each={routing()}>
              {(decision) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <b>
                    {decision.providerID}/{decision.modelID}
                  </b>{" "}
                  <span style="color:var(--v2-text-text-muted)">{decision.reason}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* 验证 */}
        <Show when={verifications().length > 0}>
          <div>
            {sectionTitle("交付前验证 · 自动")}
            <For each={verifications()}>
              {(verification) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <span style={`font-weight:600;${verification.passed ? "color:#22c55e" : "color:#ef4444"}`}>
                    {verification.passed ? "通过" : "未通过"}
                  </span>{" "}
                  <span style="color:var(--v2-text-text-muted)">
                    {verification.commands.map((command) => `$ ${command}`).join("  ")}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* 记忆检索 */}
        <Show when={memoryRecalls().length > 0}>
          <div>
            {sectionTitle("记忆检索 · 自动")}
            <For each={memoryRecalls()}>
              {(recall) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span style="font-size:12px;font-weight:600">“{recall.query.slice(0, 30)}”</span>
                    <span
                      style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(129,140,248,0.15);color:#818cf8;font-weight:600"
                    >
                      {recall.algorithm}
                    </span>
                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                      {new Date(recall.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div style="display:grid;gap:2px;margin-top:4px">
                    <For each={recall.hits}>
                      {(hit) => (
                        <div style="display:flex;gap:8px;align-items:baseline;font-size:12px">
                          <span style="font-family:monospace;color:var(--v2-text-text-muted)">
                            {hit.memoryID.slice(0, 8)}
                          </span>
                          <span
                            style="flex:1;color:var(--v2-text-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                            title={hit.content}
                          >
                            {hit.content.slice(0, 60)}
                          </span>
                          <span style="font-family:monospace;color:#22c55e">{(hit.score * 100).toFixed(0)}%</span>
                          <span
                            style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600"
                          >
                            {hit.source}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* 审计 */}
        <Show when={auditTotal() > 0}>
          <div>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              <span style="font-size:12px">操作记录</span>
              <span style="font-size:11px;color:var(--v2-text-text-muted)">自动记录 · 人工可校验</span>
              <button
                type="button"
                style="margin-left:auto;font-size:11px;color:#818cf8;background:none;border:none;cursor:pointer;text-decoration:underline"
                disabled={state.verifying}
                onClick={() => void verifyAudit()}
              >
                {state.verifying ? "校验中…" : "校验是否被篡改"}
              </button>
            </div>
            <Show when={state.verifyMessage}>
              <p
                style={`margin:4px 0;font-size:12px;${state.verifyMessage.startsWith("审计链校验通过") ? "color:#22c55e" : "color:#ef4444"}`}
              >
                {state.verifyMessage}
              </p>
            </Show>
            <div style="display:grid;gap:2px;margin-top:4px;font-family:monospace;font-size:12px;color:var(--v2-text-text-muted)">
              <For each={auditEntries()}>
                {(entry) => (
                  <div style="display:flex;gap:8px">
                    <span>#{entry.seq}</span>
                    <span>
                      {entry.action === "tool.execute.start"
                        ? "开始"
                        : entry.action === "tool.execute.end"
                          ? "结束"
                          : entry.action}
                    </span>
                    <span>{entry.resource}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </Show>
    </section>
  )
}
