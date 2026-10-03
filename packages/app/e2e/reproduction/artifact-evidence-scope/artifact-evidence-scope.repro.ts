import { expect, test } from "@playwright/test"

test("drops a late Artifact Evidence response from the prior session scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("artifact-evidence-card")
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __artifactEvidenceScopeFixture?: { calls: string[] } })
      .__artifactEvidenceScopeFixture
    return fixture?.calls.includes("catalog:workspace-a") && fixture.calls.includes("audit:workspace-a")
  })
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("artifact-scope-b").click()
  await page.waitForFunction(() => {
    const fixture = (globalThis as typeof globalThis & { __artifactEvidenceScopeFixture?: { calls: string[] } })
      .__artifactEvidenceScopeFixture
    return fixture?.calls.includes("catalog:workspace-b") && fixture.calls.includes("audit:workspace-b")
  })

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __artifactEvidenceScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__artifactEvidenceScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(workbench).not.toContainText("workspace-a artifact")
  await expect(workbench).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __artifactEvidenceScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__artifactEvidenceScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(workbench).toContainText("workspace-b artifact")
  await expect(workbench).toContainText("workspace-b actor")
  await expect(workbench).not.toContainText("workspace-a artifact")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
