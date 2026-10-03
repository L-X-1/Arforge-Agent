import { Show } from "solid-js"
import { Button } from "@arforge-ai/ui/button"
import { useLanguage } from "@/context/language"
import { managementCopy, managementErrorText, managementState } from "./management-state"
import "./management-review.css"

export function ManagementStatus(props: {
  loading?: boolean
  saving?: boolean
  error?: unknown
  notice?: string
  empty?: boolean
  emptyText?: string
  onRetry?: () => void
}) {
  const language = useLanguage()
  const copy = () => managementCopy(language.locale())
  const state = () => managementState(props)
  const failed = () => state() === "error" || state() === "permission" || state() === "conflict"
  const title = () => state() === "permission" ? copy().permission
    : state() === "conflict" ? copy().conflict : copy().error
  return (
    <Show when={state() !== "ready"}>
      <div
        class="arforge-management-status"
        data-state={state()}
        role={failed() ? "alert" : "status"}
        aria-live={failed() ? "assertive" : "polite"}
        aria-atomic="true"
      >
        <Show when={failed()} fallback={
          <span>{state() === "saving" ? copy().saving : state() === "loading" ? copy().loading
            : state() === "notice" ? props.notice : props.emptyText || copy().empty}</span>
        }>
          <div class="arforge-management-status-copy">
            <strong>{title()}</strong>
            <Show when={state() === "permission"}><p>{copy().permissionHint}</p></Show>
            <Show when={state() === "conflict"}><p>{copy().conflictHint}</p></Show>
            <p class="arforge-management-error-detail">{managementErrorText(props.error, copy().error)}</p>
          </div>
          <Show when={props.onRetry}>
            <Button type="button" size="small" variant="secondary" disabled={props.loading || props.saving} onClick={() => props.onRetry?.()}>
              {copy().retry}
            </Button>
          </Show>
        </Show>
      </div>
    </Show>
  )
}
