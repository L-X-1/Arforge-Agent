import { expect, test } from "bun:test"
import type { Page } from "@playwright/test"
import { isStableDestination } from "../timeline/session-tab-switch-metrics"
import {
  measureSessionSwitch,
  timelineStabilityError,
  waitForStableTimeline,
} from "../timeline/session-tab-switch-probe"

test("measures remaining scroll rather than the bottom spacer's layout gap", async () => {
  const rect = (top: number, bottom: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 800,
    width: 800,
    height: bottom - top,
    toJSON: () => ({}),
  })
  const root = document.createElement("div")
  root.className = "scroll-view__viewport"
  root.getBoundingClientRect = () => rect(74.5, 606.5)
  Object.defineProperties(root, {
    scrollHeight: { value: 6057 },
    clientHeight: { value: 532 },
    scrollTop: { value: 5525, writable: true },
  })
  const last = document.createElement("div")
  last.dataset.messageId = "destination"
  last.dataset.timelineRow = "message"
  last.getBoundingClientRect = () => rect(550, 590)
  const spacer = document.createElement("div")
  spacer.dataset.timelineRow = "bottom-spacer"
  spacer.getBoundingClientRect = () => rect(590, 598.5)
  root.append(last, spacer)
  document.body.append(root)

  const originalFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => Number(setTimeout(() => callback(performance.now()), 0)),
  })
  type Sample = { last: boolean; bottomErrorPx?: number }
  const samples: Sample[] = []
  let sampleTimeline: ((lastID: string) => Promise<Sample>) | undefined
  const page = {
    evaluate: async (callback: (lastID: string) => Promise<Sample>, lastID: string) => {
      sampleTimeline = callback
      const sample = await callback(lastID)
      samples.push(sample)
      return sample
    },
  } as unknown as Page

  try {
    await waitForStableTimeline(page, "destination")

    expect(samples).toHaveLength(3)
    expect(samples.every((sample) => sample.last && sample.bottomErrorPx === 0)).toBe(true)
    expect(spacer.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom).toBe(-8)

    root.scrollTop = 5517
    const notAtBottom = await sampleTimeline!("destination")
    expect(notAtBottom.bottomErrorPx).toBe(8)
    expect(isStableDestination([notAtBottom, notAtBottom, notAtBottom])).toBe(false)

    root.scrollTop = 5525
    last.getBoundingClientRect = () => rect(10, 50)
    const notVisible = await sampleTimeline!("destination")
    expect(notVisible.last).toBe(false)
    expect(isStableDestination([notVisible, notVisible, notVisible])).toBe(false)

    last.getBoundingClientRect = () => rect(550, 590)
    spacer.remove()
    const missingSpacer = await sampleTimeline!("destination")
    expect(missingSpacer.bottomErrorPx).toBeUndefined()
    expect(isStableDestination([missingSpacer, missingSpacer, missingSpacer])).toBe(false)
  } finally {
    root.remove()
    if (originalFrame) Object.defineProperty(globalThis, "requestAnimationFrame", originalFrame)
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame")
  }
})

test("reports only the last three stability samples and preserves the original failure", () => {
  const cause = new Error("poll timeout")
  const samples = [
    { last: false, bottomErrorPx: 99 },
    { last: true, bottomErrorPx: 4 },
    { last: true, bottomErrorPx: 3 },
    { last: true, bottomErrorPx: 2 },
  ]
  const error = timelineStabilityError("message-last", samples, cause)

  expect(error.cause).toBe(cause)
  expect(error.message).toBe(
    `Timeline did not stabilize: lastMessageID=message-last, samples=4, recent=${JSON.stringify(samples.slice(-3))}`,
  )
})

test("reports a stability failure before any sample is available", () => {
  const error = timelineStabilityError("message-last", [], new Error("page closed"))

  expect(error.message).toContain("lastMessageID=message-last, samples=0, recent=[]")
})

function testPage(waitFailure?: Error, cleanupFailure?: Error) {
  const stops: unknown[] = []
  const waits: unknown[] = []
  const page = {
    evaluate: async (_callback: unknown, input?: unknown) => {
      if (input) return
      stops.push(undefined)
      if (cleanupFailure) throw cleanupFailure
    },
    waitForFunction: async (_callback: unknown, _argument: unknown, options: unknown) => {
      waits.push(options)
      if (waitFailure) throw waitFailure
    },
  } as unknown as Page
  return { page, stops, waits }
}

function input(run: () => Promise<void>) {
  return {
    destinationIDs: ["destination"],
    sourceIDs: ["source"],
    lastID: "destination",
    href: "/session/destination",
    switch: run,
  }
}

test("stops sampling when the session switch fails", async () => {
  const failure = new Error("switch failed")
  const context = testPage()

  await expect(
    measureSessionSwitch(
      context.page,
      input(async () => Promise.reject(failure)),
    ),
  ).rejects.toBe(failure)

  expect(context.stops).toHaveLength(1)
})

test("stops sampling when the stable wait fails", async () => {
  const failure = new Error("stable wait failed")
  const context = testPage(failure)

  await expect(
    measureSessionSwitch(
      context.page,
      input(async () => {}),
    ),
  ).rejects.toBe(failure)

  expect(context.stops).toHaveLength(1)
  expect(context.waits).toEqual([{ timeout: 30_000 }])
})

test.each(["switch", "wait"] as const)("preserves the original %s error when sampler cleanup fails", async (phase) => {
  const failure = new Error(`${phase} failed`)
  const context = testPage(phase === "wait" ? failure : undefined, new Error("page closed during cleanup"))

  await expect(measureSessionSwitch(context.page, input(async () => {
    if (phase === "switch") throw failure
  }))).rejects.toBe(failure)

  expect(context.stops).toHaveLength(1)
})

test("includes failed visibility samples and target geometry without losing the timeout cause", async () => {
  const timeout = new Error("stable wait timed out")
  const diagnostics = {
    sampleCount: 300,
    recent: [{ destination: ["destination"], source: [], last: true, requiredPartVisible: false }],
    lastMatches: [{ top: 100, bottom: 200, width: 800, height: 100 }],
    requiredPartMatches: [],
    visiblePartIDs: ["actual-part"],
  }
  const page = {
    evaluate: async (_callback: unknown, argument?: { href?: string }) => {
      if (argument?.href) return
      if (argument) return diagnostics
      throw new Error("page closed during cleanup")
    },
    waitForFunction: async () => { throw timeout },
  } as unknown as Page

  const failure = await measureSessionSwitch(page, {
    ...input(async () => {}),
    requiredPartID: "expected-part",
  }).catch((error) => error)

  expect(failure).toBeInstanceOf(Error)
  expect(failure.cause).toBe(timeout)
  expect(failure.message).toBe(`Session switch did not stabilize: ${JSON.stringify({
    lastID: "destination",
    requiredPartID: "expected-part",
    ...diagnostics,
  })}`)
})

test("preserves the wait failure if both diagnostic collection and cleanup fail", async () => {
  const timeout = new Error("stable wait timed out")
  const page = {
    evaluate: async (_callback: unknown, argument?: { href?: string }) => {
      if (argument?.href) return
      throw new Error(argument ? "diagnostic collection failed" : "cleanup failed")
    },
    waitForFunction: async () => { throw timeout },
  } as unknown as Page

  await expect(measureSessionSwitch(page, input(async () => {}))).rejects.toBe(timeout)
})

test("does not hide a cleanup failure after an otherwise successful measurement", async () => {
  const cleanupFailure = new Error("cleanup failed")
  let collections = 0
  const page = {
    evaluate: async (_callback: unknown, argument?: unknown) => {
      if (argument) return
      if (collections++ > 0) throw cleanupFailure
      return [16, 32, 48].map((observedAtMs) => ({
        observedAtMs,
        destination: ["destination"],
        source: [],
        hasVisibleRows: true,
        last: true,
        bottomErrorPx: 0,
      }))
    },
    waitForFunction: async () => {},
  } as unknown as Page

  await expect(measureSessionSwitch(page, input(async () => {}))).rejects.toBe(cleanupFailure)
})
