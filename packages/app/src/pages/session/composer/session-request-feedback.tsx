import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import "./session-request-feedback.css"

export function requestFeedbackCopy(locale: string) {
  if (locale === "zht")
    return {
      decision: "正在記錄決定…",
      answer: "正在提交回答…",
      dismiss: "正在略過問題…",
      retry: "重試原操作",
      session: "會話",
      request: "請求",
    }
  if (locale.startsWith("zh"))
    return {
      decision: "正在记录决定…",
      answer: "正在提交回答…",
      dismiss: "正在跳过问题…",
      retry: "重试原操作",
      session: "会话",
      request: "请求",
    }
  return {
    decision: "Recording decision…",
    answer: "Submitting answer…",
    dismiss: "Dismissing question…",
    retry: "Retry previous action",
    session: "Session",
    request: "Request",
  }
}

export function SessionRequestOrigin(props: {
  origin: { server: string; directory: string; sessionID: string; requestID: string }
}) {
  const language = useLanguage()
  return (
    <div data-slot="session-request-origin">
      <div>{props.origin.server}</div>
      <div>{props.origin.directory}</div>
      <div>
        {requestFeedbackCopy(language.locale()).session}: <code>{props.origin.sessionID}</code>
      </div>
      <div>
        {requestFeedbackCopy(language.locale()).request}: <code>{props.origin.requestID}</code>
      </div>
    </div>
  )
}

export function SessionRequestFeedback(props: { busy?: string; error?: string; onRetry?: () => void }) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.busy}>
        <p data-slot="session-request-busy" role="status">
          {props.busy}
        </p>
      </Show>
      <Show when={props.error}>
        <div data-slot="session-request-error" role="alert">
          <p>{props.error}</p>
          <Show when={props.onRetry}>
            <button type="button" onClick={props.onRetry} disabled={!!props.busy}>
              {requestFeedbackCopy(language.locale()).retry}
            </button>
          </Show>
        </div>
      </Show>
    </>
  )
}
