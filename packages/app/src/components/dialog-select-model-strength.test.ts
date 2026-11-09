import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { delegateEvents, insert, render } from "solid-js/web"
import type { ModelSelectionBinding } from "./dialog-select-model-binding"

type ShellProps = {
  children?: JSX.Element
  class?: string
  ref?: (element: HTMLDivElement) => void
  onKeyDown?: (event: KeyboardEvent) => void
}
let Picker: typeof import("./dialog-select-model-v2")
let fixture: ReturnType<typeof makeFixture>
const disposals: (() => void)[] = []
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
function shell(props: ShellProps) {
  const element = document.createElement("div")
  if (props.class) element.className = props.class
  props.ref?.(element)
  Object.assign(element, { $$keydown: props.onKeyDown })
  delegateEvents(["keydown"])
  insert(element, () => props.children)
  return element
}

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solid = require("babel-preset-solid")
  await plugin({
    name: "real-model-strength-component",
    setup(build) {
      build.onLoad({ filter: /[\\/](?:dialog-select-model-v2|model-strength-dial|keybind-v2)\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solid.default ?? solid, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Model strength JSX compilation failed")
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  mock.module("@kobalte/core/popover", () => ({
    Popover: Object.assign(
      (props: ShellProps & { onOpenChange: (open: boolean) => void }) => {
        fixture.open = props.onOpenChange
        return shell(props)
      },
      { Trigger: shell, Content: shell, Portal: shell, Title: shell },
    ),
  }))
  mock.module("@solidjs/router", () => ({ useParams: () => ({ id: "session" }), useSearchParams: () => [{}] }))
  mock.module("@arforge-ai/ui/context/dialog", () => ({ useDialog: () => ({ active: false, show: () => undefined }) }))
  mock.module("@arforge-ai/ui/v2/icon", () => ({ Icon: () => document.createElement("span") }))
  mock.module("@arforge-ai/ui/v2/badge-v2", () => ({ Tag: shell }))
  mock.module("@arforge-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: shell }))
  mock.module("./model-tooltip", () => ({ ModelTooltip: () => undefined }))
  mock.module("@/context/local", () => ({
    useLocal: () => ({ model: fixture.model, modelSelection: fixture.binding }),
  }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "zh", t: (key: string) => key }) }))
  mock.module("@/context/command", () => ({
    useCommand: () => ({
      keybindParts: (id: string) => {
        expect(id).toBe("model.variant.cycle")
        return fixture.state.shortcut
      },
      keybind: () => fixture.state.shortcut.join("+"),
    }),
  }))
  mock.module("@/context/sdk", () => ({ useSDK: () => () => fixture.sources[fixture.state.source] }))
  mock.module("@/context/server-sync", () => ({ useServerSync: () => () => ({ queryClient: fixture.queryClient }) }))
  mock.module("@/hooks/use-providers", () => ({
    useProviders: () => ({ connected: () => [{ id: "p", name: "Relay" }] }),
  }))
  mock.module("@/utils/persist", () => ({
    Persist: { window: () => "model-strength-test" },
    persisted: (_key: unknown, state: unknown[]) => [
      ...state,
      undefined,
      Object.assign(() => true, { promise: Promise.resolve() }),
    ],
  }))
  Picker = await import("./dialog-select-model-v2")
})

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})

function makeFixture() {
  const [state, set] = createStore({
    source: "A",
    scope: "source/draft-A",
    modelID: "alpha",
    variant: "max" as string | undefined,
    ready: true,
    available: true,
    shortcut: ["Alt", "R"],
    metadata: {
      low: { body: { reasoning_effort: "low" } },
      high: { body: { reasoning_effort: "high" } },
      max: { body: { reasoning_effort: "max" } },
      off: { body: { thinking: { type: "disabled" } } },
      auto: { body: { reasoning_effort: "auto" } },
      default: { body: { reasoning_effort: "medium" } },
      json: { body: { response_format: { type: "json_object" } } },
    } as Record<string, unknown>,
  })
  const writes: Array<string | undefined> = []
  let write = (value: string | undefined): void | Promise<void> => {
    set("variant", value)
  }
  const items = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    provider: { id: "p", name: "Relay" },
    get variants() {
      return state.metadata
    },
  }))
  const model = {
    ready: () => state.ready,
    visible: () => true,
    list: () => items,
    current: () => (state.available ? items.find((item) => item.id === state.modelID) : undefined),
    variant: {
      list: () => Object.keys(state.metadata),
      current: () => state.variant,
      set: (value: string | undefined) => {
        writes.push(value)
        return write(value)
      },
    },
  }
  const binding: ModelSelectionBinding = {
    scope: () => state.scope,
    key: () => ({ providerID: "p", modelID: state.modelID }),
    ready: () => state.ready,
    unavailable: () => undefined,
    select: () => undefined,
  }
  return {
    state,
    set,
    model,
    binding,
    writes,
    open: (_value: boolean) => {},
    sources: {
      A: { scope: "A", directory: "E:/strength-test" },
      B: { scope: "B", directory: "E:/strength-test" },
    } as Record<string, { scope: string; directory: string }>,
    queryClient: {
      getQueryState: () => ({ status: "success", data: {} }),
      getQueryCache: () => ({ subscribe: () => () => undefined }),
    },
    setWrite: (next: typeof write) => (write = next),
  }
}

async function mount() {
  fixture = makeFixture()
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(Picker.ModelSelectorPopoverV2, {
        model: fixture.model as unknown as NonNullable<Parameters<typeof Picker.ModelSelectorPopoverV2>[0]["model"]>,
        binding: fixture.binding,
      }),
    host,
  )
  disposals.push(() => {
    dispose()
    host.remove()
  })
  fixture.open(true)
  await settle()
  return {
    host,
    range: () => host.querySelector<HTMLInputElement>('input[type="range"]')!,
    options: () => host.querySelector<HTMLElement>('[data-slot="model-strength-options"]')!,
    dial: () => host.querySelector('[data-slot="model-strength-dial"]'),
    stops: () => [...host.querySelectorAll('[data-slot="model-strength-stop"]')],
    selectedStop: () => host.querySelector('[data-slot="model-strength-stop"][data-selected="true"]'),
    value: () => host.querySelector("output")!.textContent,
    mode: (key: string) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>("button[data-variant-key]")).find(
        (item) => item.dataset.variantKey === key,
      )!,
  }
}

function preview(input: HTMLInputElement, index: number) {
  input.value = String(index)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
function commit(input: HTMLInputElement) {
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

describe("real model reasoning footer", () => {
  test("shows the selected label, neural dial, only actual tier stops and configured keycaps", async () => {
    const view = await mount()
    expect(view.value()).toBe("最高")
    expect(view.range().max).toBe("3")
    expect(view.range().getAttribute("aria-valuetext")).toBe("最高")
    expect(view.dial()?.querySelector("canvas")).not.toBeNull()
    expect(view.stops().map((stop) => stop.getAttribute("title"))).toEqual(["关闭", "低", "高", "最高"])
    expect(view.options().dataset.strengthState).toBe("max")
    expect(view.selectedStop()?.getAttribute("title")).toBe("最高")
    expect(view.host.querySelector('[data-component="keybind-v2"]')?.textContent).toBe("AltR")
    fixture.set("shortcut", ["Shift", "F9"])
    expect(view.host.querySelector('[data-component="keybind-v2"]')?.textContent).toBe("ShiftF9")
    fixture.set("shortcut", [])
    expect(view.host.querySelector('[data-component="keybind-v2"]')).toBeNull()
    expect(fixture.writes).toEqual([])
  })
  test("moves the selected dial stop and current label before committing one exact recipe", async () => {
    const view = await mount()
    for (const [index, label, state] of [
      [2, "高", "level"],
      [1, "低", "level"],
      [0, "关闭", "off"],
    ] as const) {
      preview(view.range(), index)
      expect(view.range().valueAsNumber).toBe(index)
      expect(view.value()).toBe(label)
      expect(view.range().getAttribute("aria-valuetext")).toBe(label)
      expect(view.options().dataset.strengthState).toBe(state)
      expect(view.selectedStop()?.getAttribute("title")).toBe(label)
      expect(fixture.state.variant).toBe("max")
      expect(fixture.writes).toEqual([])
    }
    commit(view.range())
    await settle()
    expect(fixture.writes).toEqual(["off"])
    expect(view.value()).toBe("关闭")
    expect(view.options().dataset.strengthState).toBe("off")
  })
  test("retires the dial canvas on close and restores the current choice on reopen", async () => {
    const view = await mount()
    const canvas = view.dial()?.querySelector("canvas")
    expect(canvas).toBeTruthy()
    fixture.open(false)
    expect(canvas?.isConnected).toBe(false)
    fixture.open(true)
    await settle()
    expect(view.selectedStop()?.getAttribute("title")).toBe("最高")
  })
  test("reset, off, automatic, model default and generic presets remain distinct", async () => {
    const view = await mount()
    expect(view.mode(JSON.stringify(["variant", "off"]))).toBeUndefined()
    for (const value of [undefined, "auto", "default"]) {
      view.mode(value === undefined ? "reset" : JSON.stringify(["variant", value])).click()
      await settle()
      expect(fixture.state.variant).toBe(value)
      expect(view.options().dataset.strengthState).toBe("mode")
      expect(view.selectedStop()).toBeNull()
    }
    const presets = view.host.querySelector<HTMLSelectElement>("select")!
    presets.value = JSON.stringify(["variant", "json"])
    presets.dispatchEvent(new Event("change", { bubbles: true }))
    await settle()
    expect(fixture.writes).toEqual([undefined, "auto", "default", "json"])
    expect(presets.getAttribute("aria-label")).toBe("其他选项")
  })
  test("pointer activation can choose the lowest tier from default even with no native value change", async () => {
    const view = await mount()
    fixture.set("variant", undefined)
    view.range().dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerType: "touch", bubbles: true }))
    view.range().dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "touch", bubbles: true }))
    await settle()
    expect(fixture.writes).toEqual(["off"])
  })
  test("native arrows and Home/End are not prevented or redirected to model navigation", async () => {
    const view = await mount()
    for (const [key, index, value] of [
      ["Home", 0, "off"],
      ["End", 3, "max"],
      ["ArrowLeft", 2, "high"],
    ] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      view.range().dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      // Happy DOM does not implement the browser's range default action.
      preview(view.range(), index)
      commit(view.range())
      await settle()
      expect(fixture.state.variant).toBe(value)
    }
  })
  test("Home chooses the first real level from default without requiring a changed numeric value", async () => {
    const view = await mount()
    fixture.set("variant", undefined)
    view.range().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    view.range().dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }))
    await settle()
    expect(fixture.writes).toEqual(["off"])
  })
  test("clicking the current thumb or pressing End at max leaves the effective preference alone", async () => {
    const view = await mount()
    const slider = view.range()
    slider.dispatchEvent(new PointerEvent("pointerdown", { button: 0, pointerType: "mouse", bubbles: true }))
    slider.dispatchEvent(new PointerEvent("pointerup", { button: 0, pointerType: "mouse", bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    slider.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }))
    await settle()
    expect(view.value()).toBe("最高")
    expect(fixture.writes).toEqual([])
  })
  test("pointer cancellation discards preview and an ensuing change cannot commit it", async () => {
    const view = await mount()
    preview(view.range(), 0)
    view.range().dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
    commit(view.range())
    expect(fixture.writes).toEqual([])
    expect(view.value()).toBe("最高")
    expect(view.range().valueAsNumber).toBe(3)
    expect(view.options().dataset.strengthState).toBe("max")
  })
  test("successful same-owner writes restore range focus lost while it was disabled", async () => {
    const view = await mount()
    let resolve!: () => void
    fixture.setWrite(
      (value) =>
        new Promise<void>((done) => {
          resolve = () => {
            fixture.set("variant", value)
            done()
          }
        }),
    )
    view.range().focus()
    preview(view.range(), 2)
    commit(view.range())
    // Browsers may move focus to body when the pending range becomes disabled.
    document.body.tabIndex = -1
    document.body.focus()
    resolve()
    await settle()
    expect(document.activeElement).toBe(view.range())
    expect(fixture.state.variant).toBe("high")
    document.body.removeAttribute("tabindex")
  })
  test("unknown metadata keeps a disabled explained footer and manage action; names do not invent tiers", async () => {
    const view = await mount()
    fixture.set("metadata", reconcile({ max: {}, custom: { body: { temperature: 0.2 } } }))
    expect(view.range().disabled).toBe(true)
    expect(view.value()).toBe("不可调节")
    expect(view.host.querySelector('[data-slot="model-strength"]')?.textContent).toContain("未提供明确的思考预设")
    expect(view.range().getAttribute("aria-describedby")).toContain("strength-reason")
    expect(view.host.textContent).toContain("dialog.model.manage")
    expect(view.stops()).toHaveLength(0)
    preview(view.range(), 0)
    commit(view.range())
    expect(fixture.writes).toEqual([])
  })
  test("a single real strength remains explicitly selectable without fabricating a second stop", async () => {
    const view = await mount()
    fixture.set("metadata", reconcile({ only: { body: { reasoning_effort: "high" } } }))
    expect(view.range().max).toBe("0")
    expect(view.range().disabled).toBe(true)
    view.mode(JSON.stringify(["variant", "only"])).click()
    await settle()
    expect(fixture.writes).toEqual(["only"])
  })
  test("a mid-drag model A/B/A change permanently invalidates the captured gesture", async () => {
    const view = await mount()
    preview(view.range(), 0)
    fixture.set("modelID", "beta")
    fixture.set("modelID", "alpha")
    commit(view.range())
    await settle()
    expect(fixture.writes).toEqual([])
    expect(view.value()).toBe("最高")
  })
  for (const finish of ["pointerup", "pointercancel"] as const) {
    test(`a stale dial ${finish} after A/B/A cannot commit or discard a newer keyboard preview`, async () => {
      const view = await mount()
      const dial = view.dial() as HTMLDivElement
      dial.setPointerCapture = () => undefined
      const pointer = { button: 0, pointerId: 7, pointerType: "mouse", bubbles: true, cancelable: true }
      view.stops()[0].dispatchEvent(new PointerEvent("pointerdown", pointer))
      expect(view.value()).toBe("关闭")

      fixture.set("modelID", "beta")
      fixture.set("modelID", "alpha")
      const range = view.range()
      range.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
      range.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }))
      range.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
      preview(range, 2)
      expect(view.value()).toBe("高")

      dial.dispatchEvent(new PointerEvent(finish, pointer))
      expect(fixture.writes).toEqual([])
      expect(view.value()).toBe("高")
      commit(range)
      await settle()
      expect(fixture.writes).toEqual(["high"])
    })
  }
  test("a model change after pointer-down but before its first input also invalidates the gesture", async () => {
    const view = await mount()
    view.range().dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }))
    fixture.set("modelID", "beta")
    preview(view.range(), 0)
    commit(view.range())
    expect(fixture.writes).toEqual([])
  })
  test("a loading or missing model keeps its explanation and prevents preset writes", async () => {
    const view = await mount()
    fixture.set("ready", false)
    expect(view.range().disabled).toBe(true)
    expect(view.host.querySelector('[data-slot="model-strength"]')?.textContent).toContain("common.loading")
    fixture.set("ready", true)
    fixture.set("available", false)
    expect(view.range().disabled).toBe(true)
    expect(view.host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true)
    expect(view.host.querySelector('[data-slot="model-strength"]')?.textContent).toContain("当前模型不可用")
  })
  test("a mid-drag metadata replacement or scope/source change cannot write into its replacement", async () => {
    const view = await mount()
    preview(view.range(), 0)
    fixture.set("metadata", "low", { body: { reasoning_effort: "medium" } })
    commit(view.range())
    expect(fixture.writes).toEqual([])
    preview(view.range(), 2)
    fixture.set("scope", "source/draft-B")
    commit(view.range())
    fixture.open(true)
    await settle()
    preview(view.range(), 0)
    fixture.set("source", "B")
    commit(view.range())
    expect(fixture.writes).toEqual([])
  })
  test("pending writes disable controls and late rejection cannot publish after model replacement", async () => {
    const view = await mount()
    let reject!: (error: Error) => void
    fixture.setWrite(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    preview(view.range(), 2)
    commit(view.range())
    expect(view.range().disabled).toBe(true)
    expect(view.mode("reset").disabled).toBe(true)
    fixture.set("modelID", "beta")
    reject(new Error("owned synthetic failure"))
    await settle()
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    expect(view.range().disabled).toBe(false)
    expect(fixture.writes).toEqual(["high"])
  })
  test("current failures preserve the selected value and report an error", async () => {
    const view = await mount()
    fixture.setWrite(() => {
      throw new Error("owned synthetic failure")
    })
    preview(view.range(), 0)
    commit(view.range())
    await settle()
    expect(fixture.state.variant).toBe("max")
    expect(view.value()).toBe("最高")
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("已保留原选择和草稿")
  })
  test("pending errors from replaced reasoning metadata are discarded", async () => {
    const view = await mount()
    let reject!: (error: Error) => void
    fixture.setWrite(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    preview(view.range(), 0)
    commit(view.range())
    fixture.set("metadata", "low", { body: { reasoning_effort: "medium" } })
    reject(new Error("owned synthetic failure"))
    await settle()
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    expect(view.range().disabled).toBe(false)
  })
})
