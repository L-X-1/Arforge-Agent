import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  closing?: boolean
  setClosing: (closing: boolean) => void
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined, id: undefined as string | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || current.closing || lock.value) return
    lock.value = true
    current.closing = true
    setStack((items) => [...items])
    current.onClose?.()
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.id = closed
    timer.current = setTimeout(() => {
      timer.id = undefined
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (stack().length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (element: DialogElement, owner: Owner, onClose: (() => void) | undefined, layer: number) => {
    const id = Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay
                data-component="dialog-overlay"
                style={{ "z-index": String(zIndex) }}
                onClick={() => close(id)}
              />
              <div
                data-dialog-layer={layer}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": String(zIndex),
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                {element()}
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    const active: Active = { id, node, dispose, owner, onClose, setClosing }
    setStack((items) => [...items, active])
    return id
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    if (timer.id) discard(timer.id)
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    return mount(element, owner, onClose, stack().length)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void) => {
    for (const item of stack()) item.dispose()
    setStack([])
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    return mount(element, owner, onClose, 0)
  }

  const discard = (id: string) => {
    const current = stack().find((item) => item.id === id)
    if (!current) return
    if (timer.id === id) {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = undefined
      timer.id = undefined
      lock.value = false
    }
    if (!current.closing) {
      current.closing = true
      current.onClose?.()
    }
    setStack((items) => items.filter((item) => item.id !== id))
    current.dispose()
  }

  return {
    stack,
    discard,
    close,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  const scoped = (id: string | undefined) => ({
    close: () => {
      if (id) ctx.close(id)
    },
    discard: () => {
      if (id) ctx.discard(id)
    },
  })

  return {
    get active() {
      return ctx.stack().findLast((item) => !item.closing)
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().findLast((item) => !item.closing)?.owner ?? owner
      return startTransition(() => ctx.show(element, base, onClose))
    },
    showScoped(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().findLast((item) => !item.closing)?.owner ?? owner
      return scoped(ctx.show(element, base, onClose))
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().findLast((item) => !item.closing)?.owner ?? owner
      return startTransition(() => ctx.push(element, base, onClose))
    },
    pushScoped(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().findLast((item) => !item.closing)?.owner ?? owner
      return scoped(ctx.push(element, base, onClose))
    },
    close() {
      ctx.close()
    },
  }
}
