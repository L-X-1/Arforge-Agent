import { expect, test, type Locator, type Page } from "@playwright/test"

/** Format regressions need both panes; enter the approved full mode through its real control. */
export async function expandWorkbench(page: Page) {
  const panel = page.locator("#review-panel")
  if ((await panel.getAttribute("data-workbench-mode")) !== "full")
    await panel.getByRole("button", { name: "Full workbench", exact: true }).click()
  await expect(panel).toHaveAttribute("data-workbench-mode", "full")
}

/** Bound real wheel input while retaining exact end-position and last-file assertions in callers. */
export async function scrollReviewToEnd(page: Page, viewport: Locator) {
  const geometry = () =>
    viewport.evaluate((element) => ({
      top: element.scrollTop,
      height: element.scrollHeight,
      client: element.clientHeight,
      remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
    }))
  const samples: Awaited<ReturnType<typeof geometry>>[] = []
  await viewport.hover()
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = await geometry()
      samples.push(before)
      if (before.remaining <= 1) return
      await page.mouse.wheel(0, 100000)
      await expect
        .poll(
          async () => {
            const after = await geometry()
            return after.top > before.top || after.remaining <= 1
          },
          { timeout: 2500 },
        )
        .toBe(true)
      samples.push(await geometry())
    }
  } finally {
    await test
      .info()
      .attach("review-wheel-geometry", { body: JSON.stringify(samples), contentType: "application/json" })
  }
}
