const {test, expect} = require("@playwright/test");

test("Angular production build bootstraps in a real browser", async ({page}) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toHaveText("Arforge project depth");
  await expect(page.locator("#title")).toBeEditable();
  await expect(page.locator("body")).not.toHaveAttribute("data-bootstrap", "failed");
});
