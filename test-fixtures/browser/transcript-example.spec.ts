import { expect, test } from "@playwright/test";

test("the copyable example renders structured results, follows themes, and retains the original view", async ({ page }) => {
  await page.goto("/transcript-example.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const chat = page.locator("chat-view");
  const checks = chat.locator("pi-web-transcript-renderer").first();
  await expect(checks).toBeVisible();
  await expect(checks.getByText("Rendered by the example plugin", { exact: true })).toBeVisible();
  await expect(checks.getByText("API contract", { exact: true })).toBeVisible();
  await expect(chat.getByText("Preview build complete", { exact: true })).toBeVisible();
  await checks.getByText("Command and output", { exact: true }).click();
  await expect(checks.locator(".example-checks-source").getByText("npm run check", { exact: true })).toBeVisible();
  await expect(checks.locator(".example-checks-source").getByText("3 passed, 1 failed (2.4 s).", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "light");
  await expect(checks.getByText("API contract", { exact: true })).toBeVisible();
  await expect(checks.locator(".example-checks-details")).toHaveAttribute("open", "");
  await checks.getByRole("button", { name: "Default view", exact: true }).click();
  await expect(checks.getByRole("heading", { name: "Workspace checks", exact: true })).toHaveCount(0);
  await expect(checks.locator("tool-execution-view")).toBeVisible();
  await expect(checks.getByText("Rendered by the example plugin", { exact: true })).toHaveCount(0);
  await checks.getByRole("button", { name: "Custom view", exact: true }).click();
  await expect(checks.getByRole("heading", { name: "Workspace checks", exact: true })).toBeVisible();
  expect(await chat.evaluate((element) => {
    const scroller = element.shadowRoot?.querySelector(".chat");
    return scroller !== undefined && scroller !== null && scroller.scrollWidth <= scroller.clientWidth;
  })).toBe(true);
});
