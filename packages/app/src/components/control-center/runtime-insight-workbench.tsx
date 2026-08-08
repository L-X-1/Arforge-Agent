import { Show, createEffect, createMemo, on, For } from "solid-js"
import { createStore } from "solid-js/store"
import type { OperationsApi } from "@/utils/server"

type Snapshot = Awaited<ReturnType<OperationsApi["runtimeInsight"]["snapshot"]>>

const AUTO = "自动"
const HUMAN = "人工"

function badge(kind: string, tone: "green" | "blue" | "gray" = "green") {
  const background =
    tone === "green" ? "rgba(34,197,94,0.14)" : tone === "blue" ? "rgba(99,102,241,0.14)" : "rgba(139,139,139,0.14)"
  const color = tone === "green" ? "#22c55e" : tone === "blue" ? "#818cf8" : "#8b8b8b"
  return (
    <span
      style={`display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:${background};color:${color};font-weight:600;margin-left:8px`}
    >
      {kind}
    </span>
  )
}

function barWidth(tokens: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.max(2, Math.round((tokens / total) * 100))}%`
}

function card(style: string) {
  return (
    "padding:12px 14px;border-radius:10px;background:var(--arforge-material-main);" +
    "box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);" +
    style
  )
}

function title(text: string) {
  return (
    <h4
      style="margin:0 0 2px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px"
    >
      {text}
    </h4>
  )
}

function hint(text: string) {
  return (
    <p style="margin:0 0 10px;font-size:12px;color:var(--v2-text-text-muted);line-height:1.5">
      {text}
    </p>
  )
}

export function RuntimeInsightWorkbench(props: {
  api: () => OperationsApi
  location: () => unknown
  ready: () => boolean
}) {
  const [state, setState] = createStore({
    loading: false,
    verifying: false,
    error: "",
    data: undefined as Snapshot | undefined,
    verifyResult: undefined as Awaited<ReturnType<OperationsApi["runtimeInsight"]["auditVerify"]>> | undefined,
  })
  const refresh = async () => {
    if (!props.ready() || state.loading) return
    setState("loading", true)
    try {
      const data = await props.api().runtimeInsight.snapshot({ limit: "100" })
      setState({ data, error: "" })
    } catch (error) {
      setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      setState("loading", false)
    }
  }
  const verify = async () => {
    if (state.verifying) return
    setState("verifying", true)
    try {
      setState("verifyResult", await props.api().runtimeInsight.auditVerify())
    } finally {
      setState("verifying", false)
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
  const latestContext = createMemo(() => state.data?.contextLayers[0])
  const totalLayers = createMemo(
    () => latestContext()?.layers.reduce((sum, layer) => sum + layer.tokens, 0) ?? 0,
  )

  return (
    <section class="arforge-control-center-body" style="display:grid;gap:14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="arforge-btn" disabled={state.loading} onClick={() => void refresh()}>
          {state.loading ? "刷新中…" : "刷新"}
        </button>
        <button class="arforge-btn" disabled={state.verifying} onClick={() => void verify()}>
          {state.verifying ? "校验中…" : "校验审计链"}
        </button>
        <span style="font-size:12px;color:var(--v2-text-text-muted)">
          以下数据全部由系统自动记录，无需手动维护。
        </span>
      </div>
      <Show when={state.error}>
        <p style="color:var(--color-danger,#ef4444);font-size:12px">{state.error}</p>
      </Show>
      <Show when={state.verifyResult}>
        {(result) => (
          <p
            style={`font-size:12px;padding:8px 12px;border-radius:8px;${result().valid ? "background:rgba(34,197,94,0.10);color:#22c55e" : "background:rgba(239,68,68,0.10);color:#ef4444"}`}
          >
            {result().valid
              ? `审计链校验通过：${result().count} 条记录均未被篡改。`
              : `审计链校验失败：${result().issue ?? "记录被篡改"}`}
          </p>
        )}
      </Show>

      <Show when={!state.data && !state.error} fallback={null}>
        <p style="font-size:12px;color:var(--v2-text-text-muted)">
          暂无记录。进行对话或工具调用后，这里会自动展示运行过程。
        </p>
      </Show>

      {/* 上下文分层 */}
      <Show when={latestContext()}>
        {(context) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title("模型上下文组成")}
              {badge(AUTO)}
            </div>
            {hint("每次调用自动把身份、项目事实、记忆等按优先级分层放进上下文；这里展示各层占比。")}
            <p style="margin:0 0 8px;font-size:12px;color:var(--v2-text-text-muted)">
              {context().model} · 共 {context().totalTokens} tokens ·{" "}
              {new Date(context().timestamp).toLocaleTimeString()}
            </p>
            <For each={context().layers}>
              {(layer) => (
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">
                  <span style="width:26px;font-weight:600">{layer.layer}</span>
                  <span style="width:130px;color:var(--v2-text-text-muted)">{layer.source}</span>
                  <div
                    style="flex:1;height:10px;border-radius:5px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);overflow:hidden"
                  >
                    <div
                      style={`height:100%;width:${barWidth(layer.tokens, totalLayers())};background:${layer.kept ? "#6366f1" : "#ef4444"}`}
                    />
                  </div>
                  <span style="width:70px;text-align:right">{layer.tokens} tok</span>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 模型路由 */}
      <Show when={state.data?.routing.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title("模型选择记录")}
              {badge(AUTO)}
            </div>
            {hint("每次调用自动记录选了哪个模型、价格和理由；方便你核对花费与选择逻辑。")}
            <For each={value().routing.slice(0, 8)}>
              {(decision) => (
                <div
                  style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px"
                >
                  <div>
                    <b>
                      {decision.providerID}/{decision.modelID}
                    </b>{" "}
                    <span style="color:var(--v2-text-text-muted)">
                      ${decision.inputCost}/百万输入 · ${decision.outputCost}/百万输出
                    </span>
                  </div>
                  <div style="color:var(--v2-text-text-muted)">
                    {decision.reason} · 任务：{decision.task.slice(0, 60)}
                  </div>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 验证报告 */}
      <Show when={state.data?.verifications.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title("交付前验证")}
              {badge(AUTO)}
            </div>
            {hint("模型交付结果前自动运行验证命令；红色表示有验证项未通过。")}
            <For each={value().verifications.slice(0, 8)}>
              {(verification) => (
                <div
                  style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px"
                >
                  <div>
                    <span
                      style={`display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${verification.passed ? "#22c55e" : "#ef4444"}`}
                    />
                    <b>{verification.passed ? "通过" : "未通过"}</b> · {verification.claim.slice(0, 50)}
                  </div>
                  <div style="color:var(--v2-text-text-muted)">
                    {verification.commands.map((command) => `$ ${command}`).join("  ·  ")}
                  </div>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 审计 */}
      <Show when={state.data?.audit.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title("操作审计")}
              {badge(AUTO)}
              {badge(HUMAN, "blue")}
            </div>
            {hint("关键操作自动留痕并链接成防篡改链条；你可以在需要时点击上方按钮校验。")}
            <p style="margin:0 0 8px;font-size:12px">
              链状态：
              <span
                style={`font-weight:600;${value().auditVerify.valid ? "color:#22c55e" : "color:#ef4444"}`}
              >
                {value().auditVerify.valid ? `完整（${value().auditVerify.count} 条）` : "异常"}
              </span>
            </p>
            <div
              style="font-size:12px;font-family:monospace;max-height:260px;overflow:auto;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);border-radius:8px;padding:8px;color:var(--v2-text-text-muted)"
            >
              <For each={value().audit.slice(0, 40)}>
                {(entry) => (
                  <div style="display:flex;gap:8px;padding:2px 0">
                    <span style="min-width:44px">#{entry.seq}</span>
                    <span>{entry.action === "tool.execute.start" ? "开始" : entry.action === "tool.execute.end" ? "结束" : entry.action}</span>
                    <span>{entry.resource}</span>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </Show>

      {/* 运行状态 */}
      <Show when={state.data?.runs.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title("会话运行状态")}
              {badge(AUTO)}
            </div>
            {hint("会话自动记录开始/结束与结果；若进程中断，状态会标记为 interrupted，可重新发起继续。")}
            <For each={value().runs.slice(0, 8)}>
              {(run) => (
                <div
                  style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px;display:flex;gap:8px;align-items:center"
                >
                  <span
                    style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${run.status === "running" ? "#22c55e" : run.status === "completed" ? "#818cf8" : run.status === "failed" || run.status === "interrupted" ? "#ef4444" : "#8b8b8b"}`}
                  />
                  <span>
                    {run.status === "running" ? "进行中" : run.status === "completed" ? "已完成" : run.status === "failed" ? "失败" : run.status === "interrupted" ? "中断" : run.status} ·{" "}
                    {run.sessionID.slice(0, 12)} · {new Date(run.startedAt).toLocaleTimeString()}
                  </span>
                  <Show when={run.error}>
                    <span style="color:var(--v2-text-text-muted)">· {run.error!.slice(0, 50)}</span>
                  </Show>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>
    </section>
  )
}
