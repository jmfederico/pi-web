import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/model-picker.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("scope stays above search and separate from the scrollable model targets", async ({ page }) => {
  const checkbox = page.getByRole("checkbox", { name: "Enable all models", exact: true });
  const search = page.getByRole("textbox", { name: "Search models" });
  await expect(search).toBeFocused();
  await expect(checkbox).toHaveCount(0);
  await expect(page.locator(".availability-scope")).toHaveCount(0);
  const enabledSearchBox = await search.boundingBox();
  await page.getByRole("button", { name: "All models", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  const rows = page.locator(".catalog-row");
  await expect(rows.first().getByRole("checkbox")).toBeChecked();
  await expect(rows.last().getByRole("checkbox")).toBeChecked();

  const scope = page.locator(".availability-scope");
  const scopeBox = await scope.boundingBox();
  const searchBox = await search.boundingBox();
  const listBox = await page.locator(".options").boundingBox();
  const viewport = page.viewportSize();
  if (scopeBox === null || searchBox === null || enabledSearchBox === null || listBox === null || viewport === null) throw new Error("Missing picker geometry");
  expect(enabledSearchBox.y).toBeLessThan(searchBox.y);
  expect(scopeBox.x).toBeGreaterThanOrEqual(0);
  expect(scopeBox.x + scopeBox.width).toBeLessThanOrEqual(viewport.width);
  expect(scopeBox.y + scopeBox.height).toBeLessThanOrEqual(searchBox.y);
  expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(listBox.y);
  expect(listBox.height).toBeGreaterThan(44);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(viewport.height);
  expect(await scope.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await rows.last().locator("button.membership").scrollIntoViewIfNeeded();
  await rows.last().getByRole("checkbox").click({ trial: true });
  expect(await scope.boundingBox()).toEqual(scopeBox);
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await checkbox.press("Space");
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(() => window.modelPickerFixture.requests)).toEqual(["all"]);
  await page.evaluate(() => window.modelPickerFixture.confirm("all"));
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeFocused();
  await expect(rows.last().getByRole("checkbox")).toBeDisabled();
  await expect(page.locator(".toggle-all")).toBeDisabled();

  await page.getByRole("button", { name: "Enabled", exact: true }).click();
  await expect(checkbox).toHaveCount(0);
  await expect(page.locator(".availability-scope")).toHaveCount(0);
  await page.getByRole("button", { name: "Use model-1 as default for new sessions", exact: true }).click();
  await page.getByRole("button", { name: "model-1 fixture-provider", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-picked", "fixture-provider/model-1");
  await page.getByRole("button", { name: "All models", exact: true }).click();
  await expect(checkbox).toBeChecked();
  expect(await page.evaluate(() => window.modelPickerFixture.requests)).toEqual(["all"]);
});

test("native label activation and keyboard retry preserve confirmed state on failure", async ({ page }) => {
  await page.getByRole("button", { name: "All models", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: "Enable all models", exact: true });
  const label = page.locator(".availability-scope label");
  if (test.info().project.name === "touch") await label.tap();
  else await label.click();
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  await page.evaluate(() => window.modelPickerFixture.confirm("all"));
  await expect(checkbox).toBeChecked();

  await checkbox.focus();
  await checkbox.press("Space");
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).toBeChecked();
  await page.evaluate(() => window.modelPickerFixture.fail());
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  await checkbox.press("Enter");
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).toBeChecked();
  expect(await page.evaluate(() => window.modelPickerFixture.requests)).toEqual(["all", "manual", "manual"]);
  const search = page.getByRole("textbox", { name: "Search models" });
  await search.focus();
  await page.evaluate(() => window.modelPickerFixture.confirm("manual"));
  await expect(checkbox).not.toBeChecked();
  await expect(search).toBeFocused();
});
