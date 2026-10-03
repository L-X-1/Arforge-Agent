import { expect, test } from "@playwright/test"

test("drops a late Skill lifecycle response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("skill-lifecycle-workbench")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __skillLifecycleScopeFixture?: { calls: string[] } })
      .__skillLifecycleScopeFixture
    return fixture?.calls.includes("candidate:workspace-a") && fixture.calls.includes("source:workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("skill-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __skillLifecycleScopeFixture?: { calls: string[] } })
      .__skillLifecycleScopeFixture
    return fixture?.calls.includes("candidate:workspace-b") && fixture.calls.includes("source:workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __skillLifecycleScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__skillLifecycleScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("workspace-a-skill")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __skillLifecycleScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__skillLifecycleScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("workspace-b-skill")
  await expect(workbench).not.toContainText("workspace-a-skill")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
