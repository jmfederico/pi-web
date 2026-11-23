import { expect, test } from "@playwright/test";

test("keeps direct restart feedback reachable until terminal acceptance without tracking recovery", async ({ page }, testInfo) => {
  await page.route("**/api/**", (route) => { throw new Error(`Unexpected live API request: ${route.request().url()}`); });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto("/updates.html");
  const panel = page.locator("updates-fixture");
  const recommended = panel.locator(".updates-recommended");
  const restart = recommended.getByRole("button", { name: "Restart session daemon", exact: true });

  // Assert actual viewport reachability, not merely DOM presence, in desktop and touch projects.
  await expect(panel.getByText("Machine: Build machine", { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(panel.getByText(/act immediately, without confirmation/)).toBeInViewport({ ratio: 1 });
  await expect(recommended.getByText(/interrupts active sessions and terminals/)).toBeInViewport({ ratio: 1 });
  await expect(restart).toBeInViewport({ ratio: 1 });
  const panelBox = await panel.boundingBox();
  const buttonBox = await restart.boundingBox();
  if (panelBox === null || buttonBox === null) throw new Error("Missing Updates geometry");
  expect(buttonBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height);
  await page.screenshot({ path: testInfo.outputPath("updates-direct-restart.png") });

  if (testInfo.project.use.hasTouch === true) await restart.tap();
  else await restart.click();
  await expect.poll(() => page.evaluate(() => window.updatesFixture.requests())).toEqual([
    { machineId: "remote-build", options: { services: "sessiond", confirm: false } },
  ]);
  const starting = recommended.getByRole("button", { name: "Starting…", exact: true });
  await expect(starting).toBeInViewport({ ratio: 1 });
  await expect(starting).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Restart Web/UI", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Restart all", exact: true })).toBeDisabled();
  await expect(recommended.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("updates-starting.png") });

  // Acceptance ends preparation feedback; there is deliberately no process-finished signal.
  await page.evaluate(() => { window.updatesFixture.acceptTerminal(); });
  await expect(restart).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Restart Web/UI", exact: true })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Restart all", exact: true })).toBeEnabled();
  await expect(starting).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(dialogs).toEqual([]);
});
