import { expect, test } from "@playwright/test"

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
