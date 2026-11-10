import { expect, test, type CDPSession, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/image-gallery.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Open images", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("img", { name: "Second", exact: true })).toBeVisible();
});

test("gallery controls remain reachable and restore focus on close", async ({ page }) => {
  await page.getByRole("button", { name: "Next image", exact: true }).click();
  await expect(page.getByRole("img", { name: "Third", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous image", exact: true }).click();
  await expect(page.getByRole("img", { name: "Second", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close image", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open images", exact: true })).toBeFocused();
});

test("native pinch zoom allows panning across the image without changing gallery selection", async ({ page, browserName, isMobile }) => {
  // CDP supplies browser-handled touch gestures, not synthetic DOM pointer events.
  test.skip(browserName !== "chromium" || !isMobile, "Native touch gesture injection requires mobile Chromium CDP");
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, page, "touchStart", [{ x: 150, y: 400 }, { x: 230, y: 400 }]);
  for (let step = 1; step <= 10; step++) {
    await touch(cdp, page, "touchMove", [{ x: 150 - step * 6, y: 400 }, { x: 230 + step * 6, y: 400 }]);
  }
  await touch(cdp, page, "touchEnd", []);
  await expect.poll(async () => (await viewport(page)).scale).toBeGreaterThan(1.5);
  const before = await viewport(page);
  await drag(cdp, page, -100, 0);
  await expect.poll(async () => (await viewport(page)).x).toBeGreaterThan(before.x + 20);
  await drag(cdp, page, 0, -100);
  await expect.poll(async () => (await viewport(page)).y).toBeGreaterThan(before.y + 20);
  await expect(page.getByRole("img", { name: "Second", exact: true })).toBeVisible();
  const moved = await viewport(page);
  await drag(cdp, page, 100, 0);
  await expect.poll(async () => (await viewport(page)).x).toBeLessThan(moved.x - 20);
  await drag(cdp, page, 0, 100);
  await expect.poll(async () => (await viewport(page)).y).toBeLessThan(moved.y - 20);
  await expect(page.getByRole("img", { name: "Second", exact: true })).toBeVisible();

  // Restore native page scale and prove horizontal gallery swipes still work.
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await expect.poll(async () => (await viewport(page)).scale).toBe(1);
  await drag(cdp, page, -100, 0);
  await expect(page.getByRole("img", { name: "Third", exact: true })).toBeVisible();
  await cdp.detach();
});

async function viewport(page: Page) {
  return page.evaluate(() => {
    const view = window.visualViewport;
    if (view === null) throw new Error("Visual viewport is unavailable");
    return { x: view.offsetLeft, y: view.offsetTop, scale: view.scale };
  });
}

async function touch(cdp: CDPSession, page: Page, type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) {
  // Keep fingers at screen positions as the native visual viewport changes scale.
  const { scale } = await viewport(page);
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(({ x, y }, id) => ({ id, x: x / scale, y: y / scale })) });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); })));
}

async function drag(cdp: CDPSession, page: Page, dx: number, dy: number) {
  await touch(cdp, page, "touchStart", [{ x: 190, y: 400 }]);
  for (let step = 1; step <= 10; step++) {
    await touch(cdp, page, "touchMove", [{ x: 190 + dx * step / 10, y: 400 + dy * step / 10 }]);
  }
  await touch(cdp, page, "touchEnd", []);
}
