import { expect, test } from "@playwright/test"

test("drops a late Provider response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("control-center-providers")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __providerScopeFixture?: { calls: string[] } })
      .__providerScopeFixture
    return fixture?.calls.includes("workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("provider-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __providerScopeFixture?: { calls: string[] } })
      .__providerScopeFixture
    return fixture?.calls.includes("workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __providerScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__providerScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("workspace-a provider")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __providerScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__providerScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("workspace-b provider")
  await expect(workbench).not.toContainText("workspace-a provider")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
