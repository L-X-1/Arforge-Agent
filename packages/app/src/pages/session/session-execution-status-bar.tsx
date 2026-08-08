import { Show } from "solid-js"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"

export function SessionExecutionStatusBar(props: {
  running: boolean
  stepCount: number
  label: string
  countLabel: string
  onOpen: () => void
}) {
  return (
    <div class="flex h-10 shrink-0 items-center px-4">
      <button
        type="button"
        data-component="execution-status-bar"
        class="group flex h-8 items-center gap-2 rounded-[10px] border border-v2-border-border-muted bg-v2-background-bg-layer-01/80 px-3 text-left transition-[background-color,border-color] duration-160 ease-out hover:border-v2-border-border-strong hover:bg-v2-background-bg-layer-01"
        onClick={props.onOpen}
        aria-label={props.label}
      >
        <span
          class="relative block size-2 shrink-0 rounded-full"
          data-running={props.running ? "" : undefined}
          aria-hidden="true"
        />
        <span class="text-[12px] font-[440] leading-none text-v2-text-text-muted">{props.label}</span>
        <Show when={props.stepCount > 0}>
          <span class="rounded-full bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[11px] font-[530] leading-none text-v2-text-text-muted">
            {props.countLabel}
          </span>
        </Show>
        <IconV2 name="chevron-right" size="small" class="shrink-0 text-v2-icon-icon-muted transition-transform duration-160 ease-out group-hover:translate-x-0.5" />
      </button>
    </div>
  )
}
