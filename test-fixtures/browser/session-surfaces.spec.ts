import { expect, test } from "@playwright/test";
import type { StatusBar } from "../../src/client/src/components/StatusBar";
import type { PromptEditor } from "../../src/client/src/components/PromptEditor";

test.beforeEach(async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("loading and loaded statistics keep composer controls above the reserved safe area", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  const safeArea = 36;
  await page.evaluate(async (safeArea) => {
    await window.overlayFixture.applyTheme("playground:playground-dark");
    await window.overlayFixture.mountStatistics(safeArea);
  }, safeArea);
  const editor = page.locator("prompt-editor");
  const footer = page.locator("status-bar");
  const usableBottom = (page.viewportSize()?.height ?? 0) - safeArea;
  const expectSafeComposer = async () => {
    const box = await editor.boundingBox();
    if (!box) throw new Error("Missing composer");
    expect(box.y + box.height).toBeLessThanOrEqual(usableBottom + 1);
    await editor.locator('[data-composer-action="send"]').click();
    return box;
  };
  await expectSafeComposer();
  await footer.evaluate(async (element: StatusBar) => {
    const status = {
      sessionId: "browser-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const editor = element.parentElement?.querySelector<PromptEditor>("prompt-editor");
    if (!editor) throw new Error("Missing composer");
    element.status = status;
    editor.status = status;
    await Promise.all([element.updateComplete, editor.updateComplete]);
  });
  const composer = await expectSafeComposer();
  const statistics = await footer.locator(".bar").boundingBox();
  if (!statistics) throw new Error("Missing statistics");
  expect(statistics.y).toBeGreaterThanOrEqual(composer.y + composer.height - 1);
  expect(statistics.y + statistics.height).toBeGreaterThan(usableBottom);
  expect(statistics.y + statistics.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
});

test("moved Notices content scrolls and its last dismiss action remains reachable under Playground", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.evaluate(async () => {
    await window.overlayFixture.applyTheme("playground:playground-dark");
    await window.overlayFixture.mountNotices();
  });
  const panel = page.locator("session-notices-panel");
  expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Dismiss warning", exact: true }).last().click();
  await expect(page.locator("#notices-boundary")).toHaveAttribute("data-dismissed", "true");
  expect(await panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
