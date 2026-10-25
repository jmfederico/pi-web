import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/navigation.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("dragging a project row above the first row moves it to the top", async ({ page, isMobile }) => {
  test.skip(isMobile, "Touch reordering is not implemented yet.");
  const rows = page.locator("project-list .action-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText("Project A");

  const first = await rows.first().boundingBox();
  const last = await rows.last().boundingBox();
  if (first === null || last === null) throw new Error("Expected row geometry");

  await page.mouse.move(last.x + 40, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 40, first.y + 2, { steps: 10 });

  await expect(rows.filter({ has: page.locator(".action-main") }).first()).toBeVisible();
  await expect(page.locator("project-list .action-row.drop-before")).toHaveCount(1);
  const ghost = page.locator(".pi-drag-ghost");
  await expect(ghost).toHaveCount(1);
  const ghostBox = await ghost.boundingBox();
  expect(ghostBox?.y).toBeLessThan(first.y + first.height);
  await page.mouse.up();
  await expect(ghost).toHaveCount(0);

  await expect(rows.first()).toContainText("Project D");
  await expect(page.locator("project-list .action-row.drop-before")).toHaveCount(0);
});

test("a drag that ends on the same row selects instead of reordering", async ({ page, isMobile }) => {
  test.skip(isMobile, "Touch reordering is not implemented yet.");
  const rows = page.locator("project-list .action-row");
  const second = await rows.nth(1).boundingBox();
  if (second === null) throw new Error("Expected row geometry");

  await page.mouse.move(second.x + 40, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + 40, second.y + second.height / 2 + 2);
  await page.mouse.up();

  await expect(rows.first()).toContainText("Project A");
  await expect(page.locator("project-list .action-row.drop-before, project-list .action-row.drop-after")).toHaveCount(0);
});

test("dragging to the bottom edge scrolls the list and drops beyond the fold", async ({ page, isMobile }) => {
  test.skip(isMobile, "Touch reordering is not implemented yet.");
  await page.goto("/navigation.html?count=12&height=220");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const rows = page.locator("project-list .action-row");
  await expect(rows).toHaveCount(12);
  const body = page.locator("project-list .list-body");
  const scrollTop = () => body.evaluate((element) => element.scrollTop);
  await expect.poll(scrollTop).toBe(0);

  const first = await rows.first().boundingBox();
  const bodyBox = await body.boundingBox();
  if (first === null || bodyBox === null) throw new Error("Expected row geometry");

  await page.mouse.move(first.x + 40, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 40, bodyBox.y + bodyBox.height - 6, { steps: 5 });

  await expect.poll(scrollTop, { timeout: 5000 }).toBeGreaterThan(100);
  await expect.poll(() => body.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1), { timeout: 5000 }).toBe(true);
  await page.mouse.up();

  await expect(rows).toHaveCount(12);
  await expect(rows.first()).not.toContainText("Project A");
  await expect(rows.last()).toContainText("Project A");
});

test("a long press lifts the row and moves it where the finger releases", async ({ page }) => {
  await page.goto("/navigation.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const rows = page.locator("project-list .action-row");
  const first = await rows.first().boundingBox();
  const last = await rows.last().boundingBox();
  if (first === null || last === null) throw new Error("Expected row geometry");
  const touch = { pointerId: 7, pointerType: "touch", button: 0, clientX: last.x + 40, bubbles: true };

  await rows.last().dispatchEvent("pointerdown", { ...touch, clientY: last.y + last.height / 2 });
  await expect(page.locator(".pi-drag-ghost")).toHaveCount(0);
  await page.waitForTimeout(450);
  await expect(page.locator(".pi-drag-ghost")).toHaveCount(1);

  await rows.last().dispatchEvent("pointermove", { ...touch, clientY: first.y + 2 });
  await rows.last().dispatchEvent("pointerup", { ...touch, clientY: first.y + 2 });

  await expect(rows.first()).toContainText("Project D");
  await expect(page.locator(".pi-drag-ghost")).toHaveCount(0);
});
