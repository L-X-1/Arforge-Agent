import { expect, test } from "@playwright/test"

test("drops a late System Overview response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const overview = page.getByTestId("control-center-overview")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __systemOverviewScopeFixture?: { calls: string[] } })
      .__systemOverviewScopeFixture
    return fixture?.calls.includes("overview:workspace-a")
  })
  await expect(overview).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("system-overview-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __systemOverviewScopeFixture?: { calls: string[] } })
      .__systemOverviewScopeFixture
    return fixture?.calls.includes("overview:workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __systemOverviewScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__systemOverviewScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(overview).not.toContainText("overview-workspace-a")
  await expect(overview).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __systemOverviewScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__systemOverviewScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(overview).toContainText("overview-workspace-b")
  await expect(overview).not.toContainText("overview-workspace-a")
  await expect(overview).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
