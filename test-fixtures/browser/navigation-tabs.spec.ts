import { expect, test, type Locator, type Page } from "@playwright/test";

const initialOrder = ["chat", "fixture:tasks", "fixture:workspaces", "fixture:notices", "fixture:terminal"];
const rows = (page: Page) => page.locator("navigation-dialog .destination[data-reorder-id]");
const row = (page: Page, id: string) => page.locator(`navigation-dialog .destination[data-reorder-id="${id}"]`);
const preview = (page: Page) => page.locator("navigation-dialog .list-drag-preview");

async function open(page: Page, query = "") {
  await page.goto(`/navigation-tabs.html${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.locator("navigation-dialog dialog")).toBeVisible();
  expect(await page.locator("navigation-dialog dialog").evaluate((element) => element.matches(":modal"))).toBe(true);
}

async function order(page: Page) {
  return rows(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-reorder-id")));
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Missing navigation geometry");
  return bounds;
}

async function startDrag(page: Page, source: Locator, target: Locator, edge: "before" | "after") {
  const handle = await box(source.locator(".reorder-handle"));
  const destination = await box(target);
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  // Stay away from the list's autoscroll edge while targeting the row's half.
  const end = { x: start.x, y: destination.y + (edge === "before" ? 8 : destination.height - 8) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(preview(page)).toBeVisible();
  await expect(target).toHaveClass(new RegExp(`drop-${edge}`));
  return { start, end };
}

for (const width of [1280, 360]) {
  test(`native modal at ${String(width)}px: handle drag paints a row preview and lands without navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const source = row(page, "fixture:workspaces");
    const target = row(page, "chat");
    await source.scrollIntoViewIfNeeded();
    const sourceBox = await box(source);
    // Real actionability checks catch clipping/overlap, including long labels on narrow screens.
    for (const selector of [".reorder-handle", ".destination-button", ".move-up", ".move-down", ".pin-button"]) {
      const control = source.locator(selector);
      expect(await control.evaluate((element) => element instanceof HTMLButtonElement)).toBe(true);
      await control.click({ trial: true });
    }
    const geometry = await source.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      const list = element.closest("nav");
      if (!list) throw new Error("Missing navigation scroller");
      return {
        inViewport: bounds.left >= 0 && bounds.right <= innerWidth,
        noOverflow: list.scrollWidth <= list.clientWidth,
        separated: controls.every((control, index) => control.left >= bounds.left && control.right <= bounds.right + 1 && (index === 0 || control.left >= (controls[index - 1]?.right ?? 0) - 1)),
      };
    });
    expect(geometry).toEqual({ inViewport: true, noOverflow: true, separated: true });
    const { start, end } = await startDrag(page, source, target, "before");
    const ghost = preview(page);
    expect(await ghost.evaluate((element) => element.matches(":popover-open"))).toBe(true);
    await expect(ghost.locator(".destination-button")).toHaveText(await source.locator(".destination-button").innerText());
    const ghostBox = await box(ghost);
    const targetBox = await box(target);
    // The top-layer preview uses viewport coordinates even inside a native modal,
    // and leaves both ends of the insertion line exposed rather than covering it.
    expect(Math.abs(ghostBox.y - (end.y - (start.y - sourceBox.y)))).toBeLessThanOrEqual(2);
    expect(ghostBox.x).toBeGreaterThan(targetBox.x);
    expect(ghostBox.x + ghostBox.width).toBeLessThan(targetBox.x + targetBox.width);
    expect(ghostBox.x + ghostBox.width).toBeLessThanOrEqual(width);
    expect(await ghost.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const screenshot = test.info().outputPath(`navigation-tabs-${String(width)}.png`);
    await page.screenshot({ path: screenshot });
    await test.info().attach("navigation-tabs-drag", { path: screenshot, contentType: "image/png" });
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual(["fixture:workspaces", "chat", "fixture:tasks", "fixture:notices", "fixture:terminal"]);
    await expect(source.locator(".reorder-handle")).toBeFocused();
    await expect(page.locator("#selected")).toBeEmpty();
    await expect(page.locator("navigation-dialog dialog")).toBeVisible();
    await expect(ghost).toHaveCount(0);
    await expect(page.locator("navigation-dialog .list-reorder-status")).not.toBeEmpty();
    await startDrag(page, source, row(page, "fixture:terminal"), "after");
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual(["chat", "fixture:tasks", "fixture:notices", "fixture:terminal", "fixture:workspaces"]);
    await expect(source.locator(".reorder-handle")).toBeFocused();
    await expect(page.locator("#selected")).toBeEmpty();
    await expect(preview(page)).toHaveCount(0);
    await expect(page.locator("navigation-dialog .drop-before, navigation-dialog .drop-after")).toHaveCount(0);
  });
}

test("keyboard moves keep focus on the moved item, including boundary moves", async ({ page }) => {
  await open(page);
  const tasks = row(page, "fixture:tasks");
  await tasks.locator(".move-down").focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual(["chat", "fixture:workspaces", "fixture:tasks", "fixture:notices", "fixture:terminal"]);
  await expect(tasks.locator(".move-down")).toBeFocused();
  await tasks.locator(".move-up").focus();
  await page.keyboard.press("Space");
  await expect.poll(() => order(page)).toEqual(initialOrder);
  await expect(tasks.locator(".move-up")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => order(page)).toEqual(["fixture:tasks", "chat", "fixture:workspaces", "fixture:notices", "fixture:terminal"]);
  await expect(tasks.locator(".move-up")).toBeDisabled();
  await expect(tasks.locator(".reorder-handle")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => order(page)).toEqual(initialOrder);
  await expect(tasks.locator(".reorder-handle")).toBeFocused();
  await expect(page.locator("#selected")).toBeEmpty();
  // Navigation remains a separate action, not an accidental consequence of moving.
  await tasks.locator(".destination-button").press("Enter");
  await expect(page.locator("#selected")).toHaveText("fixture:tasks");
  await expect(page.locator("navigation-dialog")).toHaveCount(0);
});

test("closing a shortcut-opened dialog restores focus to the same destination after reordering", async ({ page }) => {
  await page.goto("/navigation-tabs.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const tasks = page.locator("app-mobile-main-tabs").getByRole("button", { name: "Tasks", exact: true });
  await tasks.focus();
  await page.keyboard.press("Alt+n");
  await expect(page.locator("navigation-dialog dialog")).toBeVisible();
  await row(page, "fixture:workspaces").locator(".move-up").click();
  const strip = page.locator("app-mobile-main-tabs .mobile-tabs button");
  await expect(strip.nth(1)).toHaveAttribute("aria-label", /^Workspaces/);
  await expect(strip.nth(2)).toHaveAttribute("aria-label", "Tasks");
  await page.keyboard.press("Escape");
  await expect(page.locator("navigation-dialog")).toHaveCount(0);
  await expect(tasks).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#selected")).toHaveText("fixture:tasks");
});

test("reordered and unpinned destinations survive reload and feed the real tab strip", async ({ page }) => {
  await open(page);
  await row(page, "fixture:tasks").locator(".move-up").click();
  await row(page, "fixture:workspaces").locator(".move-up").click();
  await row(page, "fixture:workspaces").locator(".move-up").click();
  await row(page, "chat").locator(".pin-button").click();
  await expect(row(page, "chat").locator(".pin-button")).toHaveAttribute("aria-pressed", "false");
  const expected = ["fixture:workspaces", "fixture:tasks", "chat", "fixture:notices", "fixture:terminal"];
  await expect.poll(() => order(page)).toEqual(expected);
  // Reload, rather than re-opening the same component, exercises save/load storage.
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const buttons = page.locator("app-mobile-main-tabs .mobile-tabs button");
  await expect(buttons).toHaveCount(4);
  expect(await buttons.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label"))))
    .toEqual(["Workspaces with a long destination label that must leave every action reachable", "Tasks", "Notices", "Terminal"]);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.poll(() => order(page)).toEqual(expected);
  await expect(row(page, "chat").locator(".pin-button")).toHaveAttribute("aria-pressed", "false");
  await row(page, "chat").locator(".pin-button").click();
  await page.keyboard.press("Escape");
  await expect(buttons.nth(1)).toHaveAttribute("aria-label", "Tasks");
  await expect(buttons.nth(2)).toHaveAttribute("aria-label", "Chat");
  await buttons.nth(2).click();
  await expect(page.locator("#selected")).toHaveText("chat");
});

test("reset restores default order after reload without changing pins or mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await row(page, "fixture:tasks").locator(".move-up").click();
  await row(page, "chat").locator(".pin-button").click();
  await page.getByRole("button", { name: "Collapsed", exact: true }).click();
  const reset = page.getByRole("button", { name: "Reset order", exact: true });
  await reset.click();
  await expect.poll(() => order(page)).toEqual(initialOrder);
  await expect(reset).toBeFocused();
  await expect(page.locator("#selected")).toBeEmpty();
  await expect(row(page, "chat").locator(".pin-button")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Collapsed", exact: true })).toHaveAttribute("aria-pressed", "true");
  const screenshot = test.info().outputPath("navigation-reset-360.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("navigation-reset", { path: screenshot, contentType: "image/png" });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.poll(() => order(page)).toEqual(initialOrder);
  await expect(row(page, "chat").locator(".pin-button")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Collapsed", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("search disables drag and move controls without changing the saved order", async ({ page }) => {
  await open(page);
  const tasks = row(page, "fixture:tasks");
  await tasks.locator(".move-up").click();
  const expected = ["fixture:tasks", "chat", "fixture:workspaces", "fixture:notices", "fixture:terminal"];
  const search = page.locator("navigation-dialog input");
  await search.fill("a");
  await expect(rows(page)).toHaveCount(4);
  for (const selector of [".reorder-handle", ".move-up", ".move-down"]) {
    for (const control of await rows(page).locator(selector).all()) await expect(control).toBeDisabled();
  }
  const handle = await box(tasks.locator(".reorder-handle"));
  const target = await box(row(page, "chat"));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, target.y + target.height - 8, { steps: 8 });
  await expect(preview(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("#selected")).toBeEmpty();
  await search.fill("");
  await expect.poll(() => order(page)).toEqual(expected);
  await expect(tasks.locator(".reorder-handle")).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect.poll(() => order(page)).toEqual(expected);
});

test("a stale browser tab changes only its chosen preference and can explicitly reset order", async ({ page, context }) => {
  await open(page);
  const other = await context.newPage();
  try {
    await open(other);
    await row(page, "fixture:tasks").locator(".move-up").click();
    await other.getByRole("button", { name: "Collapsed", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect.poll(() => order(page)).toEqual(["fixture:tasks", "chat", "fixture:workspaces", "fixture:notices", "fixture:terminal"]);
    await expect(page.getByRole("button", { name: "Collapsed", exact: true })).toHaveAttribute("aria-pressed", "true");
    await row(page, "chat").locator(".pin-button").click();
    // The stale dialog still displays the default order and old pins; reset must
    // remain explicit without replacing the other tab's newer visibility edit.
    await expect.poll(() => order(other)).toEqual(initialOrder);
    await other.getByRole("button", { name: "Reset order", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect.poll(() => order(page)).toEqual(initialOrder);
    await expect(row(page, "chat").locator(".pin-button")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Collapsed", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await other.close();
  }
});

test("save failures are visible inside the open dialog and clear after recovery", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  // Preserve the native method for restoration, not for an unbound invocation.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSetItem = await page.evaluateHandle(() => Storage.prototype.setItem);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
  });
  await row(page, "fixture:tasks").locator(".move-up").click();
  const dialog = page.locator("navigation-dialog");
  const warning = dialog.getByRole("alert");
  await expect(dialog.locator("dialog")).toBeVisible();
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/reload/);
  await expect(dialog.locator(".list-reorder-status")).toBeEmpty();
  await expect.poll(() => order(page)).toEqual(["fixture:tasks", "chat", "fixture:workspaces", "fixture:notices", "fixture:terminal"]);
  const screenshot = test.info().outputPath("navigation-save-failure-360.png");
  await page.screenshot({ path: screenshot });
  await test.info().attach("navigation-save-failure", { path: screenshot, contentType: "image/png" });
  await page.evaluate((original) => { Storage.prototype.setItem = original; }, originalSetItem);
  await originalSetItem.dispose();
  await dialog.getByRole("button", { name: "Reset order", exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(dialog.locator(".list-reorder-status")).not.toBeEmpty();
  await expect.poll(() => order(page)).toEqual(initialOrder);
});

test("the fully visible final row keeps its midpoint drop target at the end of a scrolled list", async ({ page }) => {
  await open(page, "?long");
  const list = page.locator("navigation-dialog nav.options");
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const source = row(page, "fixture:extra-21");
  const last = row(page, "fixture:extra-23");
  const handle = await box(source.locator(".reorder-handle"));
  const bounds = await box(last);
  const listBounds = await box(list);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(listBounds.y + listBounds.height + 1);
  const x = handle.x + handle.width / 2;
  // This point is above the midpoint but inside the bottom autoscroll zone.
  const y = bounds.y + bounds.height / 2 - 4;
  expect(y).toBeGreaterThan(listBounds.y + listBounds.height - 36);
  await page.mouse.move(x, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await expect(last).toHaveClass(/drop-before/);
  await page.mouse.up();
  await expect.poll(async () => (await order(page)).slice(-3)).toEqual(["fixture:extra-22", "fixture:extra-21", "fixture:extra-23"]);
  await startDrag(page, source, last, "after");
  await page.mouse.up();
  await expect.poll(async () => (await order(page)).slice(-3)).toEqual(["fixture:extra-22", "fixture:extra-23", "fixture:extra-21"]);
});

test("native touch: a handle swipe scrolls; a held handle reorders and then releases scrolling", async ({ page, context, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || !isMobile, "Native touch injection uses Chromium CDP in the touch profile.");
  await open(page, "?long");
  const client = await context.newCDPSession(page);
  const list = page.locator("navigation-dialog nav.options");
  const touch = async (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => {
    await client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  };
  const swipe = async () => {
    const handle = await box(row(page, "fixture:tasks").locator(".reorder-handle"));
    const bounds = await box(list);
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await touch("touchStart", x, y);
    for (let next = y - 20; next >= bounds.y + 4; next -= 20) await touch("touchMove", x, next);
    await touch("touchEnd", x, bounds.y + 4);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(preview(page)).toHaveCount(0);
  };
  try {
    await swipe();
    expect((await order(page)).slice(0, 5)).toEqual(initialOrder);
    await expect(page.locator("#selected")).toBeEmpty();
    // A fresh document avoids native scroll inertia leaking into the hold gesture.
    await open(page, "?long");
    const handle = await box(row(page, "fixture:tasks").locator(".reorder-handle"));
    const target = await box(row(page, "chat"));
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await touch("touchStart", x, y);
    // Real touch drift exercises implicit descendant capture before the 350ms lift.
    await touch("touchMove", x, y + 2);
    await expect(preview(page)).toBeVisible();
    await touch("touchMove", x, target.y + 8);
    await expect(row(page, "chat")).toHaveClass(/drop-before/);
    await touch("touchEnd", x, target.y + 8);
    await expect.poll(async () => (await order(page)).slice(0, 2)).toEqual(["fixture:tasks", "chat"]);
    await expect(preview(page)).toHaveCount(0);
    await expect(page.locator("#selected")).toBeEmpty();
    // Start from a lower visible destination, without reloading away drag cleanup.
    const button = await box(row(page, "fixture:workspaces").locator(".destination-button"));
    const bounds = await box(list);
    const sx = button.x + button.width / 2;
    const sy = Math.min(button.y + button.height / 2, bounds.y + bounds.height - 8);
    await touch("touchStart", sx, sy);
    for (let next = sy - 20; next >= bounds.y + 4; next -= 20) await touch("touchMove", sx, next);
    await touch("touchEnd", sx, bounds.y + 4);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(preview(page)).toHaveCount(0);
    await expect(page.locator("#selected")).toBeEmpty();
  } finally {
    await client.detach();
  }
});
