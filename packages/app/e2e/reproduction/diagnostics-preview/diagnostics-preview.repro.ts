import { expect, test } from "@playwright/test"

test("shows a bounded, redacted, preview-only asset localization result", async ({ page }) => {
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message))
  await page.goto("/")

  const workbench = page.getByTestId("diagnostics-workbench")
  await expect(workbench).toHaveAttribute("aria-busy", "false")
  await workbench.getByTestId("diagnostics-mode").selectOption("frontend")
  await workbench.getByLabel("Image or document path").fill("src/index.html")
  await workbench.getByRole("button", { name: "Run diagnosis" }).click()

  const result = workbench.getByTestId("diagnostics-result")
  await expect(result).toBeVisible()
  const preview = result.getByTestId("asset-localization-preview")
  await expect(preview).toContainText("External asset localization preview")
  await expect(preview).toContainText("Ready for a later explicit approval")
  await expect(preview).toContainText("External requests")
  await expect(preview).toContainText("Discovery fingerprint")
  await expect(preview).toContainText("f".repeat(64))
  await expect(preview).toContainText("token=%5BREDACTED%5D")
  await expect(preview).not.toContainText("token=secret")
  await expect(result).not.toContainText("token=secret")
  await expect(preview).toContainText("no network request, file write, or approval is performed")
  await expect(preview).toContainText("This is only a preview")
  await expect(result.getByRole("button", { name: /localize/i })).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
