import { Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { useControlApproval, type ControlApprovalReceipt } from "@/context/control-approval"
import { useLanguage } from "@/context/language"
import { ManagementStatus } from "../settings-v2/management-status"
import { receiptOperationPhase, type ReceiptOperationStatus } from "./receipt-operation"

/** Opening/refreshing this view only reads the captured operation's durable status. */
export function ReceiptOperationView(props: { receipt: ControlApprovalReceipt }) {
  const approval = useControlApproval()
  const language = useLanguage()
  const [state, setState] = createStore({ loading: false, error: undefined as unknown, result: undefined as ReceiptOperationStatus | undefined })
  let live = true
  onCleanup(() => { live = false })
  const copy = () => language.locale().startsWith("zh")
    ? { view: "查看执行回执", refresh: "重新读取执行回执", unavailable: "当前来源没有可读取的执行回执入口。", source: "以下状态来自原操作的服务端回执，审批决定与执行结果分别确认。", recovery: "恢复指令" }
    : { view: "View execution receipt", refresh: "Read execution receipt again", unavailable: "No execution-receipt reader is available for this source.", source: "This status comes from the original operation's server receipt. The approval decision and execution outcome are separate.", recovery: "Recovery directive" }
  const read = async () => {
    if (state.loading || !approval.operationAvailable(props.receipt)) return
    setState({ loading: true, error: undefined })
    try {
      const result = await approval.operationStatus(props.receipt)
      if (live) setState("result", result)
    } catch (error) {
      if (live) setState("error", error)
    } finally {
      if (live) setState("loading", false)
    }
  }
  return <section class="control-approval-operation" data-testid="control-approval-operation" aria-busy={state.loading}>
    <Show when={approval.operationAvailable(props.receipt)} fallback={<p class="control-approval-receipt-stage">{copy().unavailable}</p>}>
      <ButtonV2 type="button" size="small" variant="neutral" disabled={state.loading} onClick={() => void read()}>
        {state.result ? copy().refresh : copy().view}
      </ButtonV2>
    </Show>
    <ManagementStatus loading={state.loading} initialLoading={!state.result} error={state.error}
      onRetry={approval.operationAvailable(props.receipt) ? () => void read() : undefined} />
    <Show when={state.result}>{result => <div role="status" data-execution-phase={result().phase}>
      <p class="control-approval-receipt-stage">{copy().source}</p>
      <strong>{receiptOperationPhase(result().phase, language.locale())}</strong>
      <dl>
        <dt>Operation</dt><dd>{result().operation}</dd>
        <dt>Request</dt><dd><code>{result().requestID}</code></dd>
        <dt>Run</dt><dd><code>{result().runID}</code></dd>
        <dt>Action</dt><dd><code>{result().actionID}</code></dd>
        <dt>{copy().recovery}</dt><dd>{result().recovery}</dd>
      </dl>
    </div>}</Show>
  </section>
}
