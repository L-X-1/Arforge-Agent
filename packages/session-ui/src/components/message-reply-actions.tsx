import { For, Show } from "solid-js"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { Icon } from "@arforge-ai/ui/v2/icon"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@arforge-ai/ui/v2/tooltip-v2"
import "./message-reply-actions.css"

export type MessageReplyAction = {
  label: string
  run: (origin?: HTMLElement) => void
  disabledReason?: string
}

export type MessageReplyActionSet = {
  retry: MessageReplyAction
  branch: MessageReplyAction
  moreLabel: string
  more: MessageReplyAction[]
  busy?: boolean
  notice?: string
  error?: string
}

export function MessageReplyActionFooter(props: { actions: MessageReplyActionSet }) {
  return (
    <>
      <div data-slot="text-part-copy-wrapper" class="flex items-center gap-1">
        <MessageReplyActions actions={props.actions} />
      </div>
      <Show when={props.actions.error || props.actions.notice || props.actions.retry.disabledReason}>
        <div
          data-slot="message-reply-action-status"
          class="text-text-weak"
          role={props.actions.error ? "alert" : "status"}
        >
          {props.actions.error || props.actions.notice || props.actions.retry.disabledReason}
        </div>
      </Show>
    </>
  )
}

/** The session owner supplies every action; this component never fabricates a handler. */
export function MessageReplyActions(props: { actions: MessageReplyActionSet }) {
  let trigger: HTMLButtonElement | undefined
  let afterClose: (() => void) | undefined
  return (
    <>
      <For
        each={
          [
            { key: "retry", icon: "reset" },
            { key: "branch", icon: "branch" },
          ] as const
        }
      >
        {(entry) => {
          const action = () => props.actions[entry.key]
          return (
            <TooltipV2 value={action().disabledReason || action().label} placement="top" openDelay={300}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                icon={<Icon name={entry.icon} />}
                data-message-action={entry.key}
                disabled={props.actions.busy || !!action().disabledReason}
                aria-label={action().label}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!props.actions.busy && !action().disabledReason) action().run(event.currentTarget)
                }}
              />
            </TooltipV2>
          )
        }}
      </For>
      <Show when={props.actions.more.length}>
        <MenuV2 placement="top-start" modal={false}>
          <TooltipV2 value={props.actions.moreLabel} placement="top" openDelay={300}>
            <MenuV2.Trigger
              as={IconButtonV2}
              ref={trigger}
              type="button"
              variant="ghost-muted"
              icon={<Icon name="outline-dots" />}
              data-message-action="more"
              aria-label={props.actions.moreLabel}
            />
          </TooltipV2>
          <MenuV2.Portal>
            <MenuV2.Content
              data-message-actions-menu
              onCloseAutoFocus={(event) => {
                const action = afterClose
                afterClose = undefined
                if (!action) return
                event.preventDefault()
                requestAnimationFrame(() => requestAnimationFrame(action))
              }}
            >
              <For each={props.actions.more}>
                {(action) => (
                  <MenuV2.Item
                    disabled={props.actions.busy || !!action.disabledReason}
                    onSelect={() => {
                      if (props.actions.busy || action.disabledReason) return
                      afterClose = () => action.run(trigger)
                    }}
                  >
                    <span class="flex min-w-0 flex-col gap-1">
                      <span>{action.label}</span>
                      <Show when={action.disabledReason}>
                        <span data-slot="message-action-disabled-reason" class="text-text-weak">
                          {action.disabledReason}
                        </span>
                      </Show>
                    </span>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </Show>
    </>
  )
}
