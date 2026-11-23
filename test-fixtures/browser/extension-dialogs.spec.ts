import { expect, test } from "@playwright/test";

for (const narrow of [false, true]) {
  test(`settled dialog controls remain reachable${narrow ? " in a narrow pane" : ""}`, async ({ page }, testInfo) => {
    if (narrow) await page.setViewportSize({ width: 320, height: 568 });
    await page.clock.install();
    await page.goto("/extension-dialogs.html");
    const card = page.locator("extension-dialog-card");
    const keep = card.getByRole("button", { name: "Keep visible", exact: true });
    const dismiss = card.getByRole("button", { name: "Dismiss", exact: true });
    const reveal = card.getByRole("button", { name: "See answer", exact: true });
    await expect(keep).toBeInViewport({ ratio: 1 });
    await expect(dismiss).toBeInViewport({ ratio: 1 });
    await expect(reveal).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("settled-dialog.png") });
    await keep.focus();
    await keep.press("Enter");
    await expect(dismiss).toBeFocused();
    await page.clock.runFor(11_000);
    await expect(card).toBeVisible();
    await dismiss.click();
    await expect(card).toHaveCount(0);
  });
}

test("revealing the answer cancels dismissal and preserves toggle focus", async ({ page }) => {
  await page.clock.install();
  await page.goto("/extension-dialogs.html");
  const card = page.locator("extension-dialog-card");
  const reveal = card.getByRole("button", { name: "See answer", exact: true });
  await reveal.focus();
  await reveal.press("Enter");
  await expect(card.getByRole("button", { name: "Hide answer", exact: true })).toBeFocused();
  await expect(card).toContainText("feature/automatic-dialog-dismissal");
  await expect(card.getByRole("button", { name: "Keep visible", exact: true })).toHaveCount(0);
  await page.clock.runFor(11_000);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(card).toHaveCount(0);
});

test("auto-dismiss removes the settled card from the transcript", async ({ page }) => {
  await page.clock.install();
  await page.goto("/extension-dialogs.html");
  const card = page.locator("extension-dialog-card");
  await expect(card.getByRole("button", { name: "Keep visible", exact: true })).toBeVisible();
  await page.clock.runFor(10_000);
  await expect(card).toHaveCount(0);
  await expect(page.locator("chat-view")).toContainText("The extension has received your answer.");
});
