import { expect, test, type Locator, type Page } from "@playwright/test";

const lists = [
  { host: "project-list", context: "projects", first: "p1", second: "p2" },
  { host: "workspace-list", context: "workspaces", first: "w1", second: "w2" },
  { host: "session-list", context: "sessions", first: "s1", second: "s2" },
] as const;

test.beforeEach(async ({ page }) => {
  await page.goto("/navigation.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("shared row hooks preserve full-width geometry, long names, and keyboard navigation", async ({ page }) => {
  for (const { host, context, second } of lists) {
    const component = page.locator(host);
    const scope = component.locator(`[data-ui-context="${context}"]`);
    const rows = scope.locator(".ui-nav-list .ui-nav-row");
    const first = rows.first();
    const next = rows.nth(1);
    await expect(first).toHaveAttribute("data-current", "true");
    const geometry = await first.evaluate((element) => {
      const main = element.querySelector(":scope > .ui-nav-row-main");
      const actions = element.querySelector(":scope > .ui-nav-row-actions");
      const label = element.querySelector(".ui-nav-row-label");
      const list = element.closest(".ui-nav-list");
      if (!main || !actions || !label || !list) throw new Error("Missing row anatomy");
      return {
        rowWidth: element.getBoundingClientRect().width, listWidth: list.clientWidth,
        mainRight: main.getBoundingClientRect().right, actionsLeft: actions.getBoundingClientRect().left,
        labelOverflow: label.scrollWidth > label.clientWidth,
        scrollerOverflow: list.scrollWidth > list.clientWidth,
      };
    });
    expect(geometry.rowWidth).toBeCloseTo(geometry.listWidth, 0);
    expect(geometry.mainRight).toBeLessThanOrEqual(geometry.actionsLeft + 1);
    expect(geometry.labelOverflow).toBe(true);
    expect(geometry.scrollerOverflow).toBe(false);
    const before = await first.boundingBox();
    await first.focus();
    await first.press("ArrowDown");
    await expect(next).toBeFocused();
    await expect(first).toHaveAttribute("data-current", "true");
    await next.press("Enter");
    await expect(page.locator("#last-selected")).toHaveText(`${context}:${second}`);
    await expect(next).toHaveAttribute("data-current", "true");
    await expect(next).toHaveAttribute("aria-current", "true");
    await expect(first).toHaveAttribute("data-current", "false");
    expect(await first.boundingBox()).toEqual(before);

  }
});

test("less-specific themes override navigation presentation across component roots", async ({ page }) => {
  const labels = lists.map(({ host }) => page.locator(host).locator(".ui-nav-row-label").first());
  const positions = await Promise.all(labels.map((label) => label.evaluate((element) => element.getBoundingClientRect().left)));
  await page.route("**/navigation-theme.css", (route) => route.fulfill({
    contentType: "text/css",
    body: `.ui-nav-row-label { color: rgb(200, 210, 220); white-space: normal; }
      .ui-nav-row-main { padding-inline-start: 24px; }`,
  }));
  await page.evaluate(() => window.navigationFixture.applyTheme(new URL("navigation-theme.css", location.href).href));
  for (const [index, { host }] of lists.entries()) {
    const component = page.locator(host);
    const row = component.locator(".ui-nav-row").first();
    expect((await row.locator(".ui-nav-row-label").boundingBox())?.x).toBeGreaterThan(positions[index] ?? 0);
    await expect(row.locator(".ui-nav-row-label")).toHaveCSS("color", "rgb(200, 210, 220)");
    await expect(row.locator(".ui-nav-row-label")).toHaveCSS("white-space", "normal");
  }
  const screenshot = test.info().outputPath("navigation-themed.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("navigation-themed", { path: screenshot, contentType: "image/png" });
});

// Each locator crosses the real consumer's registered shadow root. The disclosure
// also exercises the rolled-up attention of an unmounted, collapsed agent child.
function interventionCues(page: Page) {
  return [
    page.locator("machine-switcher .machine-switcher-button"),
    ...lists.map(({ host }) => page.locator(host).locator(".ui-nav-row").first()),
    page.locator("session-list .ui-nav-row-disclosure"),
  ];
}

test("intervention is static, independent of unread, and does not intercept navigation actions", async ({ page }) => {
  for (const unread of [false, true, false]) {
    await page.evaluate((value) => window.navigationFixture.intervention(value), unread);
    for (const cue of interventionCues(page)) {
      const mark = cue.locator(".activity-indicator.intervention-required");
      await expect(mark).toHaveCount(1);
      await expect(mark).toHaveCSS("animation-name", "none");
      await expect(cue.getByRole("img", { name: /Needs input/ })).toHaveCount(1);
      await expect(cue.locator(".unread-ring")).toHaveCount(unread ? 1 : 0);
      // Intervention wins over simultaneous working; it is not another work dot.
      await expect(cue.locator(".activity-indicator.session")).toHaveCount(0);
    }
    for (const { host } of lists) {
      const row = page.locator(host).locator(".ui-nav-row").first();
      await expect(row).toHaveAttribute("data-activity", "intervention-required");
      await expect(row).toHaveAttribute("data-unread", String(unread));
    }
  }
  const sessionRow = page.locator('session-list [data-session-id="s1"]');
  await expect(sessionRow).toHaveAttribute("data-busy", "true");
  await expect(page.locator('session-list [data-session-id="agent"]')).toHaveCount(0);
  const disclosure = page.locator("session-list .ui-nav-row-disclosure");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  // Click the painted cue, not a forced click or a synthetic DOM event.
  for (const { host, context, first } of lists) {
    const row = page.locator(host).locator(".ui-nav-row").first();
    await row.locator(".intervention-required").click();
    await expect(page.locator("#last-selected")).toHaveText(`${context}:${first}`);
    const action = row.locator(".ui-nav-row-action");
    await action.click();
    await expect(action).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
  }
  await disclosure.locator(".intervention-required").click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('session-list [data-session-id="agent"]')).toHaveAttribute("data-activity", "intervention-required");
  await page.locator("machine-switcher .intervention-required").first().click();
  await expect(page.locator("machine-switcher .machine-switcher-button")).toHaveAttribute("aria-expanded", "true");
});

test("contributed unlayered themes replace or hide intervention cues and clearing restores base", async ({ page }) => {
  await page.evaluate(() => window.navigationFixture.intervention(true));
  const cues = interventionCues(page);
  const marks = cues.map((cue) => cue.locator(".activity-indicator.intervention-required"));
  const appearance = (mark: Locator) => mark.evaluate((element) => {
    const style = getComputedStyle(element);
    return { border: style.border, background: style.backgroundColor, radius: style.borderRadius, opacity: style.opacity };
  });
  const base = await Promise.all(marks.map(appearance));
  // One class is deliberately less specific than the base's compound selectors.
  await page.route("**/intervention-theme.css", (route) => route.fulfill({
    contentType: "text/css",
    body: `.activity-indicator { border: 2px dashed rgb(240, 80, 120); background: rgb(20, 180, 210); border-radius: 0; }`,
  }));
  await page.evaluate(() => window.navigationFixture.applyTheme(new URL("intervention-theme.css", location.href).href));
  for (const mark of marks) {
    await expect(mark).toHaveCSS("border-top-color", "rgb(240, 80, 120)");
    await expect(mark).toHaveCSS("border-top-style", "dashed");
    await expect(mark).toHaveCSS("background-color", "rgb(20, 180, 210)");
    await expect(mark).toHaveCSS("border-radius", "0px");
  }
  await page.route("**/hidden-intervention-theme.css", (route) => route.fulfill({
    contentType: "text/css", body: `.activity-indicator { opacity: 0; }`,
  }));
  await page.evaluate(() => window.navigationFixture.applyTheme(new URL("hidden-intervention-theme.css", location.href).href));
  for (const [index, cue] of cues.entries()) {
    const mark = marks[index];
    if (!mark) throw new Error("Missing intervention cue");
    await expect(mark).toHaveCSS("opacity", "0");
    // Hiding the paint must not remove the accessible status or unread signal.
    await expect(cue.getByRole("img", { name: /Needs input/ })).toHaveCount(1);
    await expect(cue.locator(".unread-ring")).toHaveCount(1);
  }
  for (const { host } of lists) {
    const row = page.locator(host).locator(".ui-nav-row").first();
    await expect(row).toHaveAttribute("data-activity", "intervention-required");
    await expect(row).toHaveAttribute("data-unread", "true");
  }
  await page.evaluate(() => { window.navigationFixture.clearTheme(); });
  expect(await Promise.all(marks.map(appearance))).toEqual(base);
  for (const mark of marks) await expect(mark).toHaveCSS("animation-name", "none");
});
