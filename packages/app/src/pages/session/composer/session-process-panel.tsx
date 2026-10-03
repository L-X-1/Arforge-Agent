import { For, Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "../session-layout"
import type { OperationsApi } from "@/utils/server"
import {
  actionStatusText,
  auditActionText,
  authorityText,
  costText,
  durationText,
  formatRuntimeTime,
  riskTierText,
  runtimeModelText,
  runtimeReasonText,
  runStatus,
  sessionProcessCopy,
} from "@/components/control-center/runtime-insight-presentation"

type Snapshot = Awaited<ReturnType<OperationsApi["runtimeInsight"]["snapshot"]>>
type AuditEvent = Awaited<
  ReturnType<OperationsApi["agentCapabilities"]["evolutionAuditEvents"]>
>["data"]["items"][number]
type Candidate = Awaited<ReturnType<OperationsApi["agentCapabilities"]["evolutionCandidates"]>>["data"]["items"][number]

function badge(label: string, tone: "automatic" | "human") {
  const colors =
    tone === "automatic"
      ? { background: "rgba(34,197,94,0.14)", color: "#22c55e" }
      : { background: "rgba(245,158,11,0.15)", color: "#f59e0b" }
  return (
    <span
      style={`display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:${colors.background};color:${colors.color};font-weight:600;margin-left:8px`}
    >
      {label}
    </span>
  )
}

function authorityLabel(
  authority: string,
  locale: Parameters<typeof authorityText>[1],
): { text: string; color: string; background: string } {
  if (authority === "automatic")
    return { text: authorityText(authority, locale), color: "#22c55e", background: "rgba(34,197,94,0.14)" }
  if (authority === "scoped_grant")
    return { text: authorityText(authority, locale), color: "#818cf8", background: "rgba(129,140,248,0.15)" }
  if (authority === "human")
    return { text: authorityText(authority, locale), color: "#f59e0b", background: "rgba(245,158,11,0.15)" }
  return { text: authorityText(authority, locale), color: "#ef4444", background: "rgba(239,68,68,0.12)" }
}

function candidateStage(status: Candidate["state"]["status"]): number {
  if (status === "proposed") return 3
  if (status === "evaluated") return 4
  if (status === "approved" || status === "canary") return 5
  return 5
}

function sectionTitle(text: string) {
  return <div style="color:var(--v2-text-text-muted);margin-bottom:6px;font-size:12px">{text}</div>
}

function box() {
  return "padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
}

/**
 * 右侧面板下半部：运行过程（自动记录）+ 自主学习与进化（可操作）。
 * 展示自动记录的事实；人工操作集中在这里：审批进化候选、校验审计链。
 */
export function SessionProcessPanel() {
  const language = useLanguage()
  const copy = () => sessionProcessCopy(language.locale())
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const [state, setState] = createStore({
    loading: false,
    expanded: true,
    verifying: false,
    verifyMessage: "",
    refreshError: "",
    actingCandidate: "",
    actionError: "",
    data: undefined as Snapshot | undefined,
    evolution: undefined as ReadonlyArray<AuditEvent> | undefined,
    candidates: undefined as ReadonlyArray<Candidate> | undefined,
  })
  const sessionID = () => params.id
  const location = () => ({ location: { directory: sdk().directory } })

  const refresh = async () => {
    if (!sessionID() || state.loading) return
    setState("loading", true)
    try {
      const [snapshot, evolution, candidates] = await Promise.all([
        serverSDK().operationsApi.runtimeInsight.snapshot({ ...location(), limit: "100" }),
        serverSDK().operationsApi.agentCapabilities.evolutionAuditEvents({ ...location(), limit: 100 }),
        serverSDK().operationsApi.agentCapabilities.evolutionCandidates({ ...location(), limit: 50 }),
      ])
      setState({ data: snapshot, evolution: evolution.data.items, candidates: candidates.data.items, refreshError: "" })
    } catch (error) {
      setState(
        "refreshError",
        copy().refreshFailed(
          runtimeReasonText(error instanceof Error ? error.message : String(error), language.locale()),
        ),
      )
    } finally {
      setState("loading", false)
    }
  }
  const verifyAudit = async () => {
    if (state.verifying) return
    setState("verifying", true)
    try {
      const result = await serverSDK().operationsApi.runtimeInsight.auditVerify(location())
      setState(
        "verifyMessage",
        result.valid ? copy().auditVerified(result.count) : copy().auditFailed(result.issue ?? ""),
      )
    } finally {
      setState("verifying", false)
    }
  }
  const transitionCandidate = async (candidate: Candidate, action: "approve" | "reject") => {
    if (state.actingCandidate) return
    const label = action === "approve" ? copy().approve : copy().reject
    const confirmation = action === "approve" ? copy().approveConfirm : copy().rejectConfirm
    if (!window.confirm(confirmation(candidate.title, candidate.rationale.slice(0, 200)))) return
    setState({ actingCandidate: candidate.candidate_id, actionError: "" })
    try {
      await serverSDK().operationsApi.agentCapabilities.evolutionTransition({
        ...location(),
        candidateID: candidate.candidate_id,
        action,
        expectedRevision: candidate.state.revision,
        reason: copy().transitionReason(label),
      })
      await refresh()
    } catch (error) {
      setState(
        "actionError",
        copy().transitionFailed(
          label,
          runtimeReasonText(error instanceof Error ? error.message : String(error), language.locale()),
        ),
      )
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

  const runs = createMemo(() =>
    (state.data?.durableRuns ?? []).filter((run) => run.sessionID === sessionID()).slice(0, 3),
  )
  const latestRun = createMemo(() => runs()[0])
  const actions = createMemo(() =>
    (state.data?.durableActions ?? []).filter((action) => action.sessionID === sessionID()).slice(0, 8),
  )
  const routing = createMemo(() =>
    (state.data?.routing ?? []).filter((decision) => decision.sessionID === sessionID()).slice(0, 2),
  )
  const verifications = createMemo(() =>
    (state.data?.verifications ?? []).filter((verification) => verification.sessionID === sessionID()).slice(0, 2),
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
    () => (state.data?.audit ?? []).filter((entry) => entry.metadata?.sessionID === sessionID()).length,
  )
  const pendingCandidates = createMemo(() =>
    (state.candidates ?? []).filter(
      (candidate) => candidate.state.status === "proposed" || candidate.state.status === "evaluated",
    ),
  )
  const evolutionEvents = createMemo(() => (state.evolution ?? []).slice(0, 3))
  const hasContent = createMemo(
    () =>
      runs().length > 0 ||
      actions().length > 0 ||
      routing().length > 0 ||
      verifications().length > 0 ||
      memoryRecalls().length > 0 ||
      auditTotal() > 0 ||
      pendingCandidates().length > 0 ||
      evolutionEvents().length > 0,
  )

  return (
    <section
      data-component="session-process-panel"
      aria-live="polite"
      style="padding:12px 14px 14px;display:grid;gap:12px"
    >
      <button
        type="button"
        onClick={() => setState("expanded", !state.expanded)}
        style="display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;text-align:left;padding:0;min-height:44px;width:100%"
      >
        <span style="font-size:13px;font-weight:600">{copy().processTitle}</span>
        {badge(copy().auto, "automatic")}
        <span style="flex:1" />
        <Show when={latestRun()}>
          {(run) => {
            const label = runStatus(run().status, language.locale())
            return (
              <span style="font-size:12px;color:var(--v2-text-text-muted);display:flex;align-items:center;gap:6px">
                <i style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${label.color}`} />
                {label.text}
              </span>
            )
          }}
        </Show>
        <span style="font-size:12px;color:var(--v2-text-text-muted)">
          {state.expanded ? copy().collapse : copy().expand}
        </span>
      </button>

      <Show when={state.expanded}>
        <Show when={state.refreshError}>
          <div role="alert" style={`${box()};font-size:12px;color:#ef4444`}>
            {state.refreshError} · {copy().refreshFailedHint}
          </div>
        </Show>
        <Show when={!hasContent()}>
          <p style="margin:0;color:var(--v2-text-text-muted);font-size:12px;line-height:1.6">{copy().empty}</p>
        </Show>

        {/* 自主学习与进化（可操作） */}
        <Show when={pendingCandidates().length > 0 || evolutionEvents().length > 0}>
          <div>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              <span style="font-size:12px;font-weight:600">{copy().evolutionTitle}</span>
              {badge(copy().auto, "automatic")}
              <Show when={pendingCandidates().length > 0}>{badge(copy().human, "human")}</Show>
            </div>
            <Show when={pendingCandidates().length === 0}>
              <p style="margin:4px 0 0;font-size:12px;color:var(--v2-text-text-muted)">{copy().evolutionAutoFlow}</p>
            </Show>

            {/* 五阶段进度条 */}
            <div style="display:flex;align-items:center;gap:2px;margin:8px 0 4px">
              <For each={copy().evolutionStages}>
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
                      <Show when={index() < copy().evolutionStages.length - 1}>
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
                        <span style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600">
                          {candidate.state.status === "proposed" ? copy().testing : copy().awaitingApproval}
                        </span>
                      }
                    >
                      <span style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(34,197,94,0.14);color:#22c55e;font-weight:600">
                        {copy().testedAwaitingApproval}
                      </span>
                    </Show>
                  </div>
                  <div style="font-size:12px;color:var(--v2-text-text-muted);margin:2px 0 6px">
                    {copy().rationale}：{candidate.rationale.slice(0, 90)}
                    {candidate.evidence_refs.length > 0 ? copy().evidence(candidate.evidence_refs.length) : ""}
                  </div>
                  <div style="font-size:11px;margin:0 0 6px">
                    <Show
                      when={candidate.evaluation?.gate_passed}
                      fallback={<span style="color:#ef4444">{copy().testFailed}</span>}
                    >
                      <span style="color:#22c55e">{copy().testPassed}</span>
                    </Show>
                  </div>
                  <div style="display:flex;gap:8px">
                    <button
                      type="button"
                      disabled={state.actingCandidate === candidate.candidate_id}
                      onClick={() => void transitionCandidate(candidate, "approve")}
                      style="font-size:12px;padding:4px 12px;min-height:44px;border-radius:8px;border:none;cursor:pointer;background:rgba(34,197,94,0.15);color:#22c55e;font-weight:600"
                    >
                      {copy().approve}
                    </button>
                    <button
                      type="button"
                      disabled={state.actingCandidate === candidate.candidate_id}
                      onClick={() => void transitionCandidate(candidate, "reject")}
                      style="font-size:12px;padding:4px 12px;min-height:44px;border-radius:8px;border:none;cursor:pointer;background:rgba(239,68,68,0.12);color:#ef4444;font-weight:600"
                    >
                      {copy().reject}
                    </button>
                  </div>
                </div>
              )}
            </For>
            <Show when={state.actionError}>
              <p role="alert" style="margin:6px 0 0;font-size:12px;color:#ef4444">
                {state.actionError}
              </p>
            </Show>
            <Show when={evolutionEvents().length > 0 && pendingCandidates().length === 0}>
              <div style="display:grid;gap:2px;margin-top:6px;font-size:12px;color:var(--v2-text-text-muted)">
                <For each={evolutionEvents()}>
                  {(event) => (
                    <div style="display:flex;gap:8px;align-items:center">
                      <span
                        style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${event.action === "candidate_approved" || event.action === "candidate_promoted" ? "#22c55e" : event.action === "candidate_rejected" || event.action === "candidate_rolled_back" ? "#ef4444" : "#818cf8"}`}
                      />
                      <span>{copy().evolutionEvent(event.action)}</span>
                      <span style="font-family:monospace">{event.subject_id ? event.subject_id.slice(0, 8) : ""}</span>
                      {event.action === "candidate_approved" || event.action === "candidate_rejected" ? (
                        <span style="font-size:11px;color:#f59e0b;font-weight:600">{copy().humanParenthesized}</span>
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
            {sectionTitle(copy().sessionStatus)}
            <For each={runs()}>
              {(run) => {
                const label = runStatus(run.status, language.locale())
                return (
                  <div style={`${box()};margin-bottom:4px;display:grid;gap:4px`}>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                      <i
                        style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${label.color}`}
                      />
                      <span>
                        {label.text} · {new Date(run.startedAt ?? run.createdAt).toLocaleTimeString()}
                      </span>
                      <Show when={run.status === "paused" || run.status === "failed"}>
                        <span style="color:var(--v2-text-text-muted)">{copy().continueHint}</span>
                      </Show>
                      <Show when={run.checkpoint}>
                        <span style="margin-left:auto;color:var(--v2-text-text-muted);font-size:11px">
                          {copy().checkpoint}
                        </span>
                      </Show>
                      <Show when={run.lease}>
                        <span
                          title={`${copy().workerOnline} · ${run.lease!.ownerID}`}
                          style={`${run.checkpoint ? "" : "margin-left:auto;"}color:#22c55e;font-size:11px`}
                        >
                          {copy().workerOnline}
                        </span>
                      </Show>
                    </div>
                    <div style="font-size:11px;color:var(--v2-text-text-muted);display:flex;gap:8px;flex-wrap:wrap">
                      <span>{copy().attempts(run.attemptsUsed, run.maxAttempts)}</span>
                      <span>
                        {copy().duration(
                          durationText(run.durationMsUsed, language.locale()),
                          durationText(run.maxDurationMs, language.locale()),
                        )}
                      </span>
                      <span>{copy().modelCost(costText(run.costMicrosUsed), costText(run.maxCostMicros))}</span>
                      <Show when={run.activeAttempt}>
                        {(attempt) => (
                          <span style="color:#22c55e">
                            {copy().activeAttempt(
                              attempt().attempt,
                              formatRuntimeTime(attempt().startedAt, language.locale()),
                            )}
                          </span>
                        )}
                      </Show>
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>

        {/* 真实动作时间线：来自持久化 Action 事件，默认不展示命令、路径和秘密。 */}
        <Show when={actions().length > 0}>
          <div>
            {sectionTitle(copy().actionTimeline)}
            <div style="display:grid;gap:4px">
              <For each={actions()}>
                {(action) => {
                  const authority = authorityLabel(action.authority, language.locale())
                  return (
                    <div style={`${box()};display:grid;gap:3px`}>
                      <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                        <span style="font-size:12px;font-weight:600">{action.name}</span>
                        <span
                          style={`font-size:10px;padding:1px 7px;border-radius:9px;color:${authority.color};background:${authority.background};font-weight:600`}
                        >
                          {authority.text}
                        </span>
                        <span style="font-size:11px;color:var(--v2-text-text-muted)">
                          {riskTierText(action.riskTier, language.locale())}
                        </span>
                        <span style="margin-left:auto;font-size:12px">
                          {actionStatusText(action.status, language.locale())}
                        </span>
                      </div>
                      <div style="font-size:11px;color:var(--v2-text-text-muted);display:flex;gap:8px;flex-wrap:wrap">
                        <span>{runtimeReasonText(action.reasonSummary, language.locale())}</span>
                        <span>{copy().impactRange(action.resourceCount)}</span>
                        <Show when={action.observationStatus === "failed"}>
                          <span style="color:#ef4444">{copy().executionFailed}</span>
                        </Show>
                        <Show when={action.observationStatus === "succeeded"}>
                          <span style="color:#22c55e">{copy().executionSucceeded}</span>
                        </Show>
                        <span>{copy().attempts(action.attemptsUsed, action.maxAttempts)}</span>
                        <span>{copy().durationSingle(durationText(action.durationMsUsed, language.locale()))}</span>
                        <span>
                          {action.maxCostMicros > 0
                            ? copy().modelCost(costText(action.costMicrosUsed), costText(action.maxCostMicros))
                            : copy().localCost}
                        </span>
                      </div>
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* 模型选择 */}
        <Show when={routing().length > 0}>
          <div>
            {sectionTitle(copy().modelSelection)}
            <For each={routing()}>
              {(decision) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <b>{runtimeModelText(decision.providerID, decision.modelID, language.locale())}</b>{" "}
                  <span style="color:var(--v2-text-text-muted)">
                    {runtimeReasonText(decision.reason, language.locale())}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* 验证 */}
        <Show when={verifications().length > 0}>
          <div>
            {sectionTitle(copy().verification)}
            <For each={verifications()}>
              {(verification) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <span style={`font-weight:600;${verification.passed ? "color:#22c55e" : "color:#ef4444"}`}>
                    {verification.passed ? copy().passed : copy().failed}
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
            {sectionTitle(copy().memoryRecall)}
            <For each={memoryRecalls()}>
              {(recall) => (
                <div style={`${box()};margin-bottom:4px`}>
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    <span style="font-size:12px;font-weight:600">
                      {copy().fingerprint} {recall.queryFingerprint.slice(0, 12)}
                    </span>
                    <span style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(129,140,248,0.15);color:#818cf8;font-weight:600">
                      {recall.algorithm}
                    </span>
                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                      {formatRuntimeTime(recall.timestamp, language.locale())} · {recall.latencyMs}ms
                    </span>
                  </div>
                  <div style="display:grid;gap:2px;margin-top:4px">
                    <For each={recall.hits}>
                      {(hit) => (
                        <div style="display:flex;gap:8px;align-items:baseline;font-size:12px">
                          <span style="font-family:monospace;color:var(--v2-text-text-muted)">
                            {hit.memoryID.slice(0, 8)}
                          </span>
                          <span style="flex:1;color:var(--v2-text-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            {copy().governedRecord} · {hit.source}
                          </span>
                          <span style="font-family:monospace;color:#22c55e">{(hit.score * 100).toFixed(0)}%</span>
                          <span style="font-size:10px;padding:0 6px;border-radius:8px;background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600">
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
              <span style="font-size:12px">{copy().auditTitle}</span>
              <span style="font-size:11px;color:var(--v2-text-text-muted)">{copy().auditNotice}</span>
              <button
                type="button"
                style="margin-left:auto;font-size:11px;color:#818cf8;background:none;border:none;cursor:pointer;text-decoration:underline"
                disabled={state.verifying}
                onClick={() => void verifyAudit()}
              >
                {state.verifying ? copy().verifyingAudit : copy().verifyAudit}
              </button>
            </div>
            <Show when={state.verifyMessage}>
              <p
                style={`margin:4px 0;font-size:12px;${/校验通过|稽核鏈校驗通過|Audit chain verified/.test(state.verifyMessage) ? "color:#22c55e" : "color:#ef4444"}`}
              >
                {state.verifyMessage}
              </p>
            </Show>
            <div style="display:grid;gap:2px;margin-top:4px;font-family:monospace;font-size:12px;color:var(--v2-text-text-muted)">
              <For each={auditEntries()}>
                {(entry) => (
                  <div style="display:flex;gap:8px">
                    <span>#{entry.seq}</span>
                    <span>{auditActionText(entry.action, language.locale())}</span>
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
