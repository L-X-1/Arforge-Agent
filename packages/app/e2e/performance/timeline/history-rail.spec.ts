import { test, expect } from "@playwright/test"
import { setupTimelineBenchmark, buildInitialStreamEvent, buildStreamDeltaEvents } from "./session-timeline-benchmark.fixture"

test("history rail previews and jumps to a user prompt in the same session", async ({ page }) => {
  const start = performance.now()
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 12, eventBatch: 1, newLayoutDesigns: true })
  const rail = page.locator('[data-component="session-history-rail"]')
  await expect(rail).toBeVisible()
  await expect(rail.locator("[data-history-message-id]")).toHaveCount(13)
  const first = rail.locator("[data-history-message-id]").first()
  const id = await first.getAttribute("data-history-message-id")
  await first.hover()
  await expect(page.getByRole("tooltip")).toBeVisible()
  await expect(page.getByRole("tooltip")).not.toBeEmpty()
  const route = new URL(page.url()).pathname
  await first.click()
  await expect.poll(() => new URL(page.url()).hash).toBe("#message-" + id)
  await expect(page.locator('[id="message-' + id + '"]')).toBeInViewport()
  expect(new URL(page.url()).pathname).toBe(route)
  await expect(first).toHaveAttribute("aria-current", "location")
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  const top = await fixture.scroller.evaluate((element) => element.scrollTop)
  fixture.transport.enqueue(buildInitialStreamEvent(8))
  fixture.transport.enqueue(buildStreamDeltaEvents(8))
  await expect.poll(() => fixture.transport.pendingCount()).toBe(0)
  const after = await fixture.scroller.evaluate((element) => element.scrollTop)
  expect(Math.abs(after - top)).toBeLessThan(32)
  await page.screenshot({ path: test.info().outputPath("history-rail.png") })
  console.log("HISTORY_RAIL " + JSON.stringify({
    elapsedMs: performance.now() - start, markers: 13, scrollDrift: after - top, sessionRoute: route,
  }))
})

test("history rail pages and supports keyboard navigation across virtualized turns", async ({ page }) => {
  await setupTimelineBenchmark(page, { historyTurns: 80, eventBatch: 1, newLayoutDesigns: true })
  const rail = page.locator('[data-component="session-history-rail"]')
  await expect(rail).toBeVisible()
  await expect(rail.locator("[data-history-message-id]")).toHaveCount(28)
  const current = rail.locator('[data-history-message-id][tabindex="0"]')
  await current.focus()
  await current.press("Home")
  const oldest = rail.locator("[data-history-message-id]").first()
  await expect(oldest).toBeFocused()
  await oldest.press("Enter")
  const id = await oldest.getAttribute("data-history-message-id")
  await expect(page.locator('[id="message-' + id + '"]')).toBeInViewport()
  await oldest.press("End")
  const latest = rail.locator("[data-history-message-id]").last()
  await expect(latest).toBeFocused()
  await latest.press("Enter")
  await expect.poll(() => new URL(page.url()).hash).toBe("#message-msg_user_regression")
})

test("history rail renders in the original layout", async ({ page }) => {
  await setupTimelineBenchmark(page, { historyTurns: 3, eventBatch: 1, newLayoutDesigns: false })
  await expect(page.locator('[data-component="session-history-rail"]')).toBeVisible()
  await expect(page.locator("[data-history-message-id]")).toHaveCount(4)
})
