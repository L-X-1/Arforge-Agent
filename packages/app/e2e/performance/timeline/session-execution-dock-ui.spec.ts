import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("opens and collapses the model-selected execution mascot without replacing the timeline", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("arforge.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await setupTimelineBenchmark(page, { historyTurns: 2, eventBatch: 1, newLayoutDesigns: true })

  const dock = page.locator("#execution-trace-panel")
  const stage = dock.locator(".execution-mascot")
  const toggle = page.locator('[data-component="execution-status-bar"]')
  await expect(dock).toHaveCount(0)
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(dock).toBeVisible()
  await expect(stage).toHaveAttribute("data-form", "3")
  await expect(stage).toHaveAttribute("aria-label", /当前形态 3: 修改文件/)
  await expect(stage.locator('.execution-dragon-puppet[data-form="3"]')).toBeVisible()
  await expect(stage.locator(".execution-dragon-rig")).toHaveAttribute("data-rig-version", "1")
  await expect(stage.locator(".execution-mascot__forms > div")).toHaveCount(3)
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
  await expect(stage).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect
    .poll(() => stage.locator(".execution-mascot__figure").evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none")
})
