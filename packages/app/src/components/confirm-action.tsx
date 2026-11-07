import { useDialog } from "@arforge-ai/ui/context/dialog"
import { DialogV2, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@arforge-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { For, Show, createEffect, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"

type ConfirmOptions = {
  isCurrent?: () => boolean
  confirmLabel?: string
  title?: string
  danger?: boolean
  details?: { summary: string; items: readonly { label: string; value: string }[] }
}

export function confirmationSnapshot(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** The pending decision belongs to its original component and source scope. */
export function useConfirmAction() {
  const dialog = useDialog()
  const language = useLanguage()
  let disposed = false
  let pending: { cancel: () => void } | undefined
  const copy = () =>
    language.locale().startsWith("zh")
      ? { title: "确认操作", cancel: "取消", confirm: "确认", close: "关闭确认框" }
      : { title: "Confirm action", cancel: "Cancel", confirm: "Confirm", close: "Close confirmation" }

  onCleanup(() => {
    disposed = true
    pending?.cancel()
  })

  return (message: string, options: ConfirmOptions = {}): Promise<boolean> => {
    const current = () => {
      if (disposed) return false
      try {
        return options.isCurrent?.() !== false
      } catch {
        return false
      }
    }
    if (pending || !current()) return Promise.resolve(false)
    // Disclose captured public metadata, never a live projection from a new source.
    const details = options.details && {
      summary: options.details.summary,
      items: options.details.items.map((item) => ({ label: item.label, value: item.value })),
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      let handle: { close: () => void; discard: () => void } | undefined
      const finish = (accepted: boolean) => {
        if (settled) return
        settled = true
        pending = undefined
        resolve(accepted && current())
      }
      pending = {
        cancel: () => {
          finish(false)
          handle?.discard()
        },
      }
      handle = dialog.pushScoped(
        () => {
          onCleanup(() => finish(false))
          createEffect(() => {
            if (current()) return
            finish(false)
            queueMicrotask(() => handle?.discard())
          })
          return (
            <DialogV2 size="normal" class="confirm-action-dialog">
              <DialogHeader closeLabel={copy().close}>
                <DialogTitle>{options.title ?? copy().title}</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <p style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere", margin: "0" }}>{message}</p>
                <Show when={details}>
                  {(value) => (
                    <details class="confirm-action-details">
                      <summary>{value().summary}</summary>
                      <dl>
                        <For each={value().items}>
                          {(item) => (
                            <div>
                              <dt>{item.label}</dt>
                              <dd>
                                <code>{item.value}</code>
                              </dd>
                            </div>
                          )}
                        </For>
                      </dl>
                    </details>
                  )}
                </Show>
              </DialogBody>
              <DialogFooter>
                <ButtonV2
                  autofocus
                  onClick={() => {
                    finish(false)
                    handle?.close()
                  }}
                >
                  {copy().cancel}
                </ButtonV2>
                <ButtonV2
                  variant={options.danger ? "danger" : "contrast"}
                  onClick={() => {
                    finish(true)
                    handle?.close()
                  }}
                >
                  {options.confirmLabel ?? copy().confirm}
                </ButtonV2>
              </DialogFooter>
            </DialogV2>
          )
        },
        () => finish(false),
      )
    })
  }
}
