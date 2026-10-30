import { expect, test, type Page } from "@playwright/test";

async function addTheme(page: Page, host: string, css: string): Promise<void> {
  await page.locator(host).evaluate((element, css) => {
    const root = element.shadowRoot;
    if (!root) throw new Error("Missing themed root");
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }, css);
}

async function ready(page: Page, fixture: string): Promise<void> {
  await page.goto(fixture);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
}

test("theme-grown action panels stay within the viewport without moving navigation rows", async ({ page }) => {
  await ready(page, "/navigation.html");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Missing viewport");
  for (const [host, context] of [["project-list", "project-actions"], ["workspace-list", "workspace-actions"], ["session-list", "session-actions"]] as const) {
    const owner = page.locator(host);
    const row = owner.locator(".ui-nav-row").first();
    const trigger = row.locator(".ui-popup-trigger");
    const before = await row.boundingBox();
    const selection = await page.locator("#last-selected").textContent();
    await trigger.click();
    const panel = owner.locator(`.ui-popup-panel[data-ui-context="${context}"]`);
    await expect(panel).toBeVisible();
    expect(await page.locator("#last-selected").textContent()).toBe(selection);
    // Exercise real border-box sizing and the popup controller's constraints,
    // rather than asserting that CSS produces the pixels declared below.
    await addTheme(page, host, ".ui-popup-panel { border-width: 5px; padding: 4px; }");
    await expect.poll(async () => {
      const box = await panel.boundingBox();
      return box !== null && box.x >= 0 && box.y >= 0
        && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
    }).toBe(true);
    expect(await row.boundingBox()).toEqual(before);
    await panel.locator("button.ui-menu-item:not(:disabled)").first().focus();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(panel).toHaveCount(0);
  }
});

test("the current-picker hook permits a less-specific theme override without following keyboard focus", async ({ page }) => {
  await ready(page, "/overlays.html");
  const owner = page.locator("machine-switcher").first();
  await addTheme(page, ".clip machine-switcher", '.ui-menu-item[data-current="true"] { background-color: rgb(31, 41, 51); }');
  await owner.locator(".ui-popup-trigger").first().press("ArrowDown");
  const picker = owner.locator('[data-ui-context="machine-picker"]');
  const current = picker.locator('.ui-menu-item[data-current="true"]');
  const other = picker.locator('.ui-menu-item[data-current="false"]');
  const id = await current.getAttribute("data-machine-id");
  // This sentinel must win over the more-specific local selected-state rule.
  await expect(current).toHaveCSS("background-color", "rgb(31, 41, 51)");
  await current.press("ArrowDown");
  await expect(other).toBeFocused();
  await expect(current).toHaveAttribute("data-machine-id", id ?? "");
  await expect(other).not.toHaveCSS("background-color", "rgb(31, 41, 51)");
});

test("Playground menu cues survive theme changes and forced colours without adding a gutter", async ({ page }) => {
  await ready(page, "/overlays.html");
  const owner = page.locator("machine-switcher").first();
  await owner.locator(".ui-popup-trigger").first().click();
  const current = owner.locator('[data-ui-context="machine-picker"] .ui-menu-item[data-current="true"]');
  const before = await current.boundingBox();
  const cue = (element: Element) => {
    const style = getComputedStyle(element, "::after");
    return { content: style.content, border: parseFloat(style.borderInlineStartWidth) };
  };
  for (const scheme of ["dark", "light"]) {
    await page.evaluate((id) => window.overlayFixture.applyTheme(id), `playground:playground-${scheme}`);
    expect((await current.evaluate(cue)).content).not.toBe("none");
    expect((await current.evaluate(cue)).border).toBeGreaterThan(0);
    expect(await current.boundingBox()).toEqual(before);
    await owner.locator(".ui-popup-trigger").nth(1).click();
    const nested = owner.locator('[data-ui-context="machine-actions"]');
    await expect(nested.locator(".ui-menu-item.danger")).not.toHaveCSS("text-decoration-line", "none");
    const path = test.info().outputPath(`menus-${scheme}.png`);
    await page.screenshot({ path });
    await test.info().attach(`menus-${scheme}`, { path, contentType: "image/png" });
    await page.keyboard.press("Escape");
  }
  await owner.evaluate((element) => { element.setAttribute("dir", "rtl"); });
  expect(await current.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return parseFloat(style.right) < parseFloat(style.left);
  })).toBe(true);
  await page.emulateMedia({ forcedColors: "active" });
  expect((await current.evaluate(cue)).border).toBeGreaterThan(0);
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => window.overlayFixture.applyTheme("themes:pi-web-dark"));
  expect((await current.evaluate(cue)).content).toBe("none");
  await owner.locator(".ui-popup-trigger").nth(1).click();
  await expect(owner.locator('[data-ui-context="machine-actions"] .danger')).toHaveCSS("text-decoration-line", "none");
});
