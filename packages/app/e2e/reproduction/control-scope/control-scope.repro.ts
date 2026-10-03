import { expect, test } from "@playwright/test"

const allCalls = [
  "permissions-saved",
  "permissions-pending",
  "memory-list",
  "memory-facets",
  "memory-quality",
]

test("drops late Permission and Memory responses from the prior workspace scope", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const permissions = page.getByTestId("control-center-permissions")
  const memory = page.getByTestId("control-center-memory")
  await page.waitForFunction((expected) => {
    const fixture = (globalThis as typeof globalThis & { __controlScopeFixture?: { calls: string[] } })
      .__controlScopeFixture
    return expected.every((prefix: string) => fixture?.calls.includes(prefix + ":workspace-a"))
  }, allCalls)
  await expect(permissions).toHaveAttribute("aria-busy", "true")
  await expect(memory).toHaveAttribute("aria-busy", "true")

  await page.getByTestId("control-scope-b").click()
  await page.waitForFunction((expected) => {
    const fixture = (globalThis as typeof globalThis & { __controlScopeFixture?: { calls: string[] } })
      .__controlScopeFixture
    return expected.every((prefix: string) => fixture?.calls.includes(prefix + ":workspace-b"))
  }, allCalls)

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __controlScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__controlScopeFixture
    fixture.resolve("workspace-a")
  })
  await expect(permissions).not.toContainText("workspace-a-permission")
  await expect(memory).not.toContainText("workspace-a memory")
  await expect(permissions).toHaveAttribute("aria-busy", "true")
  await expect(memory).toHaveAttribute("aria-busy", "true")

  await page.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & {
      __controlScopeFixture: { resolve: (workspace: "workspace-a" | "workspace-b") => void }
    }).__controlScopeFixture
    fixture.resolve("workspace-b")
  })
  await expect(permissions).toContainText("workspace-b-permission")
  await expect(memory).toContainText("workspace-b memory")
  await expect(permissions).not.toContainText("workspace-a-permission")
  await expect(memory).not.toContainText("workspace-a memory")
  await expect(permissions).toHaveAttribute("aria-busy", "false")
  await expect(memory).toHaveAttribute("aria-busy", "false")
  expect(pageErrors).toEqual([])
})
