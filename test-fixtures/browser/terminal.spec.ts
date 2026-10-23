import { expect, test } from "@playwright/test";

test("fitted terminal rows and columns stay inside the visible inset after resizing", async ({ page }) => {
  await page.goto("/terminal.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const stage = page.locator("fixture-terminal-panel .terminal-stage");
  const screen = page.locator("fixture-terminal-panel .xterm-screen");
  for (const size of [{ width: 800, height: 350 }, { width: 803, height: 357 }, { width: 390, height: 667 }]) {
    await page.setViewportSize(size);
    await expect(async () => {
      const stageBox = await stage.boundingBox();
      const screenBox = await screen.boundingBox();
      if (stageBox === null || screenBox === null) throw new Error("Missing terminal geometry");
      expect(screenBox.height).toBeGreaterThan(0);
      // Mobile device scaling can introduce subpixel bounding-box rounding.
      const tolerance = 0.01;
      expect(screenBox.y).toBeGreaterThanOrEqual(stageBox.y + 6 - tolerance);
      expect(screenBox.x).toBeGreaterThanOrEqual(stageBox.x + 6 - tolerance);
      expect(screenBox.y + screenBox.height).toBeLessThanOrEqual(stageBox.y + stageBox.height - 6 + tolerance);
      expect(screenBox.x + screenBox.width).toBeLessThanOrEqual(stageBox.x + stageBox.width - 6 + tolerance);
    }).toPass({ timeout: 5_000 });
  }
});
