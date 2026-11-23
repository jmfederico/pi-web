import { expect, test, type Page } from "@playwright/test";

const SETTLE_MS = 400;

async function showShortcutsBar(page: Page, occlusion: number): Promise<void> {
  await page.evaluate(async (inset) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("Missing visual viewport");
    Object.defineProperty(viewport, "height", { configurable: true, value: document.documentElement.clientHeight - inset });
    viewport.dispatchEvent(new Event("resize"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); })));
  }, occlusion);
}

async function scrollRootBy(page: Page, offset: number): Promise<number> {
  return page.evaluate((y) => {
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "visible";
    document.body.style.height = "1800px";
    window.scrollTo(0, y);
    return window.scrollY;
  }, offset);
}

async function restoreRoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("overflow");
    document.body.style.removeProperty("overflow");
    document.body.style.removeProperty("height");
  });
}

for (const width of [700, 1366]) {
  test(`iPad Shortcuts bar gets permanent reserved space without moving the shell at width ${String(width)}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Exercise the iPad-only production path in every engine. This injects the
    // signals, not an actual iPad keyboard; overlay behavior needs a device test.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    });
    await page.goto("/shell-viewport.html");
    const shell = page.locator("viewport-shell");
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.focus();
    const header = page.getByText("Navigation", { exact: true });
    const status = page.getByText("Ready", { exact: true });
    const shellBox = await shell.boundingBox();
    const headerBox = await header.boundingBox();

    // Before any reserve, repair undoes WebKit panning the root (emulated with
    // real scroll range) without disturbing panel scrolling.
    await showShortcutsBar(page, 70);
    await page.locator("conversation-layout").evaluate((element) => { element.scrollTop = 300; });
    expect(await scrollRootBy(page, 50)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.locator("conversation-layout").evaluate((element) => element.scrollTop)).toBe(300);
    await restoreRoot(page);

    // The first settled bar reserves its height at the shell bottom.
    await page.waitForTimeout(SETTLE_MS + 100);
    const visibleBottom = await page.evaluate(() => document.documentElement.clientHeight - 70);
    await expect.poll(async () => (await status.boundingBox())?.y ?? Infinity).toBeLessThan(visibleBottom);
    const reserved = { composer: await composer.boundingBox(), status: await status.boundingBox() };
    expect((reserved.status?.y ?? 0) + (reserved.status?.height ?? 0)).toBeLessThanOrEqual(visibleBottom);

    // Later bars, a hidden bar, and leaving the field do not move anything again.
    let panelScroll = 300;
    for (const inset of [0, 50, 70]) {
      await showShortcutsBar(page, inset);
      await page.waitForTimeout(SETTLE_MS + 100);
      expect(await shell.boundingBox()).toEqual(shellBox);
      expect(await header.boundingBox()).toEqual(headerBox);
      expect(await composer.boundingBox()).toEqual(reserved.composer);
      expect(await status.boundingBox()).toEqual(reserved.status);
      await expect(composer).toBeFocused();

      const panel = page.locator("conversation-layout");
      await panel.evaluate((element) => { element.scrollTop += 150; });
      panelScroll += 150;
      await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(panelScroll);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    }
    await composer.blur();
    expect(await status.boundingBox()).toEqual(reserved.status);

    // A reload starts with the remembered reserve already in place.
    await page.reload();
    await expect.poll(() => status.boundingBox()).toEqual(reserved.status);

    // With the bar up, trackpad scrolling that no panel absorbs cannot pan the page.
    await composer.focus();
    await showShortcutsBar(page, 70);
    expect(await scrollRootBy(page, 0)).toBe(0);
    const headerCenter = await header.boundingBox();
    if (headerCenter === null) throw new Error("Missing header");
    await page.mouse.move(headerCenter.x + 10, headerCenter.y + headerCenter.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const panel = page.locator("conversation-layout");
    const panelBefore = await panel.evaluate((element) => element.scrollTop);
    const panelBox = await panel.boundingBox();
    if (panelBox === null) throw new Error("Missing panel");
    await page.mouse.move(panelBox.x + 20, panelBox.y + 20);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(panelBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await restoreRoot(page);

    // Once reserved, CSS owns stability: root scrolling is no longer scripted back.
    await composer.focus();
    await showShortcutsBar(page, 70);
    expect(await scrollRootBy(page, 50)).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });
}
