import { expect, test, type Page } from "@playwright/test";

const ROUNDING_TOLERANCE_PX = 1;

async function snapshot(page: Page) {
  return page.evaluate(() => window.mountingWindowFixture.snapshot());
}

async function wheel(page: Page, delta: number): Promise<void> {
  const before = await snapshot(page);
  await page.locator("chat-view .chat").hover();
  await page.mouse.wheel(0, delta);
  await expect.poll(async () => (await snapshot(page)).top).not.toBe(before.top);
  await page.evaluate(() => window.mountingWindowFixture.settled());
}

function expectSameAnchor(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>): void {
  expect(before.anchorId).toBeDefined();
  expect(after.anchorId).toBe(before.anchorId);
  if (before.anchorOffset === undefined || after.anchorOffset === undefined) throw new Error("Missing reading anchor geometry");
  expect(Math.abs(after.anchorOffset - before.anchorOffset)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mounting-window.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("ordinary rows stay retained while mounting a neighborhood, following tail then preserving native wheel reading", async ({ page }) => {
  const initial = await snapshot(page);
  expect(initial.retainedIds).toEqual(Array.from({ length: 1000 }, (_, index) => `entry-${String(index)}`));
  expect(initial.mountedIds.length).toBeGreaterThan(0);
  // A generous bound, not a particular overscan algorithm or row count.
  expect(initial.mountedIds.length).toBeLessThan(100);
  expect(Math.abs(initial.top - initial.maxTop)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);

  await page.evaluate(() => window.mountingWindowFixture.liveAppend());
  const following = await snapshot(page);
  expect(following.retainedIds).toHaveLength(1010);
  expect(following.mountedIds).toContain('m:["entry-1009","user","message"]');
  expect(Math.abs(following.top - following.maxTop)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);

  await wheel(page, -1800);
  const reading = await snapshot(page);
  expect(reading.top).toBeLessThan(reading.maxTop - 100);
  await page.evaluate(() => window.mountingWindowFixture.liveAppend());
  const after = await snapshot(page);
  expectSameAnchor(reading, after);
  expect(after.retainedIds).toHaveLength(1020);
  expect(after.retainedIds.slice(0, 1000)).toEqual(initial.retainedIds);
  expect(after.mountedIds.length).toBeLessThan(100);
  expect(after.historyRequests).toBe(0);
});

test("an offscreen saved anchor in retained data mounts and restores without requesting history", async ({ page }) => {
  expect((await snapshot(page)).mountedIds).not.toContain('m:["entry-250","user","message"]');
  await page.evaluate(() => window.mountingWindowFixture.start(true));
  await expect.poll(async () => (await snapshot(page)).savedOffset).toBeDefined();
  const restored = await snapshot(page);
  expect(Math.abs((restored.savedOffset ?? NaN) + 17)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
  expect(restored.retainedIds).toHaveLength(1000);
  expect(restored.mountedIds.length).toBeLessThan(100);
  expect(restored.historyRequests).toBe(0);
});

test("far scrolling preserves selected rows and an active ask textarea with its draft and focus", async ({ page }) => {
  const row = page.locator("chat-view article[data-transcript-row]").last();
  const paragraph = row.locator("formatted-text .enhanced-content p");
  await expect(paragraph).toBeVisible();
  const selectedRow = await row.elementHandle();
  const selected = await paragraph.evaluateHandle((element) => {
    // Select prose inside FormattedText's shadow root, not the article's
    // light-DOM action controls (which may contain only SVGs).
    const node = element.firstChild;
    if (!(node instanceof Text) || node.length === 0) throw new Error("Missing rendered message text");
    return node;
  });
  // WebKit does not expose a document Range added inside a shadow root as
  // selected text. Use native paragraph selection in the rendered prose.
  await paragraph.click({ clickCount: 3 });
  const text = await page.evaluate(() => document.getSelection()?.toString() ?? "");
  expect(text.length).toBeGreaterThan(0);
  expect(text.trim()).toBe(await selected.evaluate((node) => node.data.trim()));
  await page.evaluate(() => window.mountingWindowFixture.settled());
  const before = await snapshot(page);
  await wheel(page, -20000);
  expect(await selected.evaluate((node) => node.isConnected)).toBe(true);
  expect(await selectedRow.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(text);
  const after = await snapshot(page);
  expect(after.anchorId).not.toBe(before.anchorId);
  expect(after.mountedIds).toEqual(expect.arrayContaining(before.mountedIds));
  await selected.dispose();
  await selectedRow.dispose();

  await page.evaluate(() => window.mountingWindowFixture.start());
  const focused = await page.locator("chat-view article[data-transcript-row]").last().getByRole("button").first().elementHandle();
  await focused.focus();
  await wheel(page, -20000);
  expect(await focused.evaluate((element) => element.isConnected && element.matches(":focus"))).toBe(true);
  await focused.dispose();

  await page.evaluate(() => window.mountingWindowFixture.start());
  await page.evaluate(() => window.mountingWindowFixture.openAsk());
  const answer = page.locator("chat-view ask-user-card textarea");
  await answer.fill("Unsaved answer stays here");
  await expect(answer).toBeFocused();
  await wheel(page, -20000);
  await expect(answer).toBeAttached();
  await expect(answer).toBeFocused();
  await expect(answer).toHaveValue("Unsaved answer stays here");
  expect((await snapshot(page)).mountedIds.length).toBeLessThan(100);
});
