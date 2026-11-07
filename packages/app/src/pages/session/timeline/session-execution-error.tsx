import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Card } from "@arforge-ai/ui/card"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon } from "@arforge-ai/ui/v2/icon"
import type { ServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { executionErrorPresentation } from "./session-execution-error-model"
import { formatServerError } from "@/utils/server-errors"
import "./session-execution-error.css"

/** An execution failure is an observation, never an invented assistant message. */
export function SessionExecutionError(props: {
  scope: string
  sessionID?: string
  directory: string
  events: Pick<ServerSDK["event"], "listen">
  serverLabel?: string
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ message: "", type: "" })
  const copy = () =>
    language.locale().startsWith("zh")
      ? {
          title: "执行未完成",
          source: "来源",
          details: "错误详情",
          next: "请核对错误详情和当前连接、模型配置，再使用会话已有操作继续。",
        }
      : {
          title: "Execution did not complete",
          source: "Source",
          details: "Error details",
          next: "Review the details and current connection/model configuration before continuing with the session controls.",
        }
  createEffect(() => {
    const scope = props.scope
    const sessionID = props.sessionID
    const directory = props.directory
    const events = props.events
    let active = true
    setState({ message: "", type: "" })
    const unsubscribe = events.listen((event) => {
      if (!active || props.scope !== scope || props.events !== events || event.name !== directory) return
      const detail = event.details
      if (!detail.properties || !("sessionID" in detail.properties) || detail.properties.sessionID !== sessionID) return
      if (
        (detail.type === "session.status" && detail.properties.status.type === "busy") ||
        detail.current?.type === "session.execution.started" ||
        detail.current?.type === "session.next.step.started" ||
        (detail.current?.type === "agent.run.state-changed" && detail.current.data.to === "running")
      ) {
        setState({ message: "", type: "" })
        return
      }
      const error =
        detail.type === "session.error"
          ? detail.properties.error
          : detail.current?.type === "session.execution.failed"
            ? detail.current.data.error
            : undefined
      if (!error) return
      setState(
        executionErrorPresentation(
          error,
          language.t("common.requestFailed"),
          formatServerError(error, language.t, language.t("common.requestFailed")),
        ),
      )
    })
    onCleanup(() => {
      active = false
      unsubscribe()
    })
  })
  return (
    <Show when={state.message}>
      {(message) => (
        <Card variant="error" role="alert" data-session-execution-error class="session-execution-error">
          <header>
            <strong>{copy().title}</strong>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              icon={<Icon name="outline-xmark" />}
              aria-label={language.t("common.close")}
              onClick={() => setState({ message: "", type: "" })}
            />
          </header>
          <p data-slot="execution-error-summary">{message().split(/\r?\n/, 1)[0]}</p>
          <p data-slot="execution-error-origin">
            {copy().source}: {props.serverLabel}
            <br />
            {props.directory}
            <br />
            <code>{props.sessionID}</code>
          </p>
          <p data-slot="execution-error-next">{copy().next}</p>
          <details>
            <summary>{copy().details}</summary>
            <code data-slot="execution-error-type">{state.type}</code>
            <pre>{message()}</pre>
          </details>
        </Card>
      )}
    </Show>
  )
}
