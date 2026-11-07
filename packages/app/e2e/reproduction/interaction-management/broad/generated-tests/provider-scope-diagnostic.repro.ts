import { expect, test } from "../network-fixture"
test("provider request diagnostic retains the new scope after one resolution", async ({ page }, info) => {
  await page.goto("/")
  await page.waitForFunction(() => (window as any).__providerScopeFixture?.calls.includes("workspace-a"))
  await page.getByTestId("provider-scope-b").click()
  await page.waitForFunction(() => (window as any).__providerScopeFixture?.calls.includes("workspace-b"))
  await page.evaluate(() => { (window as any).__providerScopeFixture.resolve("workspace-a"); (window as any).__providerScopeFixture.resolve("workspace-b") })
  await page.waitForTimeout(250)
  const result = await page.evaluate(() => ({calls:(window as any).__providerScopeFixture.calls,busy:document.querySelector('[data-testid="control-center-providers"]')?.getAttribute("aria-busy"),text:document.querySelector('[data-testid="control-center-providers"]')?.textContent}))
  await info.attach("scope-observation",{body:JSON.stringify(result),contentType:"application/json"})
  expect(result.calls).toEqual(["workspace-a","workspace-b"])
  expect(result.busy).toBe("false")
  expect(result.text).toContain("workspace-b provider")
})
