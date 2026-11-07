import { Show, createMemo, createSignal } from "solid-js"
import { useI18n } from "@arforge-ai/ui/context/i18n"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"

/** Display limits never alter the complete output used by the original copy action. */
export function BoundedToolOutput(props: { text: string; slot?: string; pending?: boolean; code?: boolean }) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => props.text.split("\n"))
  const limit = 20
  const bounded = () => !props.pending && lines().length > limit
  const shown = () => bounded() && !expanded() ? limit : lines().length
  const displayed = createMemo(() => bounded() && !expanded() ? lines().slice(0, limit).join("\n") : props.text)
  const label = () => {
    const chinese = i18n.locale().startsWith("zh")
    const action = expanded() ? (chinese ? "收起" : "Collapse") : (chinese ? "展开全部" : "Expand all")
    return chinese ? action + "（当前 1–" + shown() + " 行，共 " + lines().length + " 行）"
      : action + " (showing lines 1–" + shown() + " of " + lines().length + ")"
  }
  return <>
    <pre data-slot={props.slot}><Show when={props.code} fallback={displayed()}><code>{displayed()}</code></Show></pre>
    <Show when={bounded()}>
      <ButtonV2 size="small" variant="ghost-muted" aria-expanded={expanded()}
        onClick={() => setExpanded(value => !value)}>{label()}</ButtonV2>
    </Show>
  </>
}
