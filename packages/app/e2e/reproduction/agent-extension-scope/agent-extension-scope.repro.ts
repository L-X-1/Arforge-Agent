import { expect, test } from "@playwright/test"

test("drops a late extension response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("agent-extension-insights")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __agentExtensionScopeFixture?: { calls: string[] } })
      .__agentExtensionScopeFixture
    return fixture?.calls.includes("workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("extension-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __agentExtensionScopeFixture?: { calls: string[] } })
      .__agentExtensionScopeFixture
    return fixture?.calls.includes("workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __agentExtensionScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b", marker: string) => void }
    }).__agentExtensionScopeFixture
    fixture.resolve("workspace-a", "old-workspace-command")
  })
  await expect(workbench).not.toContainText("old-workspace-command")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __agentExtensionScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b", marker: string) => void }
    }).__agentExtensionScopeFixture
    fixture.resolve("workspace-b", "new-workspace-command")
  })
  await expect(workbench).toContainText("/new-workspace-command")
  await expect(workbench).not.toContainText("old-workspace-command")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
