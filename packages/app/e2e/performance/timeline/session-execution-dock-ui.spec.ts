import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("shows the three-form execution mascot without replacing the timeline", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("arforge.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await setupTimelineBenchmark(page, { historyTurns: 2, eventBatch: 1, newLayoutDesigns: true })

  const dock = page.locator("#execution-trace-panel")
  const stage = dock.locator(".execution-mascot")
  await expect(dock).toBeVisible()
  await expect(stage).toHaveAttribute("data-form", "2")
  await expect(stage).toHaveAttribute("aria-label", /当前形态 2: 修改文件/)
  await expect(stage.locator("img")).toHaveAttribute("src", /arforge-form-2\.webp$/)
  await expect(page.getByRole("heading", { name: "Timeline collapse state regression" })).toBeVisible()
  await expect(dock.locator(".execution-step__title", { hasText: "修改文件" })).toBeVisible()

  const openWidth = await dock.evaluate((element) => element.getBoundingClientRect().width)
  expect(openWidth).toBeGreaterThanOrEqual(300)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("execution-dock.png") })

  await dock.getByRole("button", { name: "收起可视化执行" }).click()
  await expect(dock.getByRole("button", { name: "展开可视化执行" })).toBeVisible()
  await expect.poll(() => dock.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(45)

  await page.setViewportSize({ width: 900, height: 700 })
  await dock.getByRole("button", { name: "展开可视化执行" }).click()
  await expect(stage).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect
    .poll(() => stage.locator(".execution-mascot__figure").evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none")
})
