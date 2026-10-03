import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createAutoScroll, type AutoScrollOptions } from "./create-auto-scroll"

const originalResizeObserver = globalThis.ResizeObserver
const observers = new Set<TestResizeObserver>()
let dispose: (() => void) | undefined

class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }

  observe(target: Element) {
    this.targets.add(target)
  }

  unobserve(target: Element) {
    this.targets.delete(target)
  }

  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }

  emit(height: number) {
    this.callback(
      [...this.targets].map((target) => ({
        target,
        contentRect: { width: 600, height } as DOMRectReadOnly,
        borderBoxSize: [{ inlineSize: 600, blockSize: height }],
        contentBoxSize: [{ inlineSize: 600, blockSize: height }],
        devicePixelContentBoxSize: [{ inlineSize: 600, blockSize: height }],
      })),
      this,
    )
  }
}

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  observers.clear()
  globalThis.ResizeObserver = originalResizeObserver
})

async function setup(options: Partial<AutoScrollOptions> = {}) {
  let height = 1000
  let top = 500
  const viewport = document.createElement("div")
  const content = document.createElement("div")
  viewport.append(content)
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 500 },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, height - 500)) },
    },
  })
  const auto = createRoot((cleanup) => {
    dispose = cleanup
    const auto = createAutoScroll({ working: () => false, settleAfterStop: false, ...options })
    auto.scrollRef(viewport)
    auto.contentRef(content)
    return auto
  })
  await Promise.resolve()
  expect([...observers].some((observer) => observer.targets.has(content))).toBe(true)
  const resize = (next: number) => {
    height = next
    for (const observer of observers) observer.emit(next)
  }
  return { auto, viewport, resize }
}

describe("idle layout bottom anchoring", () => {
  test("follows multiple late measurements after the initial bottom placement", async () => {
    const { viewport, resize } = await setup({ followOnResize: () => true })
    resize(1400)
    expect(viewport.scrollTop).toBe(900)
    resize(2200)
    expect(viewport.scrollTop).toBe(1700)
  })

  test("preserves the default idle behavior without opting in", async () => {
    const { viewport, resize } = await setup()
    resize(1800)
    expect(viewport.scrollTop).toBe(500)
  })

  test("respects a changing history or gesture guard", async () => {
    let follow = false
    const { viewport, resize } = await setup({ followOnResize: () => follow })
    resize(1400)
    expect(viewport.scrollTop).toBe(500)
    follow = true
    resize(1600)
    expect(viewport.scrollTop).toBe(1100)
    follow = false
    resize(2000)
    expect(viewport.scrollTop).toBe(1100)
  })

  test("does not resume an explicitly paused reader on resize", async () => {
    const { auto, viewport, resize } = await setup({ followOnResize: () => true })
    auto.pause()
    resize(1800)
    expect(viewport.scrollTop).toBe(500)
    expect(auto.userScrolled()).toBe(true)
    auto.resume()
    expect(viewport.scrollTop).toBe(1300)
    resize(2200)
    expect(viewport.scrollTop).toBe(1700)
  })

  test("preserves keyboard and scrollbar navigation away from the bottom", async () => {
    const { auto, viewport, resize } = await setup({ followOnResize: () => true })
    viewport.scrollTop = 200
    auto.handleScroll()
    resize(1700)
    expect(viewport.scrollTop).toBe(200)
    expect(auto.userScrolled()).toBe(true)
  })

  test("does not write to a detached viewport after a handoff", async () => {
    const { auto, viewport, resize } = await setup({ followOnResize: () => true })
    auto.scrollRef(undefined)
    resize(1800)
    expect(viewport.scrollTop).toBe(500)
  })
})
