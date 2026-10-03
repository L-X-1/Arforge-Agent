import { expect, test } from "@playwright/test"

test("drops a late Experience candidate response from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("experience-candidate-workbench")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __experienceCandidateScopeFixture?: { calls: string[] } })
      .__experienceCandidateScopeFixture
    return fixture?.calls.includes("workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("experience-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __experienceCandidateScopeFixture?: { calls: string[] } })
      .__experienceCandidateScopeFixture
    return fixture?.calls.includes("workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __experienceCandidateScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__experienceCandidateScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("workspace-a-experience-candidate")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __experienceCandidateScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__experienceCandidateScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("workspace-b-experience-candidate")
  await expect(workbench).not.toContainText("workspace-a-experience-candidate")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
