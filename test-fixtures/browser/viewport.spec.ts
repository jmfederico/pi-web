import { expect, test, type Page } from "@playwright/test";

// Scroll offsets may round while rectangles retain fractional CSS pixels.
const ROUNDING_TOLERANCE_PX = 1;

async function geometry(page: Page) {
  return page.evaluate(() => window.viewportFixture.geometry());
}

async function wheel(page: Page, delta: number): Promise<void> {
  const before = await geometry(page);
  await page.locator("chat-view .chat").hover();
  await page.mouse.wheel(0, delta);
  await expect.poll(async () => (await geometry(page)).top).not.toBe(before.top);
  await page.evaluate(() => window.viewportFixture.settled());
}

function expectSameAnchor(before: Awaited<ReturnType<typeof geometry>>, after: Awaited<ReturnType<typeof geometry>>): void {
  expect(after.anchorId).toBe(before.anchorId);
  if (after.anchorOffset === undefined || before.anchorOffset === undefined) throw new Error("Missing reading anchor geometry");
  expect(Math.abs(after.anchorOffset - before.anchorOffset)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/viewport.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("consecutive prepends and simultaneous tail growth preserve the first reading anchor", async ({ page }) => {
  await wheel(page, -900);
  const before = await geometry(page);
  expect(before.top).toBeGreaterThan(0);
  expect(before.top).toBeLessThan(before.maxTop - 100);
  await page.evaluate(() => window.viewportFixture.prependAndGrow());
  const after = await geometry(page);
  expect(after.maxTop).toBeGreaterThan(before.maxTop);
  expect(after.top).toBeGreaterThan(before.top);
  expectSameAnchor(before, after);
});

test("delayed saved anchors restore until actual wheel input retires them", async ({ page }) => {
  // Both key formats are real persisted bookmarks, not controller-private state.
  for (const machine of ["local", "remote-fixture"] as const) {
    await page.evaluate((id) => window.viewportFixture.mount(id), machine);
    expect((await geometry(page)).historyRequests).toBe(1);
    await page.evaluate(() => window.viewportFixture.revealSaved());
    expect(Math.abs(((await geometry(page)).savedOffset ?? NaN) + 17)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);

    await page.evaluate((id) => window.viewportFixture.mount(id), machine);
    expect((await geometry(page)).historyRequests).toBe(1);
    await wheel(page, 400);
    const reading = await geometry(page);
    await page.evaluate(() => window.viewportFixture.revealSaved());
    const after = await geometry(page);
    expectSameAnchor(reading, after);
    expect(Math.abs((after.savedOffset ?? NaN) + 17)).toBeGreaterThan(ROUNDING_TOLERANCE_PX);
  }
});

test("opening a taller-than-viewport form aligns its start only while following", async ({ page }) => {
  const following = await geometry(page);
  expect(following.top).toBeCloseTo(following.maxTop, 0);
  await page.evaluate(() => window.viewportFixture.openForm());
  const aligned = await geometry(page);
  expect(aligned.formHeight).toBeGreaterThan(aligned.height);
  expect(Math.abs(aligned.formOffset ?? NaN)).toBeLessThanOrEqual(ROUNDING_TOLERANCE_PX);
  expect(aligned.top).toBeLessThan(aligned.maxTop - 100);

  await page.evaluate(() => window.viewportFixture.mount());
  await wheel(page, -900);
  const reading = await geometry(page);
  await page.evaluate(() => window.viewportFixture.openForm());
  expectSameAnchor(reading, await geometry(page));
});
