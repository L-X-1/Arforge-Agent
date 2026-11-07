// Run through panel-focus-return.test.ts so Solid uses real browser exports in a fresh process.
import { afterEach, describe, expect, test } from "bun:test"
import { batch, createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPanelFocusReturn } from "./panel-focus-return"

const cleanups: (() => void)[] = []
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
)

function fixture(initialOpened = true, memoizedOpened = false) {
  const host = document.createElement("section")
  const workspace = document.createElement("main")
  workspace.id = "workspace-main"
  const panel = document.createElement("aside")
  const opener = document.createElement("button")
  const inside = document.createElement("button")
  const outside = document.createElement("button")
  const composer = document.createElement("div")
  composer.tabIndex = 0
  composer.contentEditable = "true"
  composer.dataset.slot = "prompt-input-editor"
  composer.textContent = "Keep my draft"
  panel.append(inside)
  workspace.append(composer, panel)
  host.append(opener, outside, workspace)
  document.body.append(host)
  for (const element of [opener, inside, outside, composer]) {
    element.getClientRects = () => [new DOMRect(0, 0, 100, 32)] as unknown as DOMRectList
  }
  opener.focus()
  const [state, setState] = createStore({ opened: initialOpened, scope: "server-a/workspace-a/session-a", source: 0 })
  const sources = [{}, {}]
  const frames = new Map<number, () => void>()
  let frame = 0
  let disposeRoot!: () => void
  let disposed = false
  const flush = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback())
  }
  createRoot((dispose) => {
    disposeRoot = dispose
    const opened = memoizedOpened ? createMemo(() => state.opened) : () => state.opened
    createPanelFocusReturn(
      {
        opened,
        readOpened: () => state.opened,
        source: () => sources[state.source],
        scope: () => state.scope,
        region: () => panel,
      },
      (callback) => {
        const id = ++frame
        frames.set(id, callback)
        return () => {
          frames.delete(id)
        }
      },
    )
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    disposeRoot()
  }
  cleanups.push(() => {
    dispose()
    flush()
    host.remove()
  })
  if (initialOpened) inside.focus()
  return { host, workspace, panel, opener, inside, outside, composer, state, setState, frames, flush, dispose }
}

describe("panel collapse focus ownership", () => {
  test("returns to the real opener after child autofocus, without changing the composer draft", () => {
    const f = fixture()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.opener).toBe(true)
    expect(f.composer.textContent).toBe("Keep my draft")
  })

  test("captures the opener on a later closed-to-open transition", () => {
    const f = fixture(false)
    f.outside.focus()
    f.setState("opened", true)
    f.inside.focus()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.outside).toBe(true)
  })

  test("survives immediate unmount and the browser falling back to body", () => {
    const f = fixture()
    f.setState("opened", false)
    f.dispose()
    f.inside.blur()
    f.panel.remove()
    expect(f.frames.size).toBe(1)
    f.flush()
    expect(document.activeElement === f.opener).toBe(true)
  })

  test("returns from neutral body focus when no outside interaction occurred", () => {
    const f = fixture()
    f.inside.blur()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.opener).toBe(true)
  })

  test("handles parent unmount before the child opened effect can flush", () => {
    const f = fixture()
    batch(() => {
      f.setState("opened", false)
      f.dispose()
      f.inside.blur()
      f.panel.remove()
    })
    f.flush()
    expect(document.activeElement === f.opener).toBe(true)
  })

  test("reads authoritative close state after parent disposal freezes component memos", () => {
    const f = fixture(true, true)
    batch(() => {
      f.setState("opened", false)
      f.dispose()
      f.inside.blur()
      f.panel.remove()
    })
    f.flush()
    expect(document.activeElement === f.opener).toBe(true)
  })

  test("uses only the current workspace's editable composer when the opener is gone", () => {
    const f = fixture()
    const unrelated = document.createElement("div")
    unrelated.tabIndex = 0
    unrelated.contentEditable = "true"
    unrelated.dataset.slot = "prompt-input-editor"
    unrelated.getClientRects = () => [new DOMRect(0, 0, 100, 32)] as unknown as DOMRectList
    f.host.prepend(unrelated)
    f.opener.remove()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.composer).toBe(true)
    expect(document.activeElement === unrelated).toBe(false)
  })

  for (const unavailable of ["disabled", "hidden", "inert", "display-none"] as const) {
    test(`falls back when the opener is ${unavailable}`, () => {
      const f = fixture()
      if (unavailable === "disabled") f.opener.disabled = true
      if (unavailable === "hidden") f.opener.hidden = true
      if (unavailable === "inert") f.opener.setAttribute("inert", "")
      if (unavailable === "display-none") f.opener.style.display = "none"
      f.setState("opened", false)
      f.flush()
      expect(document.activeElement === f.composer).toBe(true)
    })
  }

  test("does not focus a read-only or hidden fallback composer", () => {
    const f = fixture()
    f.opener.remove()
    f.composer.contentEditable = "false"
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
    f.composer.contentEditable = "true"
    f.workspace.setAttribute("inert", "")
    f.setState("opened", true)
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.composer).toBe(false)
  })

  test("keeps focus when the user moved to an outside control before collapse", () => {
    const f = fixture()
    f.outside.focus()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.outside).toBe(true)
  })

  test("a new outside focus followed by blur still cancels a pending return", () => {
    const f = fixture()
    f.setState("opened", false)
    f.outside.focus()
    f.outside.blur()
    f.flush()
    expect(document.activeElement === f.opener).toBe(false)
    expect(document.activeElement === f.composer).toBe(false)
  })

  test("an outside pointer gesture cancels the return even without moving focus", () => {
    const f = fixture()
    f.setState("opened", false)
    f.outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })

  test("a user's outside move followed by blur before collapse is not treated as removal", () => {
    const f = fixture()
    f.outside.focus()
    f.outside.blur()
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.opener).toBe(false)
  })

  for (const changed of ["scope", "source"] as const) {
    test(`does not return focus after the ${changed} changes`, () => {
      const f = fixture()
      f.setState("opened", false)
      if (changed === "scope") f.setState("scope", "server-a/workspace-a/session-b")
      else f.setState("source", 1)
      f.flush()
      expect(document.activeElement === f.inside).toBe(true)
    })
  }

  test("invalidates the opening cycle when a session changes while the panel stays open", () => {
    const f = fixture()
    f.setState("scope", "server-b/workspace-b/session-b")
    f.setState("opened", false)
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })

  test("rechecks the source after the panel has already been disposed", () => {
    const f = fixture()
    f.setState("opened", false)
    f.dispose()
    f.setState("scope", "server-b/workspace-b/session-b")
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })

  test("navigation/remount disposal of a still-open panel is not a collapse", () => {
    const f = fixture()
    f.dispose()
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })

  test("rapid reopening cancels the old close handoff", () => {
    const f = fixture()
    f.setState("opened", false)
    f.setState("opened", true)
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })

  test("does not steal focus from another window", () => {
    const f = fixture()
    f.setState("opened", false)
    window.dispatchEvent(new Event("blur"))
    f.flush()
    expect(document.activeElement === f.inside).toBe(true)
  })
})
