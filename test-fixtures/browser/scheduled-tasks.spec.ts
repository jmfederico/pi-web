import { expect, test } from "@playwright/test";

const taskName = "Daily issue classification and compatibility review";

test("overview hides configuration and history until requested; long task results remain usable", async ({ page }) => {
  await page.goto("/scheduled-tasks.html");
  const panel = page.locator("pi-web-scheduled-tasks-panel");
  await expect(panel.getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
  await expect(panel.locator(".history-entry")).toHaveCount(0);
  await expect(panel.getByText("project-with-a-long-registered-id", { exact: false })).toHaveCount(0);
  const body = panel.locator(".body");
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const taskLink = panel.getByRole("button", { name: `View task: ${taskName}`, exact: true }).first();
  await taskLink.click();
  await expect(panel.locator(".view-title")).toBeFocused();
  const history = panel.locator(".history-entry");
  await expect(history).toHaveCount(1);
  const technical = history.locator("details");
  await expect(technical.getByText("project-with-a-long-registered-id", { exact: false })).not.toBeVisible();
  await technical.locator("summary").click();
  await expect(technical.getByText("project-with-a-long-registered-id", { exact: false })).toBeVisible();
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
    expect(buttonBox.y).toBeGreaterThanOrEqual(scrollBox.y);
    expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height);
  }
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(taskLink).toBeFocused();
  await panel.getByRole("button", { name: "All history", exact: true }).click();
  await expect(history).toHaveCount(1);
});

test("paused and archived tasks remain discoverable and controls work in narrow RTL layouts", async ({ page }) => {
  await page.goto("/scheduled-tasks.html");
  const panel = page.locator("pi-web-scheduled-tasks-panel");
  await expect(panel.locator(".task").first()).toBeVisible();
  const archived = panel.getByRole("button", { name: /Archived compatibility check/ });
  await expect(archived).not.toBeVisible();
  await panel.locator(".all-tasks > summary").click();
  await expect(archived).toBeVisible();
  await page.getByRole("button", { name: "RTL", exact: true }).click();
  await expect(panel.locator(".panel")).toHaveAttribute("dir", "rtl");
  expect(await panel.locator(".body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await archived.click();
  await expect(panel.locator(".view-title")).toBeFocused();
  const refresh = panel.locator("header button");
  await refresh.click(); await expect(refresh).toBeEnabled();
  await panel.locator(".back").click();
  await expect(archived).toBeFocused();
});
