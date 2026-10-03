import { expect, test } from "@playwright/test"

test.describe("runtime insight recovery interaction", () => {
  test("loads the recovery workbench across every supported locale", async ({ page }) => {
    test.setTimeout(120_000)
    const locales = [
      "en",
      "zh",
      "zht",
      "ko",
      "de",
      "es",
      "fr",
      "da",
      "ja",
      "pl",
      "ru",
      "uk",
      "ar",
      "no",
      "br",
      "th",
      "bs",
      "tr",
    ] as const
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))

    for (const locale of locales) {
      await page.goto(`/?locale=${locale}`)
      await expect(page.locator("html")).toHaveAttribute("lang", locale)
      await expect(page.getByTestId("runtime-insight-workbench")).toBeVisible()
      await expect(page.getByTestId("runtime-insight-access")).toBeVisible()
      await expect(page.getByTestId("runtime-insight-workbench")).not.toContainText("Cannot read properties")
    }

    expect(pageErrors).toEqual([])
  })

  test("renders payload-free custom-agent admission evidence in the durable run card", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zh")

    const card = page.getByTestId("custom-agent-admission-runtime-card")
    await expect(card).toBeVisible()
    await expect(card).toContainText("Custom Agent 准入证据")
    await expect(card).toContainText("已准入")
    await expect(card).toContainText("允许启动")
    await expect(card).toContainText("检查 4/4 项通过")
    await expect(card).toContainText("Evidence 引用 1 条")
    await expect(card).not.toContainText("profile_path")
    await expect(card).not.toContainText("system_prompt")
    await expect(card).not.toContainText("credentials")
    expect(pageErrors).toEqual([])
  })

  test("refreshes and clears scoped recovery details when the workspace changes", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    await expect
      .poll(() => page.evaluate(() => window.runtimeInsightFixture.locationCalls.length))
      .toBeGreaterThan(0)
    await expect
      .poll(() => page.evaluate(() => window.runtimeInsightFixture.locationCalls.at(-1)?.workspace))
      .toBe("workspace-one")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_fixture"]')
    await action.getByRole("button", { name: "Inspect current target state: write" }).click()
    await expect(action.getByTestId("durable-action-inspection")).toBeVisible()

    await page.evaluate(() => window.runtimeInsightFixture.setWorkspace("workspace-two"))
    await expect
      .poll(() => page.evaluate(() => window.runtimeInsightFixture.locationCalls.at(-1)?.workspace))
      .toBe("workspace-two")
    await expect(action.getByTestId("durable-action-inspection")).toHaveCount(0)
    await expect(page.getByTestId("runtime-insight-workbench")).toHaveAttribute("aria-busy", "false")
    expect(pageErrors).toEqual([])
  })

  test("drops a late recovery inspection from the previous workspace", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_fixture"]')
    await expect(action.getByRole("button", { name: "Inspect current target state: write" })).toBeVisible()
    await page.evaluate(() => {
      window.runtimeInsightFixture.deferRecovery = true
    })
    await action.getByRole("button", { name: "Inspect current target state: write" }).click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.recoveryPending)).toBe(true)

    await page.evaluate(() => window.runtimeInsightFixture.setWorkspace("workspace-two"))
    await expect
      .poll(() => page.evaluate(() => window.runtimeInsightFixture.locationCalls.at(-1)?.workspace))
      .toBe("workspace-two")
    await expect(page.getByTestId("runtime-insight-workbench")).toHaveAttribute("aria-busy", "false")
    await expect(action.getByTestId("durable-action-inspection")).toHaveCount(0)

    await page.evaluate(() => {
      window.runtimeInsightFixture.deferRecovery = false
      window.runtimeInsightFixture.resolveRecovery?.()
    })
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.recoveryCalls.length)).toBe(1)
    await expect(action.getByTestId("durable-action-inspection")).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("renders recovery guidance in the selected traditional-Chinese locale", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zht")

    await expect(page.locator("html")).toHaveAttribute("lang", "zht")
    const workbench = page.getByTestId("runtime-insight-workbench")
    await expect(workbench).toContainText("重新整理")
    await expect(workbench).toContainText("真實動作與影響")
    await expect(workbench).toContainText("自動重試已阻止")
    await expect(workbench).toContainText("資產本地化進度")
    await expect(workbench).not.toContainText("Cannot read properties")
    await expect(workbench).not.toContainText("Automatic retry is blocked")
    expect(pageErrors).toEqual([])
  })

  test("keeps traditional-Chinese cancellation and recovery evidence understandable", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zht")

    const pending = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_pending_asset"]',
    )
    await expect(pending).toContainText("等待你確認")
    await expect(pending).toContainText("僅原始會話")
    await expect(pending).not.toContainText("Only the originating session")
    await expect(pending).not.toContainText("precise asset localization request")

    await pending.getByTestId("durable-action-cancel-button").click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.interrupts.length)).toBe(1)
    await expect(pending).toContainText("已取消")

    const recovery = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_fixture"]',
    )
    await expect(recovery).toContainText("持久檔案變更在後處理期間中斷")
    await expect(recovery).toContainText("自動重試已阻止")
    await expect(recovery).not.toContainText("A durable file mutation was interrupted")
    await recovery.getByRole("button", { name: "檢查目前目標狀態: write" }).click()
    const inspection = recovery.locator('[data-testid="durable-action-inspection"]')
    await expect(inspection).toContainText("目前狀態符合已寫結果")
    await expect(inspection).not.toContainText("All cooperative fingerprints")
    expect(pageErrors).toEqual([])
  })

  test("keeps simplified-Chinese cancellation and recovery evidence understandable", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zh")

    const pending = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_pending_asset"]',
    )
    await expect(pending).toContainText("等待你确认")
    await expect(pending).toContainText("仅原始会话")
    await expect(pending).not.toContainText("Only the originating session")
    await pending.getByTestId("durable-action-cancel-button").click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.interrupts.length)).toBe(1)
    await expect(pending).toContainText("已取消")

    const recovery = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_fixture"]',
    )
    await expect(recovery).toContainText("持久文件变更在后处理期间中断")
    await expect(recovery).toContainText("自动重试已阻止")
    await expect(recovery).not.toContainText("A durable file mutation was interrupted")
    await recovery.getByRole("button", { name: "检查当前目标状态: write" }).click()
    await expect(recovery.locator('[data-testid="durable-action-inspection"]')).toContainText(
      "当前状态匹配已写结果",
    )
    await expect(recovery.locator('[data-testid="durable-action-inspection"]')).not.toContainText(
      "All cooperative fingerprints",
    )
    expect(pageErrors).toEqual([])
  })

  test("keeps simplified-Chinese role boundaries understandable", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zh")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_asset"]')
    await action.getByRole("button", { name: "检查当前目标状态: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toContainText(
      "当前账号可以检查并记录证据；受保护回滚和工件维护需要 owner/admin。",
    )
    await expect(action.getByTestId("durable-action-rollback")).toHaveCount(0)

    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "owner"
    })
    await page.getByTestId("runtime-insight-workbench").getByRole("button", { name: "刷新" }).first().click()
    await action.getByRole("button", { name: "检查当前目标状态: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-rollback")).toBeVisible()
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toHaveCount(0)
    await expect(page.getByTestId("runtime-insight-access")).toContainText("当前角色：所有者")
    await expect(page.getByTestId("runtime-insight-access")).toContainText("可执行受保护回滚")
    expect(pageErrors).toEqual([])
  })

  test("keeps traditional-Chinese role boundaries understandable", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zht")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_asset"]')
    await action.getByRole("button", { name: "檢查目前目標狀態: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toContainText(
      "目前帳號可以檢查並記錄證據；受保護回滾和工件維護需要 owner/admin。",
    )
    await expect(action.getByTestId("durable-action-rollback")).toHaveCount(0)

    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "admin"
    })
    await page.getByTestId("runtime-insight-workbench").getByRole("button", { name: "重新整理" }).first().click()
    await action.getByRole("button", { name: "檢查目前目標狀態: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-rollback")).toBeVisible()
    await expect(page.getByTestId("runtime-insight-access")).toContainText("目前角色：管理員")
    await expect(page.getByTestId("runtime-insight-access")).toContainText("可執行受保護回滾")
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("lets the originating session cancel an asset action before execution handoff", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const pending = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_pending_asset"]',
    )
    const foreignPending = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_foreign_pending_asset"]',
    )
    await expect(pending).toBeVisible()
    await expect(pending).toContainText("Awaiting your approval")
    await expect(pending.getByTestId("durable-action-cancel-button")).toBeVisible()
    await expect(pending).toContainText("Only the originating session can cancel before execution handoff")
    await expect(foreignPending).toBeVisible()
    await expect(foreignPending).toContainText("Awaiting your approval")
    await expect(foreignPending.getByTestId("durable-action-cancel-button")).toHaveCount(0)

    await pending.getByTestId("durable-action-cancel-button").click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.interrupts.length)).toBe(1)
    await expect(pending).toContainText("Cancelled")
    await expect(pending.getByTestId("durable-action-cancel-button")).toHaveCount(0)
    await expect(pending.getByTestId("durable-action-progress")).toContainText("Cancelled")
    expect(pageErrors).toEqual([])
  })

  test("lets a user inspect evidence and record a non-mutating settlement decision", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const workbench = page.getByTestId("runtime-insight-workbench")
    await expect(workbench).toHaveAttribute("aria-busy", "false")
    await expect(workbench).toContainText("Automatic retry is blocked")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_fixture"]')
    const secondAction = page.locator(
      '[data-testid="durable-action-record"][data-action-id="act_runtime_insight_second"]',
    )
    const inspect = action.getByRole("button", { name: "Inspect current target state: write" })
    const secondInspect = secondAction.getByRole("button", { name: "Inspect current target state: edit" })
    await expect(inspect).toBeVisible()
    await expect(secondInspect).toBeVisible()
    await inspect.click()
    await secondInspect.click()

    const inspection = action.locator('[data-testid="durable-action-inspection"]')
    await expect(inspection).toContainText("Post-restart target observation")
    await expect(inspection).toContainText("Postimage matches")
    await expect(inspection).toContainText("workspace/fixture.txt")
    await expect(secondAction.locator('[data-testid="durable-action-inspection"]')).toContainText(
      "workspace/second.txt",
    )

    const settle = action.getByRole("button", { name: "Confirm result is written: write" })
    await expect(settle).toBeVisible()
    await expect(action.getByTestId("durable-action-review-controls")).toContainText(
      "These buttons record your evidence-bound decision only",
    )
    await settle.click()

    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.reviews.length)).toBe(1)
    const review = await page.evaluate(() => window.runtimeInsightFixture.reviews[0])
    expect(review).toMatchObject({
      actionID: "act_runtime_insight_fixture",
      transactionID: "mut_runtime_insight_fixture",
      expectedPhase: "postprocessing",
      observationDigest: "a".repeat(64),
      decision: "settle_postimage",
      inspectedDecision: "postimage_matches",
    })

    await expect(action).toContainText("Mutation settled")
    await expect(action.getByTestId("durable-action-inspect-targets")).toHaveCount(0)
    await expect(secondAction).toContainText("Automatic retry is blocked")
    await expect(secondAction.getByRole("button", { name: "Confirm result is written: edit" })).toBeVisible()
    await secondAction.getByRole("button", { name: "Confirm result is written: edit" }).click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.reviews.length)).toBe(2)
    await expect(secondAction).toContainText("Mutation settled")
    await expect(secondAction.getByTestId("durable-action-inspect-targets")).toHaveCount(0)
    const reviews = await page.evaluate(() => window.runtimeInsightFixture.reviews)
    expect(reviews[1]).toMatchObject({
      actionID: "act_runtime_insight_second",
      transactionID: "mut_runtime_insight_second",
      expectedPhase: "postprocessing",
      observationDigest: "b".repeat(64),
      decision: "settle_postimage",
      inspectedDecision: "postimage_matches",
    })
    await expect(page.evaluate(() => window.runtimeInsightFixture.inspections)).resolves.toEqual([
      "act_runtime_insight_fixture",
      "act_runtime_insight_second",
    ])
    expect(pageErrors).toEqual([])
  })

  test("shows members the asset recovery boundary and exposes guarded rollback after an owner switch", async ({
    page,
  }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_asset"]')
    await expect(action).toBeVisible()
    const progress = action.getByTestId("durable-action-progress")
    await expect(progress).toBeVisible()
    await expect(progress).toContainText("Asset localization progress")
    await expect(progress).toContainText("Files committed")
    await expect(progress).toContainText("Completed 2/2")
    await expect(progress).toContainText("read-only durable progress view")
    await action.getByRole("button", { name: "Inspect current target state: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-inspection")).toContainText("Postimage matches")
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toContainText(
      "guarded rollback and artifact maintenance require an owner/admin",
    )
    await expect(action.getByTestId("durable-action-rollback")).toHaveCount(0)

    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "owner"
    })
    await page.getByTestId("runtime-insight-workbench").getByRole("button", { name: "Refresh" }).first().click()
    await action.getByRole("button", { name: "Inspect current target state: asset-localization" }).click()
    await expect(action.getByTestId("durable-action-rollback")).toBeVisible()
    await expect(page.getByTestId("runtime-insight-access")).toContainText("guarded rollback available")
    expect(pageErrors).toEqual([])
  })

  test("exposes the same guarded asset rollback to an administrator", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const action = page.locator('[data-testid="durable-action-record"][data-action-id="act_runtime_insight_asset"]')
    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "admin"
    })
    await page.getByTestId("runtime-insight-workbench").getByRole("button", { name: "Refresh" }).first().click()
    await action.getByRole("button", { name: "Inspect current target state: asset-localization" }).click()

    await expect(action.getByTestId("durable-action-rollback")).toBeVisible()
    await expect(page.getByTestId("runtime-insight-access")).toContainText("guarded rollback available")
    await expect(action.getByTestId("durable-action-recovery-role-notice")).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("lets members inspect MCP state while keeping evidence recording owner/admin-only", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const workbench = page.getByTestId("runtime-insight-workbench")
    const action = page.locator('[data-testid="mcp-action-reconciliation"][data-action-id="act_mcp_runtime_fixture"]')
    await expect(action).toBeVisible()
    await expect(action).toContainText("Not checked")
    await expect(action).toContainText("Members can inspect")

    await action.getByTestId("mcp-action-reconciliation-inspect").click()
    const result = action.locator('[data-testid="mcp-action-reconciliation-result"]')
    await expect(result).toContainText("Manual review required")
    await expect(result).toContainText("No transport replay was attempted")
    await expect(result).toContainText("Evidence ddddd")

    await action.getByTestId("mcp-action-reconciliation-record").click()
    await expect(workbench).toContainText("This account can inspect only")
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.mcpRecords.length)).toBe(0)

    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "owner"
    })
    await action.getByTestId("mcp-action-reconciliation-record").click()
    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.mcpRecords.length)).toBe(1)
    await expect(action).toContainText("Read-only check confirmed")
    await expect(action).toContainText("Known success")
    await expect(page.evaluate(() => window.runtimeInsightFixture.mcpInspections)).resolves.toEqual([
      "act_mcp_runtime_fixture",
    ])
    const record = await page.evaluate(() => window.runtimeInsightFixture.mcpRecords[0])
    expect(record).toMatchObject({
      actionID: "act_mcp_runtime_fixture",
      intentDigest: "c".repeat(64),
      idempotencyKey: "mcp-idem-runtime-fixture",
      expectedEvidenceDigest: "d".repeat(64),
      approval: "record_evidence",
    })
    expect(pageErrors).toEqual([])
  })

  test("lets an admin record MCP evidence without exposing provider failures", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const action = page.locator('[data-testid="mcp-action-reconciliation"][data-action-id="act_mcp_runtime_fixture"]')
    await action.getByTestId("mcp-action-reconciliation-inspect").click()
    await page.evaluate(() => {
      window.runtimeInsightFixture.role = "admin"
    })
    await action.getByTestId("mcp-action-reconciliation-record").click()

    await expect.poll(() => page.evaluate(() => window.runtimeInsightFixture.mcpRecords.length)).toBe(1)
    await expect(action).toContainText("Read-only check confirmed")
    await expect(action).toContainText("Known success")
    await expect(action.getByTestId("mcp-action-reconciliation-record")).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test("shows a safe retry message when MCP inspection is temporarily unavailable", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/")

    const action = page.locator('[data-testid="mcp-action-reconciliation"][data-action-id="act_mcp_runtime_fixture"]')
    await page.evaluate(() => {
      window.runtimeInsightFixture.mcpFailureMode = true
    })
    await action.getByTestId("mcp-action-reconciliation-inspect").click()

    const error = page.getByTestId("runtime-insight-error")
    await expect(error).toContainText("MCP outcome could not be checked right now")
    await expect(error).not.toContainText("secret=fixture-only")

    await page.evaluate(() => {
      window.runtimeInsightFixture.mcpFailureMode = false
    })
    await action.getByTestId("mcp-action-reconciliation-inspect").click()
    await expect(action.getByTestId("mcp-action-reconciliation-result")).toContainText("Manual review required")
    expect(pageErrors).toEqual([])
  })

  test("keeps the MCP failure-to-recovery path understandable in traditional Chinese", async ({ page }) => {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
    await page.goto("/?locale=zht")

    await expect(page.locator("html")).toHaveAttribute("lang", "zht")
    const action = page.locator('[data-testid="mcp-action-reconciliation"][data-action-id="act_mcp_runtime_fixture"]')
    await expect(action.getByTestId("mcp-action-reconciliation-inspect")).toContainText("唯讀核對")

    await page.evaluate(() => {
      window.runtimeInsightFixture.mcpFailureMode = true
    })
    await action.getByTestId("mcp-action-reconciliation-inspect").click()

    const error = page.getByTestId("runtime-insight-error")
    await expect(error).toContainText("暫時無法核對 MCP 結果")
    await expect(error).toContainText("未執行重放")
    await expect(error).not.toContainText("secret=fixture-only")

    await page.evaluate(() => {
      window.runtimeInsightFixture.mcpFailureMode = false
    })
    await action.getByTestId("mcp-action-reconciliation-inspect").click()
    await expect(action.getByTestId("mcp-action-reconciliation-result")).toContainText("需要人工核對")
    await expect(action.getByTestId("mcp-action-reconciliation-result")).toContainText("未執行傳輸重放")
    expect(pageErrors).toEqual([])
  })
})
