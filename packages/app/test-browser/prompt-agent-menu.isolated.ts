// Explicit isolated DOM regression for the real Kobalte menu. No browser, server or build starts here.
import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

let Select: typeof import("@arforge-ai/session-ui/v2/prompt-input").PromptInputV2Select
const disposals: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core"), solid = require("babel-preset-solid")
  await plugin({ name: "agent-menu-solid-dom", setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/](app|ui|session-ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await Bun.file(path).text(), {
        filename: path, configFile: false, babelrc: false, parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solid.default ?? solid, { generate: "dom" }]],
      })
      if (!result?.code) throw Error("Solid test compilation failed: " + path)
      return { contents: result.code, loader: "ts" }
    })
  } })
  const empty = () => document.createElement("span")
  mock.module("@arforge-ai/ui/provider-icon", () => ({ ProviderIcon: empty }))
  mock.module("@arforge-ai/ui/file-icon", () => ({ FileIcon: empty }))
  mock.module("@arforge-ai/ui/icon", () => ({ Icon: empty }))
  mock.module("@arforge-ai/ui/v2/icon", () => ({ Icon: empty }))
  mock.module("@arforge-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: (props: { children: JSX.Element }) => props.children }))
  Select = (await import("@arforge-ai/session-ui/v2/prompt-input")).PromptInputV2Select
})
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); document.body.replaceChildren() })

function fixture(search = true) {
  const [state, setState] = createStore({ scope: "server-A/workspace/A", current: "build", sourceRevision: 0 })
  const selections: string[] = [], configurations: string[] = []
  const host = document.createElement("div"); document.body.append(host)
  disposals.push(render(() => createComponent(Select, {
    title: "Choose agent", get current() { return state.current },
    options: [{ id: "build", label: "Build", description: "Built-in reader" }, { id: "review", label: "Review", description: "Configured reviewer" }],
    get scope() { void state.sourceRevision; return state.scope }, search,
    configure: { label: "Agent visibility settings", run: () => configurations.push(state.scope) },
    onSelect: id => { selections.push(state.scope + ":" + id); setState("current", id) },
  }), host))
  return { host, state, setState, selections, configurations, trigger: host.querySelector<HTMLButtonElement>("button")! }
}
async function open(trigger: HTMLButtonElement) {
  trigger.focus(); trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await settle()
}
function query(value: string) {
  const input = document.querySelector<HTMLInputElement>('[data-prompt-mode-menu] input[type="search"]')!
  expect(input).not.toBeNull(); input.value = value; input.dispatchEvent(new InputEvent("input", { bubbles: true })); return input
}
function activate(item: HTMLElement) {
  item.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }))
}

test("pointer-open search keeps focus after the real menu's deferred autofocus", async () => {
  const f = fixture()
  f.trigger.focus()
  f.trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }))
  await settle()
  const input = document.querySelector<HTMLInputElement>('[data-prompt-mode-menu] input[type="search"]')
  expect(input !== null).toBe(true)
  expect(document.activeElement === input).toBe(true)
  expect(f.selections).toEqual([])
})

test("pending pointer-open autofocus is cancelled when the captured source changes", async () => {
  const f = fixture()
  f.trigger.focus()
  f.trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }))
  f.setState("scope", "server-B/workspace/B")
  const next = document.createElement("button"); next.textContent = "New owner"; document.body.append(next); next.focus()
  await settle()
  expect(f.trigger.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement === next).toBe(true)
  expect(f.selections).toEqual([]); expect(f.configurations).toEqual([])
})

test("source-change close preserves newer outside focus and the next menu can open normally", async () => {
  const f = fixture(); await open(f.trigger)
  const first = document.createElement("button"), next = document.createElement("button")
  document.body.append(first, next)
  f.setState("scope", "server-B/workspace/B")
  first.focus()
  queueMicrotask(() => next.focus())
  await settle()
  expect(document.activeElement === next).toBe(true)
  expect(f.trigger.getAttribute("aria-expanded")).toBe("false")
  f.trigger.focus()
  f.trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true, cancelable: true }))
  await settle()
  const input = document.querySelector<HTMLInputElement>('[data-prompt-mode-menu] input[type="search"]')
  expect(document.activeElement === input).toBe(true)
  expect(f.selections).toEqual([]); expect(f.configurations).toEqual([])
})

test("Agent search finds descriptions, keeps selection for no results and restores keyboard focus", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("no-agent-here"); await settle()
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(0)
  expect(document.querySelector('[role="status"]')?.textContent).toContain("No results")
  expect(f.state.current).toBe("build"); expect(f.selections).toEqual([])
  query("configured"); await settle()
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(e => e.getAttribute("aria-label"))).toEqual(["Review"])
  const describedBy = document.querySelector('[role="menuitemradio"]')?.getAttribute("aria-describedby")
  expect(!!describedBy).toBe(true)
  expect(document.getElementById(describedBy!)?.textContent).toBe("Configured reviewer")
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await settle()
  expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio")
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await settle()
  expect(f.selections).toEqual(["server-A/workspace/A:review"])
  await open(f.trigger); const reopened = query("missing"); await settle()
  reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle()
  expect(document.activeElement === f.trigger).toBe(true)
})

test("source change closes the old menu and cannot retarget a captured Agent action", async () => {
  const f = fixture(); await open(f.trigger)
  const old = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!
  const oldConfigure = document.querySelector<HTMLElement>('[data-agent-configure]')!
  expect(old).not.toBeNull(); f.setState("scope", "server-B/workspace/B"); await settle()
  activate(old); await settle()
  expect(f.selections).toEqual([]); expect(f.configurations).toEqual([])
  // Kobalte may retain closed content for its exit animation; expanded state is authoritative.
  expect(f.trigger.getAttribute("aria-expanded")).toBe("false")
  await open(f.trigger); query("review"); await settle()
  activate(oldConfigure); await settle()
  expect(f.configurations).toEqual([])
  if (f.trigger.getAttribute("aria-expanded") !== "true") await open(f.trigger)
  activate(document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!); await settle()
  expect(f.selections).toEqual(["server-B/workspace/B:review"])
  await open(f.trigger)
  activate(document.querySelector<HTMLElement>('[data-agent-configure]')!); await settle()
  expect(f.configurations).toEqual(["server-B/workspace/B"])
})

test("permission/model style selects keep their existing unfiltered menu", async () => {
  const f = fixture(false); await open(f.trigger)
  expect(document.querySelector('input[type="search"]')).toBeNull()
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(2)
  expect(document.querySelector('[data-agent-configure]')).toBeNull()
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes("Review"))!
  activate(option); await settle()
  expect(f.selections).toEqual(["server-A/workspace/A:review"])
})

test("empty-search Enter cannot select or submit, clear restores options, and IME stays local", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  input.dispatchEvent(enter)
  expect(enter.defaultPrevented).toBe(true); expect(f.selections).toEqual([])
  const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })
  input.dispatchEvent(composing)
  expect(composing.defaultPrevented).toBe(false); expect(f.selections).toEqual([])
  document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click(); await settle()
  expect(input.value).toBe("")
  expect(document.activeElement === input).toBe(true)
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(2)
  expect(f.state.current).toBe("build")
})

test("Clear focus survives a same-source upstream dependency settling after the click", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
  clear.focus(); clear.click()
  f.setState("sourceRevision", 1)
  await settle()
  expect(input.value).toBe("")
  expect(document.activeElement === input).toBe(true)
  expect(f.selections).toEqual([]); expect(f.configurations).toEqual([])
})

test("Clear focus is retained when the same-source upstream dependency settles before the click", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  f.setState("sourceRevision", 1); await settle()
  const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
  clear.focus(); clear.click(); await settle()
  expect(document.activeElement === input).toBe(true)
})

test("Agent mere hover after Clear retains typing focus while deliberate selection still works", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click(); await settle()
  expect(document.activeElement === input).toBe(true)
  const option = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!
  const hover = new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true })
  option.dispatchEvent(hover); await settle()
  expect(document.activeElement === input).toBe(true)
  expect(hover.defaultPrevented).toBe(true)
  expect(f.selections).toEqual([])
  activate(option); await settle()
  expect(f.selections).toEqual(["server-A/workspace/A:review"])
  await open(f.trigger)
  const search = document.querySelector<HTMLInputElement>('[data-prompt-mode-menu] input[type="search"]')!
  const configure = document.querySelector<HTMLElement>('[data-agent-configure]')!
  configure.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true }))
  await settle(); expect(document.activeElement === search).toBe(true)
  activate(configure); await settle(); expect(f.configurations).toEqual(["server-A/workspace/A"])
})

test("touch and pressed mouse moves are not consumed by the Agent hover guard", async () => {
  const f = fixture(); await open(f.trigger)
  const input = document.querySelector<HTMLInputElement>('[data-prompt-mode-menu] input[type="search"]')!
  const option = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!
  const touch = new PointerEvent("pointermove", { pointerType: "touch", buttons: 1, bubbles: true, cancelable: true })
  option.dispatchEvent(touch); await settle()
  expect(touch.defaultPrevented).toBe(false)
  expect(document.activeElement === input).toBe(true)
  const pressed = new PointerEvent("pointermove", { pointerType: "mouse", buttons: 1, bubbles: true, cancelable: true })
  option.dispatchEvent(pressed); await settle()
  expect(pressed.defaultPrevented).toBe(false)
  expect(document.activeElement === option).toBe(true)
  expect(f.selections).toEqual([])
})

test("Nonsearch menu hover keeps the existing pointer focus transfer", async () => {
  const f = fixture(false); await open(f.trigger)
  const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent?.includes("Review"))!
  const hover = new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true })
  option.dispatchEvent(hover); await settle()
  expect(hover.defaultPrevented).toBe(false)
  expect(document.activeElement === option).toBe(true)
})

test("Clear keeps typing focus after the removed button blurs and options mount", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
  // Chrome blurs the focused conditional button when it is removed. Happy DOM
  // does not synthesize that loss of focus, so reproduce it before the real click.
  clear.focus(); clear.blur(); clear.click(); await settle()
  expect(input.value).toBe("")
  expect(document.querySelectorAll('[role="menuitemradio"]').length).toBe(2)
  expect(document.activeElement === input).toBe(true)
  expect(f.selections).toEqual([])
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await settle()
  expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio")
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await settle()
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Review")
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await settle()
  expect(f.selections).toEqual(["server-A/workspace/A:review"])
})

test("native nonbubbling item leave and reenter after Clear preserve Agent typing focus", async () => {
  const f = fixture(); await open(f.trigger)
  const input = query("absent"); await settle()
  const clear = document.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!
  clear.focus(); clear.blur(); clear.click(); await settle()
  expect(document.activeElement === input).toBe(true)
  const build = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Build"]')!
  const review = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!
  const configure = document.querySelector<HTMLElement>('[data-agent-configure]')!
  // Kobalte's real item-leave handler ignores preventDefault and focuses the menu.
  // Native pointerleave does not bubble, but it reaches the menu's capture listener.
  for (const [item, next] of [[build, review], [review, configure], [configure, build]]) {
    item!.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true }))
    item!.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", buttons: 0, bubbles: false, relatedTarget: next }))
    await settle()
    expect(document.activeElement === input).toBe(true)
    next!.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true }))
    await settle(); expect(document.activeElement === input).toBe(true)
  }
  expect(f.selections).toEqual([]); expect(f.configurations).toEqual([])
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await settle()
  expect(document.activeElement === build).toBe(true)
  review.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true }))
  await settle(); expect(document.activeElement === review).toBe(true)
  activate(review); await settle(); expect(f.selections).toEqual(["server-A/workspace/A:review"])
})

test("native item-leave capture permits touch, pressed mouse and nonsearch menu handlers", async () => {
  const f = fixture(); await open(f.trigger)
  const review = document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label="Review"]')!
  const seen: string[] = []
  review.addEventListener("pointerleave", event => seen.push(event.pointerType))
  review.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch", buttons: 1, bubbles: false }))
  review.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", buttons: 1, bubbles: false }))
  await settle(); expect(seen).toEqual(["touch", "mouse"])
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await settle()
  const plain = fixture(false); await open(plain.trigger)
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent?.includes("Review"))!
  let leaves = 0
  item.addEventListener("pointerleave", () => leaves++)
  item.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", buttons: 0, bubbles: true, cancelable: true }))
  await settle(); expect(document.activeElement === item).toBe(true)
  item.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", buttons: 0, bubbles: false }))
  await settle(); expect(leaves).toBe(1)
})
