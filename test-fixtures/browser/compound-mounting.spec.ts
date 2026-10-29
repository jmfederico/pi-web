import { expect, test, type Page } from "@playwright/test";

const ROUNDING_TOLERANCE_PX = 1;

async function snapshot(page: Page) {
  return page.evaluate(() => window.compoundMountingFixture.snapshot());
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.compoundMountingFixture.settled());
}

async function wheel(page: Page, delta: number): Promise<void> {
  const before = await snapshot(page);
  await page.locator("chat-view .chat").hover();
  await page.mouse.wheel(0, delta);
  await expect.poll(async () => (await snapshot(page)).top).not.toBe(before.top);
  await settle(page);
}

function expectSameAnchor(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>): void {
  expect(before.anchorId).toBeDefined();
  expect(after.anchorId).toBe(before.anchorId);
  if (before.anchorOffset === undefined || after.anchorOffset === undefined) throw new Error("Missing child reading anchor geometry");
  expect(Math.abs(after.anchorOffset - before.anchorOffset)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/compound-mounting.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("one giant expanded activity retains 1000 technical messages but mounts only nearby measured children", async ({ page }) => {
  const initial = await snapshot(page);
  expect(initial.retainedIds).toEqual(Array.from({ length: 1000 }, (_, index) => `technical-${String(index)}`));
  expect(initial.groupCount).toBe(1);
  expect(initial.groupOpen).toBe(true);
  expect(initial.mountedChildren.length).toBeGreaterThan(0);
  expect(initial.mountedChildren.length).toBeLessThan(100);
  expect(initial.measuredChildren).toBe(initial.mountedChildren.length);
  expect(Math.abs(initial.top - initial.maxTop)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);

  await wheel(page, -1800);
  const reading = await snapshot(page);
  expect(reading.top).toBeLessThan(reading.maxTop - 100);
  await page.evaluate(() => window.compoundMountingFixture.liveAppend());
  const after = await snapshot(page);
  expectSameAnchor(reading, after);
  expect(after.retainedIds).toHaveLength(1010);
  expect(after.retainedIds.slice(0, 1000)).toEqual(initial.retainedIds);
  expect(after.mountedChildren.length).toBeLessThan(100);
  expect(after.historyRequests).toBe(0);
});

test("collapsed activity summaries join the outer window rather than pinning every compound owner", async ({ page }) => {
  await page.evaluate(() => window.compoundMountingFixture.start("groups"));
  const mounted = await snapshot(page);
  expect(mounted.retainedIds).toHaveLength(1000);
  expect(mounted.groupCount).toBeGreaterThan(0);
  expect(mounted.groupCount).toBeLessThan(100);
  expect(mounted.mountedChildren).toHaveLength(0);
});

test("tool expansion intent survives child recycling and remounting within the same open activity", async ({ page }) => {
  const initial = await snapshot(page);
  const targetIndex = initial.visibleChildren.at(-1);
  expect(targetIndex).toBeDefined();
  const child = page.locator(`chat-view .group-msg[data-index="${String(targetIndex)}"]`);
  const details = child.locator("tool-execution-view details.text-body");
  await expect(details).toBeAttached();
  const initiallyOpen = await details.evaluate((element) => element instanceof HTMLDetailsElement && element.open);
  await details.locator("summary").click();
  await expect.poll(() => details.evaluate((element) => element instanceof HTMLDetailsElement && element.open)).toBe(!initiallyOpen);
  // Use a real focus target outside the child; clicking a non-focusable scroller
  // can leave the tool summary focused in Firefox (and correctly pinned).
  await page.locator('chat-view [aria-label="Jump to end"]').focus();
  expect(await child.evaluate((element) => element.matches(":focus-within"))).toBe(false);
  await settle(page);
  const original = await child.elementHandle();
  // Firefox can cap a wheel event to roughly one page. Keep using native
  // input until this child leaves the overscan, with a bounded failure path.
  for (let gesture = 0; gesture < 10 && await child.count() > 0; gesture++) await wheel(page, -20000);
  await expect(child).toHaveCount(0);
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  await page.locator('chat-view [aria-label="Jump to end"]').click();
  await expect(child).toBeAttached();
  await expect.poll(() => details.evaluate((element) => element instanceof HTMLDetailsElement && element.open)).toBe(!initiallyOpen);
  expect(await original.evaluate((element) => element.isConnected)).toBe(false);
  expect((await snapshot(page)).groupOpen).toBe(true);
  const beforeClose = await child.elementHandle();
  const groupSummary = page.locator("chat-view details.ui-transcript-activity[data-index] > summary");
  await groupSummary.click();
  await expect(page.locator("chat-view .group-msg")).toHaveCount(0);
  await groupSummary.click();
  await page.locator('chat-view [aria-label="Jump to end"]').click();
  await expect(child).toBeAttached();
  expect(await child.evaluate((element, previous) => element === previous, beforeClose)).toBe(false);
  await expect.poll(() => details.evaluate((element) => element instanceof HTMLDetailsElement && element.open)).toBe(!initiallyOpen);
  await beforeClose.dispose();
  await original.dispose();
});

test("a saved child anchor in a retained open activity mounts and restores without fetching history", async ({ page }) => {
  expect((await snapshot(page)).mountedChildren).not.toContain(250);
  await page.evaluate(() => window.compoundMountingFixture.start("activity", true, true));
  await expect.poll(async () => (await snapshot(page)).savedOffset).toBeDefined();
  const restored = await snapshot(page);
  expect(restored.groupOpen).toBe(true);
  // The entry address is independent of this page's raw start offset (100).
  expect(restored.mountedChildren).toContain(350);
  expect(restored.mountedChildren.length).toBeLessThan(100);
  expect(Math.abs((restored.savedOffset ?? NaN) + 17)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
  expect(restored.retainedIds).toHaveLength(1000);
  expect(restored.historyRequests).toBe(0);
});

test("a saved child inside a collapsed retained activity resolves to its summary without opening or paging", async ({ page }) => {
  await page.evaluate(() => window.compoundMountingFixture.start("activity", true, true, true));
  const restored = await snapshot(page);
  expect(restored.groupCount).toBe(1);
  expect(restored.groupOpen).toBe(false);
  expect(restored.mountedChildren).toHaveLength(0);
  expect(restored.retainedIds).toHaveLength(1000);
  expect(restored.historyRequests).toBe(0);
  await expect(page.locator("chat-view details.ui-transcript-activity > summary")).toBeVisible();
});

test("large galleries window bands without changing flex-wrap columns and open the full gallery at the original index", async ({ page }) => {
  // Compare real production layouts, not a hand-built copy of the flex rules.
  await page.evaluate(() => window.compoundMountingFixture.start("gallery", false));
  const unwindowed = await snapshot(page);
  expect(unwindowed.thumbnails).toHaveLength(400);
  expect(unwindowed.columns).toBeGreaterThan(1);
  await page.evaluate(() => window.compoundMountingFixture.start("gallery"));
  const windowed = await snapshot(page);
  expect(windowed.retainedIds).toHaveLength(400);
  expect(windowed.thumbnails.length).toBeGreaterThan(0);
  expect(windowed.thumbnails.length).toBeLessThan(100);
  expect(windowed.columns).toBe(unwindowed.columns);
  expect(windowed.galleryWidth).toBe(unwindowed.galleryWidth);
  for (const image of windowed.thumbnails) {
    expect(image.width).toBe(128);
    expect(image.height).toBe(96);
  }

  await wheel(page, -1800);
  const reading = await snapshot(page);
  expect(reading.thumbnails.length).toBeLessThan(100);
  const selected = reading.thumbnails.find((image) => image.visible && image.y >= 0);
  if (selected === undefined) throw new Error("Missing visible gallery thumbnail");
  expect(selected.index).toBeGreaterThan(0);
  const thumbnail = page.locator(`chat-view .tool-image-thumbnails pi-web-transcript-image[data-index="${String(selected.index)}"]`);
  const imageButton = thumbnail.getByRole("button");
  const description = await thumbnail.locator("img").getAttribute("alt");
  const opener = await imageButton.elementHandle();
  await imageButton.click();
  const gallery = page.locator("chat-view pi-web-image-gallery-dialog");
  await expect(gallery.getByRole("dialog")).toBeVisible();
  await expect(gallery.getByRole("status")).toHaveText(`Image ${String(selected.index + 1)} of 400`);
  await expect(gallery.locator("img")).toHaveAttribute("alt", description ?? "");
  await gallery.locator('[data-navigation="previous"]').click();
  await expect(gallery.getByRole("status")).toHaveText(`Image ${String(selected.index)} of 400`);
  // Column regrouping must not dispose the modal's original return-focus target.
  await page.setViewportSize({ width: 420, height: 720 });
  await settle(page);
  await gallery.locator(".image-zoom-close").click();
  expect(await opener.evaluate((element) => element.isConnected && element.matches(":focus"))).toBe(true);
  await opener.dispose();
});

test("large image source disclosures mount a neighborhood rather than every retained output", async ({ page }) => {
  await page.evaluate(() => window.compoundMountingFixture.start("gallery"));
  const sources = page.locator("chat-view details.image-output-sources");
  await sources.locator(":scope > summary").click();
  await settle(page);
  await expect(sources).toHaveAttribute("open", "");
  const opened = await snapshot(page);
  expect(opened.retainedIds).toHaveLength(400);
  expect(opened.mountedSources).toBeGreaterThan(0);
  expect(opened.mountedSources).toBeLessThan(100);
  // Opening while following catches up to the new end; read back through sources.
  await wheel(page, -1800);
  const scrolled = await snapshot(page);
  expect(scrolled.mountedSources).toBeGreaterThan(0);
  expect(scrolled.mountedSources).toBeLessThan(100);
  expect(scrolled.historyRequests).toBe(0);
});
