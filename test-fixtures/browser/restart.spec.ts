import { expect, test, type Page } from "@playwright/test";

async function openRestart(page: Page, query = "") {
  await page.route("**/api/**", (route) => { throw new Error(`Unexpected live API request: ${route.request().url()}`); });
  await page.goto(`/restart.html${query}`);
  await page.getByRole("button", { name: "Open restart", exact: true }).click();
  // Controls are slotted from the owner's shadow root into ModalSurface.
  const dialog = page.locator("restart-dialog");
  await expect(dialog.getByRole("dialog", { name: "Restart PI WEB", exact: true })).toBeVisible();
  await expect(dialog.locator("#restart-close")).toBeFocused();
  return dialog;
}

test("keeps confirmation controls reachable and cancels without launching a terminal", async ({ page }, testInfo) => {
  const dialog = await openRestart(page);
  const opener = page.getByRole("button", { name: "Open restart", exact: true });
  await expect(dialog.locator("#restart-activity")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Both services", exact: true }).check();
  await expect(dialog.locator("#restart-activity")).toBeInViewport({ ratio: 1 });
  const confirm = dialog.locator("#restart-confirm");
  await expect(confirm).toBeInViewport({ ratio: 1 });
  const surface = await dialog.locator(".surface").boundingBox();
  const button = await confirm.boundingBox();
  if (!surface || !button) throw new Error("Missing restart dialog geometry");
  expect(button.x).toBeGreaterThanOrEqual(surface.x);
  expect(button.x + button.width).toBeLessThanOrEqual(surface.x + surface.width);
  expect(button.y + button.height).toBeLessThanOrEqual(surface.y + surface.height);
  await page.screenshot({ path: testInfo.outputPath("restart-confirmation.png") });
  await dialog.locator("#restart-close").click();
  await expect(dialog.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => window.restartFixture.launches())).toEqual([]);
});

test("hands off only the selected command and closes without tracking service status", async ({ page }) => {
  const dialog = await openRestart(page);
  const targets = [
    ["Web service", "pi-web-docker --dev restart-web"],
    ["Session daemon", "pi-web-docker --dev restart-sessiond"],
    ["Both services", "pi-web-docker --dev restart"],
  ] as const;
  const expected: { command: string; title: string }[] = [];
  for (const [title, command] of targets) {
    if (expected.length > 0) await page.getByRole("button", { name: "Open restart", exact: true }).click();
    await dialog.getByRole("radio", { name: title, exact: true }).check();
    await expect(dialog.locator("code")).toHaveText(command);
    await dialog.locator("#restart-confirm").click();
    await expect(dialog.getByRole("dialog")).toHaveCount(0);
    expected.push({ command, title });
    expect(await page.evaluate(() => window.restartFixture.launches())).toEqual(expected);
  }
});

for (const activity of ["idle", "unknown"] as const) {
  test(`shows the appropriate ${activity} activity state for daemon restarts`, async ({ page }) => {
    const dialog = await openRestart(page, `?${activity}`);
    await dialog.getByRole("radio", { name: "Session daemon", exact: true }).check();
    if (activity === "idle") await expect(dialog.locator("#restart-activity")).toHaveCount(0);
    else await expect(dialog.locator("#restart-activity")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => window.restartFixture.launches())).toEqual([]);
  });
}

test("disables a missing targeted command without substituting the broad command", async ({ page }) => {
  const dialog = await openRestart(page, "?missing-web");
  await expect(dialog.getByRole("radio", { name: "Web service", exact: true })).toBeDisabled();
  await expect(dialog.locator("#restart-confirm")).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Both services", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => window.restartFixture.launches())).toEqual([]);
});

test("keeps terminal handoff failures visible and cancellable", async ({ page }) => {
  const dialog = await openRestart(page, "?error");
  await dialog.locator("#restart-confirm").click();
  await expect(dialog.getByRole("alert")).toHaveText("Fixture terminal unavailable");
  await expect(dialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator("#restart-close")).toBeEnabled();
  expect(await page.evaluate(() => window.restartFixture.launches())).toEqual([]);
  await dialog.locator("#restart-close").click();
  await expect(dialog.getByRole("dialog")).toHaveCount(0);
});
