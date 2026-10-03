import { expect, test, type Page } from "@playwright/test"

type FixtureRole = "owner" | "admin"

const resolveWorkspace = async (page: Page, workspace: "workspace-a" | "workspace-b" = "workspace-a") => {
  await page.evaluate((current) => {
    const fixture = (globalThis as typeof globalThis & {
      __tenantPlatformScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__tenantPlatformScopeFixture
    fixture.resolve(current as "workspace-a" | "workspace-b")
  }, workspace)
}

const waitForInitialOverview = async (page: Page) => {
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __tenantPlatformScopeFixture?: { calls: string[] } })
      .__tenantPlatformScopeFixture
    return fixture?.calls.includes("overview:workspace-a")
  })
  await resolveWorkspace(page)
  const workbench = page.getByTestId("tenant-platform-workbench")
  await expect(workbench).toContainText("ten_fixture_a")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
}

test("drops a late Tenant Platform response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("tenant-platform-workbench")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __tenantPlatformScopeFixture?: { calls: string[] } })
      .__tenantPlatformScopeFixture
    return fixture?.calls.includes("overview:workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("tenant-platform-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __tenantPlatformScopeFixture?: { calls: string[] } })
      .__tenantPlatformScopeFixture
    return fixture?.calls.includes("overview:workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __tenantPlatformScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__tenantPlatformScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("ten_fixture_a")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __tenantPlatformScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__tenantPlatformScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("ten_fixture_b")
  await expect(workbench).not.toContainText("ten_fixture_a")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})

for (const [locale, expectedError, refreshLabel] of [
  ["zh", "此租户操作需要 Owner 或 Admin 权限。", "刷新"],
  ["zht", "此租戶操作需要 Owner 或 Admin 權限。", "刷新"],
  ["en", "Owner or Admin permission is required for this tenant operation.", "Refresh"],
] as const) {
  test(`shows a localized authorization error and recovers on refresh for a member (${locale})`, async ({ page }) => {
    await page.goto(`/?mode=member-error&locale=${locale}&role=member`)
    const workbench = page.getByTestId("tenant-platform-workbench")
    await waitForInitialOverview(page)

    await page.getByTestId("tenant-platform-save-policy").click()
    await expect(page.getByRole("alert")).toContainText(expectedError)
    await expect(workbench).toHaveAttribute("aria-busy", "false")
    await expect(page.getByTestId("artifact-evidence-tenant-scope")).toBeDisabled()

    await workbench.locator("header").getByRole("button", { name: refreshLabel }).click()
    await page.waitForFunction(() => {
      const fixture = (globalThis as typeof globalThis & { __tenantPlatformScopeFixture?: { calls: string[] } })
        .__tenantPlatformScopeFixture
      return (fixture?.calls.filter((call) => call === "overview:workspace-a").length ?? 0) >= 2
    })
    await resolveWorkspace(page)
    await expect(workbench).toContainText("ten_fixture_a")
    await expect(workbench).toHaveAttribute("aria-busy", "false")
    await expect(page.getByRole("alert")).toHaveCount(0)
  })
}

for (const role of ["owner", "admin"] as const satisfies readonly FixtureRole[])
  for (const locale of ["zh", "zht", "en"] as const) {
    test(`allows the tenant evidence scope for ${role} (${locale})`, async ({ page }) => {
      await page.goto(`/?locale=${locale}&role=${role}`)
      await waitForInitialOverview(page)
      await expect(page.getByTestId("artifact-evidence-tenant-scope")).toBeEnabled()
      await expect(page.getByTestId("artifact-evidence-tenant-scope")).toContainText(
        locale === "zht" ? "目前租戶" : locale === "zh" ? "当前租户" : "Current tenant",
      )
    })
  }
