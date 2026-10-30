import { expect, test } from "@playwright/test";

for (const width of [700, 1366]) {
  test(`keeps the composer visible and panel scrolling independent at width ${String(width)}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/viewport.html");
    const shell = page.locator("viewport-shell");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.focus();

    // A deterministic visualViewport input exercises our geometry in each engine;
    // physical iPad keyboard/trackpad behavior still requires device validation.
    async function setVisibleHeight(height: number) {
      await page.evaluate((value) => {
        const viewport = window.visualViewport;
        if (!viewport) throw new Error("Missing visual viewport");
        Object.defineProperty(viewport, "height", { configurable: true, value });
        viewport.dispatchEvent(new Event("resize"));
      }, height);
      await expect.poll(async () => (await shell.boundingBox())?.height).toBe(height);
    }

    for (const height of [850, 500, 900]) {
      await setVisibleHeight(height);
      const header = await page.getByText("Navigation", { exact: true }).boundingBox();
      const editor = await composer.boundingBox();
      const status = await page.getByText("Ready", { exact: true }).boundingBox();
      expect(header?.y).toBe(0);
      expect(editor).not.toBeNull();
      expect(status).not.toBeNull();
      if (!editor || !status) throw new Error("Missing shell controls");
      expect(editor.y + editor.height).toBeLessThanOrEqual(height);
      expect(status.y + status.height).toBeLessThanOrEqual(height);
      await expect(composer).toBeFocused();

      const panel = page.locator("conversation-layout");
      await panel.evaluate((element) => { element.scrollTop = 150; });
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(150);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }
  });
}
