import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("keeps execution status, current steps and history without replacing the timeline", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("arforge.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await setupTimelineBenchmark(page, { historyTurns: 2, eventBatch: 1, newLayoutDesigns: true })

  const dock = page.locator("#execution-trace-panel")
  const activity = dock.locator(".execution-dock__activity")
  const toggle = page.locator('[data-component="execution-status-bar"]')
  await expect(dock).toHaveCount(0)
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(dock).toBeVisible()
  await expect(activity).toContainText("修改文件")
  await expect(activity).toContainText("真实子 Agent")
  await expect(dock.locator('[id="execution-current-view"]')).toBeVisible()
  await expect(dock.getByRole("tab", { name: "历史记录", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Timeline collapse state regression" })).toBeVisible()
  await expect(dock.locator(".execution-step__title", { hasText: "修改文件" })).toBeVisible()

  const openWidth = await dock.evaluate((element) => element.getBoundingClientRect().width)
  expect(openWidth).toBeGreaterThanOrEqual(300)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("execution-dock.png") })

  await dock.getByRole("button", { name: "收起可视化执行" }).click()
  await expect(dock).toHaveCount(0)
  await expect(toggle).toBeVisible()

  await page.setViewportSize({ width: 900, height: 700 })
  await toggle.click()
  await expect(activity).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect
    .poll(() => dock.locator(".execution-step").first().evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none")
})
