import { expect, test } from "@playwright/test";

test("scheduled task overview stays within the tool column and conversation targets work after scrolling", async ({ page }) => {
  await page.goto("/scheduled-tasks.html");
  const panel = page.locator("pi-web-scheduled-tasks-panel");
  await expect(panel.getByRole("heading", { name: "Daily issue classification and compatibility review", exact: true }).first()).toBeVisible();
  const body = panel.locator(".body");
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "View history for Daily issue classification and compatibility review", exact: true }).click();
  await expect(panel.getByRole("button", { name: "All tasks", exact: true })).toBeEnabled();
  const history = panel.locator(".history-entry");
  const open = history.getByRole("button", { name: "Open conversation", exact: true });
  await open.click();
  await expect(page.locator("body")).toHaveAttribute("data-destination", JSON.stringify({ machineId: "local", projectId: "project-with-a-long-registered-id", workspaceId: "main-workspace", sessionId: "review-conversation", view: "chat" }));
  await open.focus();
  await expect(open).toBeFocused();
  const buttonBox = await open.boundingBox();
  const scrollBox = await body.boundingBox();
  expect(buttonBox).not.toBeNull(); expect(scrollBox).not.toBeNull();
  if (buttonBox && scrollBox) {
    expect(buttonBox.x).toBeGreaterThanOrEqual(scrollBox.x);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(scrollBox.x + scrollBox.width);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height);
  }
});

test("scheduled tasks wraps long labels and keeps controls reachable in RTL", async ({ page }) => {
  await page.goto("/scheduled-tasks.html");
  const panel = page.locator("pi-web-scheduled-tasks-panel");
  await expect(panel.locator("article").first()).toBeVisible();
  await page.getByRole("button", { name: "RTL", exact: true }).click();
  await expect(panel.locator(".panel")).toHaveAttribute("dir", "rtl");
  expect(await panel.locator(".body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const refresh = panel.locator("header button");
  await refresh.click(); await expect(refresh).toBeEnabled();
  await expect(panel.locator(".task")).toHaveCount(2);
});
