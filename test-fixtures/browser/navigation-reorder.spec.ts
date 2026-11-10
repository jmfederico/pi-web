import { expect, test, type Locator, type Page } from "@playwright/test";

async function open(page: Page, query = "") {
  await page.goto(`/navigation-reorder.html${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
}

async function point(row: Locator, edge: "top" | "middle" | "bottom" = "middle") {
  const box = await row.boundingBox();
  if (!box) throw new Error("Missing row geometry");
  return { x: box.x + 40, y: box.y + (edge === "top" ? 4 : edge === "bottom" ? box.height - 4 : box.height / 2) };
}

async function drag(page: Page, from: Locator, to: Locator, edge: "top" | "bottom") {
  const start = await point(from);
  const end = await point(to, edge);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function order(page: Page) {
  return page.locator("[data-reorder-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-reorder-id")));
}

for (const kind of ["projects", "workspaces", "sessions"]) {
  test(`${kind}: dragging applies the requested order without selecting; session children stay attached`, async ({ page }) => {
    await open(page, `?list=${kind}`);
    await drag(page, page.locator('[data-reorder-id="3"]'), page.locator('[data-reorder-id="1"]'), "top");
    await expect.poll(() => order(page)).toEqual(["3", "1", "2"]);
    await expect(page.locator("#selected")).toBeEmpty();
    await expect(page.locator(".list-drag-preview")).toHaveCount(0);
    await expect(page.locator(".list-reorder-status")).not.toBeEmpty();
    if (kind === "sessions") {
      await expect(page.locator('[data-session-id="child"]')).toBeVisible();
      expect(await page.locator("[data-session-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id"))))
        .toEqual(["3", "1", "2", "child", "unpinned"]);
      await drag(page, page.locator('[data-reorder-id="2"]'), page.locator('[data-reorder-id="3"]'), "top");
      expect(await page.locator("[data-session-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id"))))
        .toEqual(["2", "child", "3", "1", "unpinned"]);
    }
  });
}

test("row text resists native selection while the project menu path remains selectable and copyable", async ({ page }) => {
  await open(page);
  const row = page.locator('[data-reorder-id="1"]');
  await row.locator(".ui-nav-row-label").dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await row.locator(".action-menu-toggle").click();
  const menu = row.locator(".action-menu-panel");
  const path = menu.locator(".workspace-detail-row dd bdi");
  await path.dblclick();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).not.toBe("");
  // Browser hit targeting and menu feedback are real; clipboard permission is a controlled boundary.
  await page.evaluate(() => {
    navigator.clipboard.writeText = (text: string) => {
      document.body.dataset["copiedText"] = text;
      return Promise.resolve();
    };
  });
  await menu.getByRole("button", { name: "Copy path", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-copied-text", "/repo/1");
  await expect(menu.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await expect(menu).toBeVisible();
  const screenshot = test.info().outputPath("project-path-menu.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("project-path-menu", { path: screenshot, contentType: "image/png" });
});

for (const kind of ["project", "workspace", "session", "machine"]) {
  test(`${kind}: menu groups separate actions, options and selectable details`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, `?list=${kind}s&details`);
    await page.locator(".action-menu-toggle").first().click();
    const menu = page.locator(".action-menu-panel");
    const groups = menu.locator(":scope > [data-menu-group]");
    const hasOptions = kind === "project" || kind === "workspace";
    expect(await groups.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-menu-group"))))
      .toEqual(hasOptions ? ["actions", "options", "details"] : ["actions", "details"]);
    expect(await groups.evaluateAll((elements) => elements.map((element) => getComputedStyle(element).borderBlockStartWidth)))
      .toEqual(hasOptions ? ["0px", "1px", "1px"] : ["0px", "1px"]);
    expect(await menu.locator(".ui-menu-item").evaluateAll((elements) => elements.every((element) => getComputedStyle(element).boxShadow === "none"))).toBe(true);
    if (hasOptions) await expect(menu.locator('[data-menu-group="options"]').getByRole("checkbox")).toBeVisible();
    if (kind === "project") await expect(menu.locator('[data-menu-group="actions"]').getByRole("button", { name: "Close project", exact: true })).toBeVisible();
    const id = "01234567-89ab-cdef-0123-000000000001";
    const copyId = menu.locator("[data-id-detail]");
    await expect(copyId).not.toContainText(id);
    await expect(copyId.getByRole("button", { name: `Copy ${kind} ID`, exact: true })).toBeVisible();
    expect(await menu.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    expect(await menu.locator("dd").evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    const screenshot = test.info().outputPath(`${kind}-menu.png`);
    await page.screenshot({ path: screenshot });
    await test.info().attach(`${kind}-menu`, { path: screenshot, contentType: "image/png" });
    await page.evaluate(() => {
      navigator.clipboard.writeText = (text: string) => {
        document.body.dataset["copiedText"] = text;
        return Promise.resolve();
      };
    });
    await menu.getByRole("button", { name: `Copy ${kind} ID`, exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-copied-text", id);
    await expect(menu.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await expect(menu).toBeVisible();
    await expect(page.locator("#selected")).toBeEmpty();
  });
}

for (const kind of ["machine", "workspace"]) {
  test(`${kind}: absent actions leave no empty group or leading divider`, async ({ page }) => {
    await open(page, `?list=${kind}s&noactions`);
    await page.locator(".action-menu-toggle").first().click();
    const groups = page.locator(".action-menu-panel > [data-menu-group]");
    expect(await groups.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-menu-group"))))
      .toEqual(kind === "machine" ? ["details"] : ["options", "details"]);
    await expect(groups.first()).toHaveCSS("border-block-start-width", "0px");
  });
}

test("a pinned tree's append marker lands after its children", async ({ page }) => {
  await open(page, "?list=sessions");
  await drag(page, page.locator('[data-reorder-id="3"]'), page.locator('[data-reorder-id="1"]'), "top");
  const start = await point(page.locator('[data-reorder-id="3"]'));
  const end = await point(page.locator('[data-session-id="child"]'), "bottom");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  const root = page.locator('[data-reorder-id="2"]');
  await expect(root).toHaveClass(/drop-after/);
  const boundary = await root.evaluate((element) => {
    const row = element.getBoundingClientRect();
    return row.top + parseFloat(getComputedStyle(element, "::after").top);
  });
  const child = await page.locator('[data-session-id="child"]').boundingBox();
  if (!child) throw new Error("Missing child geometry");
  expect(Math.abs(boundary - (child.y + child.height))).toBeLessThanOrEqual(3);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(["1", "2", "3"]);
  expect(await page.locator("[data-session-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id"))))
    .toEqual(["1", "2", "child", "3", "unpinned"]);
});

test("a click and keyboard menu moves remain available; Escape and outside drops cancel", async ({ page }) => {
  await open(page);
  const first = page.locator('[data-reorder-id="1"]');
  await first.click({ position: { x: 40, y: 15 } });
  await expect(page.locator("#selected")).toHaveText("1");
  await first.locator(".action-menu-toggle").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Move down", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual(["2", "1", "3"]);
  await page.keyboard.press("Escape");
  const start = await point(first);
  const end = await point(page.locator('[data-reorder-id="2"]'), "top");
  for (const cancel of ["escape", "outside"]) {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await expect(page.locator(".list-drag-preview")).toBeVisible();
    if (cancel === "escape") await page.keyboard.press("Escape");
    else await page.mouse.move(390, end.y);
    await page.mouse.up();
    await expect(page.locator(".list-drag-preview")).toHaveCount(0);
    expect(await order(page)).toEqual(["2", "1", "3"]);
  }
});

test("edge autoscroll reaches a hidden final row and keeps the insertion target current", async ({ page }) => {
  await open(page, "?long");
  const start = await point(page.locator('[data-reorder-id="1"]'));
  const body = page.locator("project-list .list-body");
  const rect = await body.boundingBox();
  if (!rect) throw new Error("Missing list geometry");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, rect.y + rect.height - 2, { steps: 6 });
  await expect.poll(() => body.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);
  await page.mouse.up();
  await expect.poll(async () => (await order(page)).at(-1)).toBe("1");
});

test("wheel scrolling keeps the insertion marker aligned with the eventual drop", async ({ page }) => {
  await open(page, "?long");
  const body = page.locator("project-list .list-body");
  const start = await point(page.locator('[data-reorder-id="1"]'));
  const end = await point(page.locator('[data-reorder-id="4"]'), "top");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  const marker = page.locator("[data-reorder-id].drop-before");
  await expect(marker).toHaveAttribute("data-reorder-id", "4");
  await page.mouse.wheel(0, 180);
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(marker).not.toHaveAttribute("data-reorder-id", "4");
  const neighborId = await marker.getAttribute("data-reorder-id");
  const markerBox = await marker.boundingBox();
  const bodyBox = await body.boundingBox();
  if (!markerBox || !bodyBox) throw new Error("Missing drop marker geometry");
  expect(markerBox.y).toBeGreaterThanOrEqual(bodyBox.y);
  expect(markerBox.y).toBeLessThan(bodyBox.y + bodyBox.height);
  await page.mouse.up();
  await expect.poll(async () => {
    const ids = await order(page);
    return ids[ids.indexOf("1") + 1];
  }).toBe(neighborId);
  await expect(page.locator(".list-drag-preview")).toHaveCount(0);
  await expect(page.locator("[data-reorder-id].drop-before")).toHaveCount(0);
});

test("the preview retains scoped theme styles and long-label geometry outside containment", async ({ page }) => {
  await open(page);
  await page.route("**/reorder-theme.css", (route) => route.fulfill({
    contentType: "text/css",
    body: ':host { --pi-surface: #fff; --pi-text: #123; --pi-muted: #567; } .ui-nav-list { background: var(--pi-surface); } [data-ui-context="projects"] .ui-nav-row-label { color: rgb(20, 50, 80); }',
  }));
  await page.evaluate(() => window.reorderFixture.applyTheme(new URL("reorder-theme.css", location.href).href));
  const start = await point(page.locator('[data-reorder-id="3"]'));
  const end = await point(page.locator('[data-reorder-id="1"]'), "top");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  const preview = page.locator(".list-drag-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".ui-nav-row-label")).toHaveCSS("color", "rgb(20, 50, 80)");
  const geometry = await preview.evaluate((element) => {
    const label = element.querySelector(".ui-nav-row-label");
    const rect = element.getBoundingClientRect();
    return { top: rect.top, width: rect.width, labelRight: label?.getBoundingClientRect().right, right: rect.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  const source = await page.locator('[data-reorder-id="3"]').boundingBox();
  if (!source) throw new Error("Missing source row");
  // Pointer coordinates are rounded to device pixels by Firefox and WebKit.
  expect(Math.abs(geometry.top - (end.y - source.height / 2))).toBeLessThanOrEqual(1);
  expect(geometry.labelRight).toBeLessThanOrEqual(geometry.right);
  // The opaque top-layer preview must not cover the full landing line.
  const target = await page.locator('[data-reorder-id="1"]').boundingBox();
  const previewBox = await preview.boundingBox();
  if (!target || !previewBox) throw new Error("Missing drag feedback geometry");
  expect(previewBox.x).toBeGreaterThan(target.x + 4);
  expect(previewBox.x + previewBox.width).toBeLessThan(target.x + target.width - 4);
  await expect(page.locator('[data-reorder-id="1"]')).toHaveClass(/drop-before/);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  const screenshot = test.info().outputPath("navigation-drag.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("navigation-drag", { path: screenshot, contentType: "image/png" });
  await page.mouse.up();
});

test("native touch swipes scroll; holding then dragging reorders and releases scroll ownership", async ({ page, context, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || !isMobile, "Native touch injection uses Chromium CDP in the touch profile.");
  await open(page, "?long");
  const client = await context.newCDPSession(page);
  const body = page.locator("project-list .list-body");
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => {
    await client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  };
  const swipe = async () => {
    await touch("touchStart", 80, 330);
    for (let y = 310; y >= 150; y -= 20) await touch("touchMove", 80, y);
    await touch("touchEnd", 80, 150);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator(".list-drag-preview")).toHaveCount(0);
  };
  await swipe();
  // A fresh page avoids inheriting native inertial scrolling into the next gesture.
  await open(page, "?long");
  const start = await point(page.locator('[data-reorder-id="3"]'));
  const end = await point(page.locator('[data-reorder-id="1"]'), "top");
  await touch("touchStart", start.x, start.y);
  // Small finger drift activates implicit capture on the touched descendant
  // without crossing the scroll-intent threshold. Lifting transfers capture to the row.
  await touch("touchMove", start.x, start.y + 2);
  await expect(page.locator(".list-drag-preview")).toBeVisible();
  await touch("touchMove", end.x, end.y);
  await touch("touchEnd", end.x, end.y);
  await expect.poll(async () => (await order(page))[0]).toBe("3");
  await expect(page.locator(".list-drag-preview")).toHaveCount(0);
  await expect(page.locator("#selected")).toBeEmpty();
  await swipe();
});
