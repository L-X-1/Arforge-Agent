import { Show } from "solid-js"
import { Button } from "@arforge-ai/ui/button"
import { Spinner } from "@arforge-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { managementCopy, managementErrorText, managementState, type ManagementFeedback } from "./management-state"
import "./management-review.css"

export function ManagementStatus(props: ManagementFeedback & {
  initialLoading?: boolean
  scope?: string
  lastRead?: string
  emptyText?: string
  onRetry?: () => void
  onClearSearch?: () => void
}) {
  const language = useLanguage()
  const copy = () => managementCopy(language.locale())
  const state = () => managementState({ ...props, refreshing: props.refreshing || (props.loading && props.initialLoading === false) })
  const failed = () => ["error", "permission", "conflict", "partial", "offline", "ack"].includes(state())
  const errorDetail = () => managementErrorText(props.error, copy().error)
  const errorSummary = () => errorDetail().split(/\r?\n/, 1)[0]?.slice(0, 160) || copy().error
  const title = () => state() === "permission" ? copy().permission
    : state() === "conflict" ? copy().conflict
    : state() === "partial" ? copy().partial
    : state() === "offline" ? copy().offline
    : state() === "ack" ? copy().ack : copy().error
  return (
    <Show when={state() !== "ready"}>
      <div
        class="arforge-management-status"
        data-state={state()}
        role={failed() ? "alert" : "status"}
        aria-live={failed() ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <Show when={state() === "loading" || state() === "refreshing" || state() === "saving"}>
          <span class="arforge-management-busy-icon" aria-hidden="true"><Spinner /></span>
        </Show>
        <Show when={props.loading && props.initialLoading}>
          <div class="arforge-management-skeleton" aria-hidden="true"><span /><span /><span /></div>
        </Show>
        <Show when={props.scope}><span class="arforge-management-status-scope">{props.scope}</span></Show>
        <Show when={props.lastRead}><time class="arforge-management-status-scope" dateTime={props.lastRead}>
          {copy().lastRead}: {new Date(props.lastRead!).toLocaleString(language.intl())}
        </time></Show>
        <Show when={failed()} fallback={
          <span>{state() === "saving" ? copy().saving : state() === "loading" ? copy().loading
            : state() === "refreshing" ? copy().refreshing : state() === "readonly" ? `${copy().readOnly} · ${props.readOnly}`
            : state() === "noresults" ? copy().noResults : state() === "notice" ? props.notice : props.emptyText || copy().empty}</span>
        }>
          <div class="arforge-management-status-copy">
            <strong>{title()}</strong>
            <Show when={state() === "permission"}><p>{copy().permissionHint}</p></Show>
            <Show when={state() === "conflict"}><p>{copy().conflictHint}</p></Show>
            <Show when={state() === "partial"}><p>{copy().partialHint}</p></Show>
            <Show when={state() === "offline"}><p>{copy().offlineHint}</p></Show>
            <Show when={state() === "ack"}><p>{copy().ackHint}</p></Show>
            <Show when={props.error}>
            <p>{errorSummary()}</p>
            <details class="arforge-management-error-disclosure">
              <summary>{copy().details}</summary>
              <pre class="arforge-management-error-detail">{errorDetail()}</pre>
            </details>
            </Show>
          </div>
          <Show when={props.onRetry}>
            <Button type="button" size="small" variant="secondary" disabled={props.loading || props.saving} onClick={() => props.onRetry?.()}>
              {copy().retryRead}
            </Button>
          </Show>
        </Show>
        <Show when={failed() && props.notice}>
          <p class="arforge-management-acknowledged-notice" role="status" aria-live="polite">{props.notice}</p>
        </Show>
        <Show when={state() === "empty" && props.onRetry}>
          <Button type="button" size="small" variant="primary" disabled={props.loading || props.saving} onClick={() => props.onRetry?.()}>{copy().refresh}</Button>
        </Show>
        <Show when={state() === "noresults" && props.onClearSearch}>
          <Button type="button" size="small" variant="secondary" onClick={() => props.onClearSearch?.()}>{copy().clearSearch}</Button>
        </Show>
      </div>
    </Show>
  )
}
