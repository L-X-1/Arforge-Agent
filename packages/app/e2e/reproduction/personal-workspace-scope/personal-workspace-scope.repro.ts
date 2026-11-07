import { expect, test } from "@playwright/test"
import { resolve } from "node:path"
import { writeFileSync } from "node:fs"

test("approved A uses real compact rows and inspector without overflow at narrow and wide widths", async ({ page }) => {
  const auditRoot = resolve(import.meta.dirname, "../../../../../docs/ui-redesign/interaction-audit-v3-20261029")
  const geometry = []
  for (const locale of ["en", "zh"]) for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`/?sourceMoved=1&locale=${locale}`)
    await page.waitForFunction(() => (globalThis as any).__personalWorkspaceScopeFixture?.calls.includes("workspace-a"))
    await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.resolve("workspace-a"))
    const history = page.getByTestId("personal-workspace-run-history")
    await expect(history.getByTestId("personal-workspace-run-row")).toHaveCount(4)
    await expect(history.getByTestId("personal-workspace-open-source")).toHaveCount(1)
    const badges = history.getByTestId("personal-workspace-run-source-badge")
    await expect(badges).toHaveCount(3)
    await expect(badges).toHaveText(locale === "zh"
      ? ["当前来源", "绑定缺失·只读", "来源已变更·只读"]
      : ["Current source", "Binding missing · read-only", "Source moved · read-only"])
    const badgeMetrics = await badges.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      const row = element.closest('[data-testid="personal-workspace-run-row"]')!.getBoundingClientRect()
      return { text: element.textContent, width: box.width, height: box.height, rowHeight: row.height,
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        row: { left: row.left, right: row.right, top: row.top, bottom: row.bottom },
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        contained: box.left >= row.left && box.right <= row.right && box.top >= row.top && box.bottom <= row.bottom,
        fits: element.scrollWidth <= element.clientWidth, flexShrink: getComputedStyle(element).flexShrink }
    }))
    for (const badge of badgeMetrics) {
      expect(badge.width).toBeGreaterThan(0)
      expect(badge.height).toBeGreaterThan(0)
      expect(badge.contained).toBe(true)
      expect(badge.fits).toBe(true)
      expect(badge.flexShrink).toBe("0")
      if (width === 1280) expect(badge.rowHeight).toBe(64)
    }
    await page.evaluate(() => document.fonts.ready)
    const localeSuffix = locale === "zh" ? "-zh" : ""
    await history.screenshot({ path: resolve(auditRoot, `personal-workspace-source-A-rows${localeSuffix}-${width}.png`) })
    await history.getByTestId("personal-workspace-run-row").filter({ hasText: "run_foreign_workspace-a" })
      .getByTestId("personal-workspace-run-select").click()
    await expect(history.getByTestId("personal-workspace-run-inspector")).toBeVisible()
    const metrics = await history.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
      inspectorWidth: element.querySelector('.arforge-management-detail')!.getBoundingClientRect().width,
      rowHeights: Array.from(element.querySelectorAll('.arforge-management-entity-row'), row => row.getBoundingClientRect().height) }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width)
    if (width === 1280) { expect(metrics.inspectorWidth).toBe(440); expect(metrics.rowHeights).toEqual([64, 64, 64, 64]) }
    geometry.push({ locale, width, badges: badgeMetrics, metrics, bodyFont: await page.evaluate(() => getComputedStyle(document.body).fontFamily) })
    await history.screenshot({ path: resolve(auditRoot, `personal-workspace-source-A-inspector${localeSuffix}-${width}.png`) })
    expect(await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.sourceJumps)).toEqual([])
  }
  writeFileSync(resolve(auditRoot, "personal-workspace-source-badge-geometry.json"), JSON.stringify({
    status: "passed", checkedAt: new Date().toISOString(), scope: "Isolated actual production component; not product acceptance", geometry,
  }, null, 2) + "\n")
})

test("retains every historical row but reads only exact current parent sources until explicit navigation", async ({ page }) => {
  await page.goto("/")
  await page.waitForFunction(() => (globalThis as any).__personalWorkspaceScopeFixture?.calls.includes("workspace-a"))
  await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.resolve("workspace-a"))
  const workspace = page.getByTestId("control-center-personal-workspace")
  await expect.poll(() => page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.historyReads)).toEqual(["run_history_workspace-a"])
  await expect(workspace.getByTestId("personal-workspace-run-row")).toHaveCount(3)
  const foreign = workspace.getByTestId("personal-workspace-run-row").filter({ hasText: "run_foreign_workspace-a" })
  await foreign.getByTestId("personal-workspace-run-select").click()
  await expect(workspace.getByTestId("personal-workspace-run-inspector")).toContainText("D:/Arforge/PersonalWorkspaceHistoryFixture")
  expect(await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.sourceJumps)).toEqual([])
  expect(await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.historyReads)).toEqual(["run_history_workspace-a"])
  await workspace.locator('.arforge-management-detail-heading').click()
  const legacy = workspace.getByTestId("personal-workspace-run-row").filter({ hasText: "run_legacy_workspace-a" })
  await legacy.getByTestId("personal-workspace-run-select").click()
  await expect(workspace.getByTestId("personal-workspace-run-inspector")).toContainText("binding")
  await expect(legacy.getByTestId("personal-workspace-open-source")).toHaveCount(0)
  await workspace.locator('.arforge-management-detail-heading').click()
  await foreign.getByTestId("personal-workspace-open-source").click()
  await expect.poll(() => page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.sourceJumps)).toEqual(["D:/Arforge/PersonalWorkspaceHistoryFixture"])
  await page.waitForFunction(() => (globalThis as any).__personalWorkspaceScopeFixture.calls.includes("workspace-b"))
  await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.resolve("workspace-b"))
  await expect(workspace.getByTestId("personal-workspace-run-row")).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.historyReads)).toEqual(["run_history_workspace-a", "run_history_workspace-b"])
})

test("discovers ended parents and refreshes child metadata without a control request", async ({ page }) => {
  await page.goto("/")
  await page.waitForFunction(() => (globalThis as any).__personalWorkspaceScopeFixture?.calls.includes("workspace-a"))
  await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.resolve("workspace-a"))
  const workspace = page.getByTestId("control-center-personal-workspace")
  const child = workspace.getByTestId("personal-workspace-child-card")
  await expect(child).toContainText("Read-only for now")
  await expect(child.getByTestId("personal-workspace-child-receipt")).toContainText("result unconfirmed")
  await expect(child.getByTestId("personal-workspace-child-control-toggle")).toHaveCount(0)
  await child.getByTestId("personal-workspace-child-refresh").click()
  await page.waitForFunction(() => (globalThis as any).__personalWorkspaceScopeFixture.calls.length === 2)
  await page.evaluate(() => (globalThis as any).__personalWorkspaceScopeFixture.resolve("workspace-a"))
  await expect(workspace.getByTestId("personal-workspace-child-receipt")).toContainText("Result recorded")
  await expect(workspace.getByTestId("personal-workspace-child-control-toggle")).toHaveCount(0)
})

for (const width of [375, 1280])
  test(`receipt gap stays understandable and read-only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    const fixture = page.getByTestId("receipt-fixture")
    const receipt = fixture.getByTestId("personal-workspace-child-receipt")
    await expect(receipt).toContainText("执行已结束，结果尚未确认")
    await expect(receipt).toContainText("不要为获取结果而重复执行任务")
    await expect(receipt).toHaveAttribute("role", "status")
    await expect(receipt).toHaveAttribute("aria-live", "polite")
    await expect(fixture.getByTestId("receipt-waits")).toHaveText("0")
    await fixture.getByRole("button", { name: "打开会话", exact: true }).click()
    await expect(fixture.getByTestId("receipt-opened")).toHaveText("ses_receipt_fixture")
    await fixture.getByTestId("personal-workspace-child-control-toggle").click()
    await expect(fixture.getByTestId("personal-workspace-child-send")).toHaveCount(0)
    await expect(fixture.getByTestId("personal-workspace-child-cancel")).toHaveCount(0)
    const wait = fixture.getByTestId("personal-workspace-child-terminal-wait")
    await wait.focus()
    await page.keyboard.press("Enter")
    await expect(fixture.getByTestId("receipt-waits")).toHaveText("1")
    await expect(receipt).toContainText("结果已记录")
    await expect(receipt).toContainText("不代表交付验收通过")
    await fixture.getByTestId("receipt-legacy").click()
    await expect(receipt).toContainText("结果状态未知")
    await expect(fixture.getByTestId("personal-workspace-child-control-toggle")).toHaveCount(0)
    await expect(fixture.getByTestId("personal-workspace-child-terminal-wait")).toHaveCount(0)
    await expect(fixture).toContainText("当前仅供查看")
    const box = await receipt.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    expect(await receipt.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  })

test("drops a late Personal Workspace snapshot from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")
  await page.waitForTimeout(250)
  if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"))

  const workbench = page.getByTestId("control-center-personal-workspace")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __personalWorkspaceScopeFixture?: { calls: string[] } })
      .__personalWorkspaceScopeFixture
    return fixture?.calls.includes("workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("personal-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __personalWorkspaceScopeFixture?: { calls: string[] } })
      .__personalWorkspaceScopeFixture
    return fixture?.calls.includes("workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (
      globalThis as typeof globalThis & {
        __personalWorkspaceScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
      }
    ).__personalWorkspaceScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("workspace-a session")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (
      globalThis as typeof globalThis & {
        __personalWorkspaceScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
      }
    ).__personalWorkspaceScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("workspace-b session")
  await expect(workbench).not.toContainText("workspace-a session")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
