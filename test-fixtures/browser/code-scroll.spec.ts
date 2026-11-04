import { expect, test, type Page } from "@playwright/test";

const highlighted = "pi-web-highlighted-code .hljs-keyword";

async function prepareReading(page: Page): Promise<void> {
  await page.goto("/code-scroll.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => window.codeScrollFixture.frames());
  // Real wheel intent retires ChatView's initial follow/restore state. Geometry
  // setup below then isolates deferred layout from the wheel's own animation.
  await page.locator("chat-view .chat").hover();
  await page.mouse.wheel(0, -40);
  await expect.poll(() => page.evaluate(() => {
    const scroller = document.querySelector("chat-view")?.shadowRoot?.querySelector(".chat");
    return scroller !== null && scroller !== undefined && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 10;
  })).toBe(true);
  await page.evaluate(() => window.codeScrollFixture.frames());
}

async function recordEntry(page: Page) {
  // Retarget the next native gesture after programmatic setup; Chromium can
  // otherwise retain the previous wheel target after the transcript moves.
  await page.mouse.move(0, 500);
  await page.evaluate(() => window.codeScrollFixture.exitBelow());
  await page.evaluate(() => window.codeScrollFixture.frames());
  await page.locator("chat-view .chat").hover();
  const before = await page.evaluate(() => window.codeScrollFixture.enterFromBelow());
  const viewport = page.locator("chat-view .chat");
  const animatedWheel = page.context().browser()?.browserType().name() === "webkit";
  if (animatedWheel) {
    await viewport.evaluate((element) => {
      element.removeAttribute("data-wheel-ended");
      element.addEventListener("scrollend", () => { element.setAttribute("data-wheel-ended", "true"); }, { once: true });
    });
  }
  await page.mouse.wheel(0, -360);
  if (animatedWheel) await expect(viewport).toHaveAttribute("data-wheel-ended", "true");
  await expect(page.locator(highlighted).first()).toBeAttached();
  const samples = await page.evaluate(() => window.codeScrollFixture.stopRecording());
  const after = samples.at(-1);
  if (after === undefined) throw new Error("No scroll geometry recorded");
  return { before, after, samples };
}

async function expectStableEntry(page: Page): Promise<void> {
  const { before, after, samples } = await recordEntry(page);
  // Deferred layout may change the scroll offset by the block's height delta;
  // the visible bottom edge should move only by the user's wheel travel.
  if (page.context().browser()?.browserType().name() === "webkit") {
    // WebKit may finish its animated wheel early when layout compensation
    // changes scrollTop. The same bottom portion must still remain visible.
    expect(after.blockBottom).toBeGreaterThan(0);
  } else {
    expect(Math.abs(after.blockBottom - before.blockBottom - 360), JSON.stringify({ before, after })).toBeLessThanOrEqual(1);
  }
  for (const sample of samples) {
    expect(sample.blockBottom).toBeGreaterThanOrEqual(before.blockBottom - 1);
    expect(sample.blockBottom).toBeLessThanOrEqual(before.blockBottom + 361);
  }
}

test("deferred long code formatting preserves the reading position when entering from below", async ({ page }) => {
  await prepareReading(page);
  await expect(page.locator("pi-web-content-renderer")).toHaveCount(0);
  await expectStableEntry(page);
});

test("highlighted code preserves the reading position after repeated offscreen exit and reentry", async ({ page }) => {
  await prepareReading(page);
  // Initial deferred formatting has its own regression above; warm the real
  // renderer before testing the independent offscreen visibility transitions.
  await recordEntry(page);
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.evaluate(() => window.codeScrollFixture.exitBelow());
    await expect(page.locator("pi-web-highlighted-code")).toHaveCount(0);
    await page.evaluate(() => window.codeScrollFixture.frames());
    await expectStableEntry(page);
  }
});
