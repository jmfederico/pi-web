import { expect, test } from "@playwright/test";

const lists = [
  { host: "project-list", context: "projects", second: "p2" },
  { host: "workspace-list", context: "workspaces", second: "w2" },
  { host: "session-list", context: "sessions", second: "s2" },
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
  await page.evaluate(() => { window.navigationFixture.applyTheme(); });
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
