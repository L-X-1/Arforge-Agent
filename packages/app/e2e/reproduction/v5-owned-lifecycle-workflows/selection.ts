import type { Page } from "@playwright/test"

type Catalog = "Workflows" | "Skills" | "Plugins"
const panel = (page: Page) => page.getByTestId("extension-management")

export async function showCatalog(page: Page, name: Catalog) {
  await panel(page).getByRole("tab", { name, exact: true }).click()
}

export const runRows = (page: Page) =>
  panel(page).getByRole("list", { name: "Workflow run history", exact: true }).locator("button[data-management-detail-id]")

export async function selectPlugin(page: Page, name = "fixture-plugin") {
  await showCatalog(page, "Plugins")
  await panel(page).getByTestId("managed-plugin-center").locator("button[data-management-detail-id=" + JSON.stringify(name) + "]").click()
}

/** Real presentation selections only: never opens a Run or calls a mutation. */
export async function selectCatalogRecords(page: Page, finalView: Catalog = "Workflows") {
  await showCatalog(page, "Workflows")
  const definitions = panel(page).getByRole("list", { name: "Validated workflow graphs", exact: true }).locator("button[data-management-detail-id]")
  if (await definitions.count()) await definitions.first().click()
  await showCatalog(page, "Skills")
  const skills = panel(page).getByTestId("managed-skill-center").locator('button[data-management-detail-id="managed:fixture-skill"]')
  if (await skills.count()) await skills.click()
  await showCatalog(page, "Plugins")
  const plugins = panel(page).getByTestId("managed-plugin-center").locator('button[data-management-detail-id="fixture-plugin"]')
  if (await plugins.count()) await plugins.click()
  await showCatalog(page, finalView)
}
