import { expect, test, type Page } from "@playwright/test";
import type { PromptEditor } from "../../src/client/src/components/PromptEditor";

type ComposerState = Partial<Pick<PromptEditor, "canSteer" | "defaultStreamingBehavior" | "sending" | "shortcuts">>;

async function setState(page: Page, state: ComposerState): Promise<void> {
  await page.locator("prompt-editor").evaluate(async (element: PromptEditor, state) => {
    Object.assign(element, state);
    await element.updateComplete;
  }, state);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.locator("prompt-editor").evaluate(async (editor: PromptEditor) => {
    editor.status = {
      sessionId: "browser-fixture", isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, queuedMessages: [], cost: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      model: { provider: "example", id: "a-long-model-name-that-must-not-hide-composer-actions" }, thinkingLevel: "medium",
    };
    editor.shortcuts = { "composer.send.desktop": "mod+enter", "composer.send.mobile": "mod+enter" };
    editor.canStop = true;
    editor.onSelectModel = () => { document.body.dataset["lastPicker"] = "model"; };
    editor.onSelectThinking = () => { document.body.dataset["lastPicker"] = "thinking"; };
    editor.onStop = () => { document.body.dataset["lastStop"] = "stopped"; };
    editor.onSend = (_text, behavior) => { document.body.dataset["lastSend"] = behavior ?? "send"; };
    await editor.updateComplete;
    editor.replaceText("Review the configuration");
  });
});

test("purpose hooks preserve compact geometry and independently operable settings/actions", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const editor = page.locator("prompt-editor");
  const root = editor.locator('[data-ui-context="composer"]');
  const toolbar = root.locator(".ui-composer-toolbar");
  const model = toolbar.locator('[data-composer-action="model"]');
  const thinking = toolbar.locator('[data-composer-action="thinking"]');
  const commands = toolbar.locator(".ui-composer-actions");
  const send = commands.locator('[data-composer-action="send"]');
  const stop = commands.locator('[data-composer-action="stop"]');
  expect(await model.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const settingsBox = await toolbar.locator(".ui-composer-settings").boundingBox();
  const actionsBox = await commands.boundingBox();
  if (!settingsBox || !actionsBox) throw new Error("Missing toolbar geometry");
  expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(actionsBox.x + 1);
  await model.click();
  await expect(page.locator("body")).toHaveAttribute("data-last-picker", "model");
  await thinking.click();
  await expect(page.locator("body")).toHaveAttribute("data-last-picker", "thinking");
  await send.focus();
  await send.press("Tab");
  await expect(stop).toBeFocused();
  await stop.press("Enter");
  await expect(page.locator("body")).toHaveAttribute("data-last-stop", "stopped");
});

test("configured defaults follow live queue/steer changes without losing editor focus or keyboard ownership", async ({ page }) => {
  const editor = page.locator("prompt-editor");
  const root = editor.locator('[data-ui-context="composer"]');
  const input = editor.locator(".cm-content");
  // CodeMirror's Android path delays Enter and can drop its modifiers before
  // public key handlers. Keep that existing editor issue outside this UI contract:
  // a modified letter chord exercises submission ownership on every browser.
  await setState(page, { shortcuts: { "composer.send.desktop": "mod+k", "composer.send.mobile": "mod+k" } });
  await input.focus();
  await expect(root).toHaveAttribute("data-default-action", "send");
  await setState(page, { canSteer: true });
  await expect(root).toHaveAttribute("data-default-action", "steer");
  await expect(root.locator('[data-composer-action="steer"]')).toHaveAttribute("data-default", "true");
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+k");
  await expect(page.locator("body")).toHaveAttribute("data-last-send", "steer");
  await editor.evaluate((element: PromptEditor) => { element.replaceText("Queue another request"); });
  await setState(page, { defaultStreamingBehavior: "followUp" });
  await expect(root).toHaveAttribute("data-default-action", "queue");
  await expect(root.locator('[data-composer-action="queue"]')).toHaveAttribute("data-default", "true");
  await expect(input).toBeFocused();
  await input.press("ControlOrMeta+k");
  await expect(page.locator("body")).toHaveAttribute("data-last-send", "followUp");
});

test("media changes refresh the configured default without an unrelated component update", async ({ page }) => {
  const root = page.locator('prompt-editor [data-ui-context="composer"]');
  await setState(page, { shortcuts: { "composer.send.desktop": null, "composer.send.mobile": "mod+enter" } });
  await page.setViewportSize({ width: 1200, height: 800 });
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  await expect(root).toHaveAttribute("data-default-action", coarse ? "send" : "none");
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(root).toHaveAttribute("data-default-action", "send");
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(root).toHaveAttribute("data-default-action", coarse ? "send" : "none");
});

test("Playground's default cue follows eligibility and can be removed without changing geometry", async ({ page }) => {
  const editor = page.locator("prompt-editor");
  const root = editor.locator('[data-ui-context="composer"]');
  const send = root.locator('[data-composer-action="send"]');
  const decoration = (element: Element) => {
    const style = getComputedStyle(element, "::after");
    return { content: style.content, border: parseFloat(style.borderBlockEndWidth) };
  };
  const before = await send.boundingBox();
  await page.evaluate(() => window.overlayFixture.applyTheme("playground:playground-dark"));
  expect((await send.evaluate(decoration)).content).not.toBe("none");
  expect((await send.evaluate(decoration)).border).toBeGreaterThan(0);
  expect(await send.boundingBox()).toEqual(before);
  await setState(page, { sending: true });
  expect((await send.evaluate(decoration)).content).toBe("none");
  await setState(page, { sending: false, canSteer: true });
  const steer = root.locator('[data-composer-action="steer"]');
  expect((await steer.evaluate(decoration)).border).toBeGreaterThan(0);
  expect((await root.locator('[data-composer-action="queue"]').evaluate(decoration)).content).toBe("none");
  await page.emulateMedia({ forcedColors: "active" });
  expect((await steer.evaluate(decoration)).border).toBeGreaterThan(0);
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => window.overlayFixture.applyTheme("themes:pi-web-dark"));
  expect((await steer.evaluate(decoration)).content).toBe("none");
});
