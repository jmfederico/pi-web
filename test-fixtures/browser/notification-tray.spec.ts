import { expect, test, type Locator, type Page } from "@playwright/test";

async function mountNotifications(page: Page, width: number, pseudo = false, withSession = true, shortCount?: 1 | 9): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(({ pseudo, withSession, shortCount }) => window.overlayFixture.mountNotifications(pseudo, withSession, shortCount), { pseudo, withSession, shortCount });
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("Missing notification geometry");
  return result;
}

async function expectHeaderReachable(page: Page): Promise<void> {
  const tray = page.locator("notification-area");
  const header = tray.locator(".notification-header");
  await expect(header).toBeInViewport({ ratio: 1 });
  await expect(tray.locator(".notification-heading")).toBeInViewport({ ratio: 1 });
  for (const [severity, count] of [["error", 3], ["warning", 7], ["info", 14]] as const) {
    const summary = tray.locator(`.notification-summary .notification-count.${severity}`);
    await expect(summary).toHaveText(String(count));
    await expect(summary).toHaveAccessibleName(/\S/u);
    await expect(summary).toBeInViewport({ ratio: 1 });
    await expect(summary.locator("svg")).toBeVisible();
    const indicatorBox = await box(summary);
    const toggleBox = await box(tray.locator(".notification-toggle"));
    expect(indicatorBox.y + indicatorBox.height / 2).toBeCloseTo(toggleBox.y + toggleBox.height / 2, 0);
    // Visible dimensions alone miss text covered by adjacent controls or clipped
    // inside an otherwise visible summary. Check its text and actual hit target.
    expect(await summary.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const root = element.getRootNode();
      if (!(root instanceof ShadowRoot)) throw new Error("Missing tray shadow root");
      const hit = root.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit !== null && element.contains(hit)
        && text.left >= bounds.left - 1 && text.right <= bounds.right + 1;
    })).toBe(true);
  }
  for (const selector of [".notification-clear", ".notification-toggle"]) {
    const control = tray.locator(selector);
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click({ trial: true });
  }
  const geometry = await header.evaluate((element) => {
    const style = getComputedStyle(element);
    const controls = element.querySelectorAll("button");
    return {
      height: element.getBoundingClientRect().height,
      oneRowHeight: Math.max(...Array.from(controls, (button) => button.getBoundingClientRect().height)) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(geometry.oneRowHeight + 1);
  for (const selector of ["chat-view", "notification-area", ".notification-header", ".notification-summary", ".notification-list"]) {
    expect(await page.locator(selector).evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${selector} horizontal overflow`).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const { width, pseudo } of [320, 360, 1280].flatMap((width) => [false, true].map((pseudo) => ({ width, pseudo })))) {
  test(`notification header stays pinned and reachable at ${String(width)}px${pseudo ? " with expanded pseudo labels" : ""}`, async ({ page }, testInfo) => {
    await mountNotifications(page, width, pseudo);
    if (pseudo) await expect(page.locator(".notification-heading")).toContainText("［");
    const tray = page.locator("notification-area");
    const header = tray.locator(".notification-header");
    const transcript = page.locator("chat-view .chat");
    const list = tray.locator(".notification-list");
    await expectHeaderReachable(page);
    if (testInfo.project.name === "chromium") {
      await testInfo.attach(`notification-sources-${String(width)}`, { body: await page.screenshot({ path: testInfo.outputPath("notification-sources.png") }), contentType: "image/png" });
    }
    const before = await box(header);
    expect(await transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    for (const position of [0, 500]) {
      await transcript.evaluate((element, top) => { element.scrollTop = top; }, position);
      await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(position);
      expect((await box(header)).y).toBeCloseTo(before.y, 0);
      await expectHeaderReachable(page);
    }
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await box(header)).y).toBeCloseTo(before.y, 0);
    await expectHeaderReachable(page);
    await tray.locator(".notification-row-dismiss").last().click({ trial: true });
    if (testInfo.project.name === "chromium") {
      await testInfo.attach(`notification-header-${String(width)}`, { body: await page.screenshot({ path: testInfo.outputPath("notification-header.png") }), contentType: "image/png" });
    }
    const toggle = tray.locator(".notification-toggle");
    if (testInfo.project.name === "touch") await toggle.tap();
    else await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();
    await expectHeaderReachable(page);
    if (testInfo.project.name === "chromium" || testInfo.project.name === "webkit") {
      await testInfo.attach(`notification-collapsed-${String(width)}`, { body: await page.screenshot({ path: testInfo.outputPath("notification-collapsed.png") }), contentType: "image/png" });
    }
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectHeaderReachable(page);
    await tray.locator(".notification-clear").click();
    await expect(tray.locator(".notification-row")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.overlayFixture.notificationActions)).toEqual(["clear:browser", "clear:server", "clear:session"]);
  });
}

for (const count of [1, 9] as const) {
  test(`${String(count)} short notifications remain readable beside a long transcript on a phone`, async ({ page }, testInfo) => {
    await mountNotifications(page, 390, false, true, count);
    const area = page.locator("notification-area");
    const list = area.locator(".notification-list");
    const toggle = area.locator(".notification-toggle");
    const firstMessage = area.locator(".notification-message").first();
    for (const height of [664, 480]) {
      await page.setViewportSize({ width: 390, height });
      await list.evaluate((element) => { element.scrollTop = 0; });
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      // A visible header/count is insufficient: flex shrink used to leave only
      // the list's padding visible when its messages were shorter than the chat.
      await expect(firstMessage).toBeInViewport({ ratio: 1 });
      expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThan((await box(firstMessage)).height);
      const header = await box(area.locator(".notification-header"));
      expect((await box(list)).y).toBeGreaterThanOrEqual(header.y + header.height - 1);
      expect((await box(page.locator("chat-view .chat"))).height).toBeGreaterThan(0);
      await area.locator(".notification-row-dismiss").last().click({ trial: true });
      await toggle.click();
      await expect(list).toBeHidden();
      await toggle.click();
      await list.evaluate((element) => { element.scrollTop = 0; });
      await expect(firstMessage).toBeInViewport({ ratio: 1 });
      if (testInfo.project.name === "webkit") {
        await testInfo.attach(`short-notifications-${String(count)}-${String(height)}`, {
          body: await page.screenshot({ path: testInfo.outputPath(`short-notifications-${String(height)}.png`) }), contentType: "image/png",
        });
      }
    }
    await area.locator(".notification-row-dismiss").last().click();
    await expect(area.locator(".notification-row")).toHaveCount(count - 1);
  });
}

for (const withSession of [true, false]) {
  test(`source actions remain reachable in the shell ${withSession ? "with a conversation" : "without a selected session"}`, async ({ page }, testInfo) => {
    await mountNotifications(page, 320, false, withSession);
    const area = page.locator("notification-area");
    await expect(page.locator("conversation-layout")).toHaveCount(withSession ? 1 : 0);
    const sources = withSession ? ["browser", "server", "session"] as const : ["browser", "server"] as const;
    for (const source of sources) {
      const row = area.locator(`[data-notification-id^="${source}:"]`).first();
      await expect(row.locator(".notification-source")).toHaveText(new RegExp(`^${source}$`, "i"));
      if (source !== "browser") await expect(row.locator(".notification-metadata")).toContainText(source === "server" ? "Local machine" : "Fixture session");
    }
    if (!withSession && testInfo.project.name === "chromium") {
      await testInfo.attach("notifications-without-session", { body: await page.screenshot({ path: testInfo.outputPath("notifications-without-session.png") }), contentType: "image/png" });
    }
    const browserRow = area.locator('[data-notification-id="browser:24"]');
    const retry = browserRow.getByRole("button", { name: /retry/i });
    if (testInfo.project.name === "touch") await retry.tap();
    else await retry.click();
    await expect.poll(() => page.evaluate(() => window.overlayFixture.notificationActions)).toEqual(["retry:browser:24"]);
    await browserRow.locator(".notification-row-dismiss").click();
    await expect(browserRow).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.overlayFixture.notificationActions)).toEqual(["retry:browser:24", "dismiss:browser:24"]);
    const serverRow = area.locator('[data-notification-id="server:23"]');
    await serverRow.getByRole("button", { name: /retry/i }).click();
    await expect.poll(() => page.evaluate(() => window.overlayFixture.notificationActions)).toEqual(["retry:browser:24", "dismiss:browser:24", "retry:server:23"]);
    await expect(area.locator(".notification-summary .notification-count.error")).toContainText(withSession ? "2" : "1");
  });
}

for (const outcome of ["remove", "replace", "reject"] as const) {
  test(`keyboard Retry recovers focus after asynchronous ${outcome}`, async ({ page }) => {
    await mountNotifications(page, 360, false, false);
    await page.evaluate((outcome) => window.overlayFixture.prepareNotificationRetry(outcome), outcome);
    const area = page.locator("notification-area");
    const retry = area.getByRole("button", { name: /retry/i });
    await retry.focus();
    await expect(retry).toBeFocused();
    await retry.press("Enter");
    await expect(retry).toBeDisabled();
    await page.evaluate(() => { window.overlayFixture.finishNotificationRetry(); });
    if (outcome === "reject") {
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
    } else {
      await expect(retry).toHaveCount(0);
      const target = outcome === "remove" ? area.locator('[data-notification-id="server:adjacent"]') : area.locator(".notification-header");
      await expect(target).toBeFocused();
      await expect(target).toBeInViewport({ ratio: 1 });
    }
  });
}

test("pending keyboard Retry does not reclaim deliberately moved focus", async ({ page }) => {
  await mountNotifications(page, 360, false, false);
  await page.evaluate(() => window.overlayFixture.prepareNotificationRetry("reject"));
  const retry = page.locator("notification-area").getByRole("button", { name: /retry/i });
  await retry.focus();
  await retry.press("Enter");
  await expect(retry).toBeDisabled();
  const outside = page.getByRole("textbox", { name: "Outside notifications" });
  await outside.click();
  await outside.pressSequentially("Keep typing");
  await expect(outside).toBeFocused();
  await page.evaluate(() => { window.overlayFixture.finishNotificationRetry(); });
  await expect(retry).toBeEnabled();
  await expect(outside).toBeFocused();
  await outside.pressSequentially(" here");
  await expect(outside).toHaveValue("Keep typing here");
});

for (const focusTarget of ["composer", "outside input"] as const) {
  test(`new errors reveal the latest row without taking ${focusTarget} focus`, async ({ page }) => {
    await mountNotifications(page, 360);
    const tray = page.locator("notification-area");
    const list = tray.locator(".notification-list");
    const toggle = tray.locator(".notification-toggle");
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const input = focusTarget === "composer" ? page.locator("prompt-editor .cm-content") : page.getByRole("textbox", { name: "Outside notifications" });
    await input.click();
    await input.pressSequentially("Keep this draft");
    await expect(input).toBeFocused();
    await page.evaluate(() => window.overlayFixture.addNotificationError());
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(input).toBeFocused();
    const latest = tray.locator('[data-notification-id^="browser:latest-error-"]');
    await expect(latest).toBeInViewport({ ratio: 1 });
    await expect(latest).toContainText("Latest error requires attention");
    expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
    await input.pressSequentially(" still typing");
    if (focusTarget === "composer") await expect(input).toHaveText("Keep this draft still typing");
    else await expect(input).toHaveValue("Keep this draft still typing");
  });
}
