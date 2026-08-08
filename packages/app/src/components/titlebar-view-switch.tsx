import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"

export function TitlebarViewSwitch(props: {
  homeActive: () => boolean
  onHome: () => void
  onSessions: () => void
  homeLabel: string
  sessionsLabel: string
}) {
  return (
    <div data-component="titlebar-view-switch" role="tablist" aria-label={props.sessionsLabel}>
      <span data-slot="view-switch-thumb" data-active={props.homeActive() ? "home" : "session"} aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={props.homeActive()}
        data-active={props.homeActive() ? "" : undefined}
        onClick={props.onHome}
        aria-label={props.homeLabel}
      >
        <IconV2 name="grid-plus" />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={!props.homeActive()}
        data-active={!props.homeActive() ? "" : undefined}
        onClick={props.onSessions}
        aria-label={props.sessionsLabel}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M2.5 4.5H13.5M2.5 8H13.5M2.5 11.5H13.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  )
}
