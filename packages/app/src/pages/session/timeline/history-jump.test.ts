import { afterEach, expect, test } from "bun:test"
import { waitForHistoryTarget } from "./history-jump"

afterEach(() => { document.body.replaceChildren() })

test("a changed scope never confirms an old history target", async () => {
  expect(await waitForHistoryTarget(() => null, () => undefined, () => false, 0)).toBe(false)
})

test("a missing virtualized target is a failed jump, not a successful route change", async () => {
  expect(await waitForHistoryTarget(() => null, () => undefined, () => true, 0)).toBe(false)
})

test("confirms only a mounted message intersecting the conversation viewport", async () => {
  const viewport = document.createElement("div")
  const target = document.createElement("div")
  document.body.append(viewport)
  viewport.append(target)
  viewport.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect
  target.getBoundingClientRect = () => ({ top: 150, bottom: 250, height: 100 }) as DOMRect
  expect(await waitForHistoryTarget(() => target, () => viewport, () => true, 0)).toBe(true)
  target.getBoundingClientRect = () => ({ top: 350, bottom: 450, height: 100 }) as DOMRect
  expect(await waitForHistoryTarget(() => target, () => viewport, () => true, 0)).toBe(false)
})
