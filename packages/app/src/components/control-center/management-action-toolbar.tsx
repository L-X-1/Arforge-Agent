import { For, Show, createUniqueId, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { Spinner } from "@arforge-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import "./management-action-toolbar.css"

export type ManagementAction = {
  id: string
  label: JSX.Element
  run: () => unknown
  disabled?: boolean
  busy?: boolean
  danger?: boolean
}

/** Existing handlers remain the only action owners; the menu only changes their presentation. */
export function ManagementActionToolbar(props: {
  primary?: JSX.Element
  actions: readonly ManagementAction[]
  disabledReason?: string
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false })
  const reasonID = createUniqueId()
  const label = () => (language.locale().startsWith("zh") ? "更多操作" : "More actions")
  const busy = () => props.actions.some((action) => action.busy)
  const actions = () => [
    ...props.actions.filter((action) => !action.danger),
    ...props.actions.filter((action) => action.danger),
  ]
  const run = (action: ManagementAction) => {
    if (action.disabled || action.busy) return
    void action.run()
  }
  return (
    <div class="management-action-toolbar">
      <div class="management-action-toolbar-actions">
        {props.primary}
        <Show when={props.actions.length > 0}>
          <MenuV2 modal={false} gutter={4} open={state.open} onOpenChange={(open) => setState("open", open)}>
            <MenuV2.Trigger
              as={ButtonV2}
              size="small"
              variant="neutral"
              aria-label={label()}
              aria-busy={busy() || undefined}
              aria-describedby={props.disabledReason ? reasonID : undefined}
            >
              <Show when={busy()}>
                <Spinner class="size-4" />
              </Show>
              {label()}
            </MenuV2.Trigger>
            <MenuV2.Portal>
              <MenuV2.Content data-management-action-menu="">
                <For each={actions()}>
                  {(action, index) => (
                    <>
                      <Show when={action.danger && (index() === 0 || !actions()[index() - 1]?.danger)}>
                        <MenuV2.Separator />
                      </Show>
                      <MenuV2.Item
                        disabled={action.disabled || action.busy}
                        aria-busy={action.busy || undefined}
                        data-danger={action.danger ? "" : undefined}
                        onSelect={() => run(action)}
                      >
                        <Show when={action.busy}>
                          <Spinner class="size-4" />
                        </Show>
                        {action.label}
                      </MenuV2.Item>
                    </>
                  )}
                </For>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        </Show>
      </div>
      <Show when={props.disabledReason}>
        <p id={reasonID} class="management-action-toolbar-reason">
          {props.disabledReason}
        </p>
      </Show>
    </div>
  )
}
