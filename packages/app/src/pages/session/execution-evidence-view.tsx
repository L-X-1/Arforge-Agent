import { ErrorBoundary, Index, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@arforge-ai/ui/context/file"
import { resolveFileDiff, type DiffSource } from "@arforge-ai/session-ui/session-diff"
import { executionContentPreview } from "./execution-content-preview"
import type { ExecutionEvidence } from "./execution-evidence"

export type ExecutionEvidenceView = "tools" | "files" | "tests"

function RecordedDiff(props: { diff: DiffSource }) {
  const fileComponent = useFileComponent()
  const diff = createMemo(() => resolveFileDiff(props.diff))
  return (
    <div class="execution-evidence__diff" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={diff()} />
    </div>
  )
}

export function ExecutionEvidenceViews(props: {
  evidence: ExecutionEvidence
  view: ExecutionEvidenceView
  onView: (view: ExecutionEvidenceView) => void
  onTool: (id: string) => void
  chinese: boolean
  notice?: JSX.Element
  children: JSX.Element
}) {
  const t = (zh: string, en: string) => props.chinese ? zh : en
  const tabs = ["tools", "files", "tests"] as const
  const labels = () => ({
    tools: t("工具记录", "Tool records"),
    files: t("文件变更", "File changes"),
    tests: t("测试结果", "Test results"),
  })
  const counts = () => ({ tools: 0, files: props.evidence.files.length, tests: props.evidence.verifications.length })
  const status = (result: ExecutionEvidence["verifications"][number]) => ({
    pending: t("等待执行", "Pending"),
    approval: t("等待审批", "Waiting for approval"),
    active: t("工具调用处理中", "Tool call active"),
    running: t("正在验证", "Verification in progress"),
    passed: t("验证通过", "Verification passed"),
    failed: t("验证失败", "Verification failed"),
    "tool-error": t("工具执行失败", "Tool failed"),
    interrupted: t("工具执行已中断", "Tool interrupted"),
    timeout: t("命令超时", "Command timed out"),
    incomplete: t("验证结果不完整", "Verification result incomplete"),
    unexecuted: t("未记录执行", "No execution recorded"),
    "outside-workspace": t("工作目录超出工作区", "Working directory outside workspace"),
    "workdir-unverified": t("工作目录未核实", "Working directory unverified"),
  })[result.status]
  const openTool = (id: string) => {
    props.onTool(id)
    props.onView("tools")
  }
  return (
    <>
      <div class="execution-evidence__filters" role="group" aria-label={t("执行证据", "Execution evidence")}>
        <Index each={tabs}>
          {(view) => (
            <button type="button" aria-pressed={props.view === view()} data-execution-evidence={view()}
              onClick={() => props.onView(view())}>
              {labels()[view()]}<Show when={counts()[view()]}>{(count) => <> {count()}</>}</Show>
            </button>
          )}
        </Index>
      </div>
      {props.notice}
      <Show when={props.view === "tools"}>{props.children}</Show>
      <Show when={props.view === "files"}>
        <div class="execution-evidence__list" aria-label={labels().files}>
          <Show when={props.evidence.missingFileEvidence}>
            <p>{t("部分文件记录缺少可核对的工具证据。", "Some file records lack linked tool evidence.")}</p>
          </Show>
          <Show when={!props.evidence.files.length}>
            <p>{t("没有已记录的文件变更。", "No file changes were recorded.")}</p>
          </Show>
          <Index each={props.evidence.files}>{(change) => (
            <Show when={change().toolID + "\u0000" + change().file} keyed>
              {(_key) => <details class="execution-evidence__card" data-execution-file={change().file} data-scope={change().scope}>
                <summary>
                  <code>{change().file}</code>
                  <Show when={change().scope === "outside"}>
                    <span class="execution-evidence__subtitle" data-state="warning">{t("超出指定范围", "Outside requested scope")}</span>
                  </Show>
                  <Show when={change().scope === "incomplete"}>
                    <span class="execution-evidence__subtitle">{t("文件范围证据不完整", "File scope evidence incomplete")}</span>
                  </Show>
                </summary>
                <Show when={change().diff} fallback={<p>{t("工具记录未保存此文件的差异。", "The tool record has no stored diff for this file.")}</p>}>
                  {(diff) => {
                    const [opened, setOpened] = createSignal(false)
                    return (
                      <details class="execution-evidence__diff-disclosure" onToggle={(event) => setOpened(event.currentTarget.open)}>
                        <summary>{t("查看差异", "View diff")}</summary>
                        <Show when={opened()}>
                          <ErrorBoundary fallback={<p>{t("无法读取已记录的差异。", "The recorded diff could not be read.")}</p>}>
                            <RecordedDiff diff={diff()} />
                          </ErrorBoundary>
                        </Show>
                      </details>
                    )
                  }}
                </Show>
                <Show when={change().toolID}>
                  {(id) => <button type="button" onClick={() => openTool(id())}>{t("查看工具记录", "View tool record")}</button>}
                </Show>
              </details>}
            </Show>
          )}</Index>
        </div>
      </Show>
      <Show when={props.view === "tests"}>
        <div class="execution-evidence__list" aria-label={labels().tests}>
          <Show when={!props.evidence.verifications.length}>
            <p>{t("没有已记录的验证结果。", "No verification results were recorded.")}</p>
          </Show>
          <Index each={props.evidence.verifications}>{(result) => {
            const output = createMemo(() => result().output ? executionContentPreview(result().output!, false).text : undefined)
            return (
              <Show when={result().toolID ?? result().command} keyed>
                {(_key) => <details class="execution-evidence__card" data-verification-status={result().status}
                  data-verification-command={result().command}>
                  <summary>
                    {status(result())}
                    <Show when={result().exit !== undefined}> · {t("退出码", "Exit code")} {result().exit}</Show>
                    <code class="execution-evidence__subtitle">{result().command}</code>
                  </summary>
                  <Show when={output()}>{(text) => <pre tabIndex={0}>{text()}</pre>}</Show>
                  <Show when={result().toolID}>
                    {(id) => <button type="button" onClick={() => openTool(id())}>{t("查看工具记录", "View tool record")}</button>}
                  </Show>
                </details>}
              </Show>
            )
          }}</Index>
        </div>
      </Show>
    </>
  )
}
