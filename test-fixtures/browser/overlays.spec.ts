import { expect, test, type Locator } from "@playwright/test";

async function typeComposerText(input: Locator, text: string): Promise<void> {
  // Exercise CodeMirror through keyboard input, not contenteditable DOM filling.
  // WebKit can finish fill() without inserting text into this shadow-root editor.
  await input.press("ControlOrMeta+A");
  await input.press("Backspace");
  await input.pressSequentially(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("completions escape layout clipping, preserve editor focus, and disappear on session changes", async ({ page }) => {
  const input = page.locator("prompt-editor .cm-content");
  for (const trigger of ["/", "@", "#"]) {
    await typeComposerText(input, trigger);
    const suggestion = page.locator("autocomplete-menu button").first();
    await expect(suggestion).toBeVisible();
    await suggestion.click({ trial: true });
    await expect(input).toBeFocused();
    await input.press("Escape");
    await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
  }
  await typeComposerText(input, "/");
  const pick = page.locator("autocomplete-menu button");
  await expect(pick).toBeVisible();
  if (test.info().project.name === "touch") await pick.tap();
  else await pick.click();
  await expect(input).toHaveText("/tree");
  await expect(input).toBeFocused();
  await typeComposerText(input, "/");
  await expect(page.locator("autocomplete-menu button")).toBeVisible();
  await page.getByRole("button", { name: "Switch session", exact: true }).click();
  await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
});

test("activity belongs to the boundary without changing transcript or composer geometry", async ({ page }) => {
  const chat = page.locator("chat-view");
  const input = page.locator("prompt-editor");
  const chatBefore = await chat.boundingBox();
  const inputBefore = await input.boundingBox();
  const dock = page.locator("conversation-layout .activity-dock");
  await expect(dock).toBeVisible();
  const dockBox = await dock.boundingBox();
  expect(inputBefore).not.toBeNull();
  expect(dockBox).not.toBeNull();
  if (inputBefore === null || dockBox === null) throw new Error("Missing conversation geometry");
  expect(Math.abs(dockBox.y + dockBox.height / 2 - inputBefore.y)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Toggle activity" }).click();
  await expect(dock).toHaveCount(0);
  expect(await chat.boundingBox()).toEqual(chatBefore);
  expect(await input.boundingBox()).toEqual(inputBefore);
});

test("nested anchored menus escape transformed clipping and Escape closes only the child", async ({ page }) => {
  const switcher = page.locator(".clip machine-switcher");
  const trigger = switcher.getByRole("button", { name: /Switch machine/ });
  await trigger.click();
  const panel = switcher.locator(".machine-switcher-menu");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: /Remote/ }).first().click({ trial: true });
  const actions = panel.getByRole("button", { name: /actions.*Remote|Remote.*actions/i });
  await actions.click();
  const child = switcher.locator(".machine-option-actions-panel");
  await expect(child).toBeVisible();
  await child.getByRole("button", { name: "Remove" }).click({ trial: true });
  await page.keyboard.press("Escape");
  await expect(child).not.toBeVisible();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
});

test("popups follow shadow-root scrolling and stay within a resized viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  const switcher = page.locator(".clip machine-switcher");
  const trigger = switcher.getByRole("button", { name: /Switch machine/ });
  await trigger.click();
  const panel = switcher.locator(".machine-switcher-menu");
  await expect(panel).toBeVisible();
  const before = await panel.boundingBox();
  if (before === null) throw new Error("Missing popup geometry");
  await page.locator(".scroll").evaluate((element) => { element.scrollTop = 10; });
  await expect.poll(async () => (await panel.boundingBox())?.y).toBeCloseTo(before.y - 10, 0);
  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 600;
  }).toBe(true);
});

test("message actions share top-layer placement and restore their trigger", async ({ page }) => {
  const actions = page.locator(".clip pi-message-actions-menu");
  const trigger = actions.getByRole("button", { name: "Message actions" });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await actions.getByRole("button", { name: "Copy fixture" }).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("modal ownership dismisses background suggestions, allows owned menus, and restores focus", async ({ page }) => {
  const input = page.locator("prompt-editor .cm-content");
  await typeComposerText(input, "/");
  await expect(page.locator("autocomplete-menu button")).toBeVisible();
  const opener = page.getByRole("button", { name: "Open dialog", exact: true });
  await opener.click();
  const dialog = page.locator("modal-surface").filter({ has: page.getByRole("dialog", { name: "Dialog 1", exact: true, includeHidden: true }) });
  await expect(page.getByRole("dialog", { name: "Dialog 1", exact: true })).toHaveCount(1);
  await expect(dialog.locator("dialog")).toBeVisible();
  await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
  await page.evaluate(() => window.overlayFixture.complete());
  await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Dialog input" })).toBeFocused();
  await dialog.getByRole("button", { name: /Switch machine/ }).click();
  const menu = dialog.locator(".machine-switcher-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: /Remote/ }).first().click({ trial: true });
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(dialog.locator("dialog")).toBeVisible();
  await dialog.getByRole("button", { name: "Open nested dialog" }).click();
  const nested = page.locator("modal-surface").filter({ has: page.getByRole("dialog", { name: "Dialog 2", exact: true }) });
  await expect(nested.getByRole("textbox", { name: "Dialog input" })).toBeFocused();
  await expect(nested.locator("dialog")).toHaveAttribute("aria-modal", "true");
  await expect(dialog.locator("dialog")).toHaveAttribute("aria-modal", "false");
  await expect(dialog.locator("dialog")).toHaveAttribute("aria-hidden", "true");
  await page.keyboard.press("Escape");
  await expect(nested).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Open nested dialog" })).toBeFocused();
  await expect(dialog.locator("dialog")).toHaveAttribute("aria-modal", "true");
  await expect(dialog.locator("dialog")).not.toHaveAttribute("aria-hidden");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("unmanaged plugin dialogs share the modality boundary", async ({ page }) => {
  await typeComposerText(page.locator("prompt-editor .cm-content"), "/");
  await expect(page.locator("autocomplete-menu button")).toBeVisible();
  await page.evaluate(() => { window.overlayFixture.openPluginModal(); });
  await expect(page.getByRole("textbox", { name: "Plugin input" })).toBeFocused();
  await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
  await page.locator("dialog").getByRole("button", { name: /Switch machine/ }).click();
  await expect(page.locator("dialog .machine-switcher-menu")).toBeVisible();
});

test("modal accessibility follows unmanaged plugin dialogs and survives property renders", async ({ page }) => {
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const dialog = page.locator("modal-surface dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  await page.evaluate(() => { window.overlayFixture.openPluginModal(); });
  await expect(dialog).toHaveAttribute("aria-modal", "false");
  await expect(dialog).toHaveAttribute("aria-hidden", "true");
  await page.locator("modal-surface").evaluate((surface: HTMLElement & { busy: boolean }) => { surface.busy = true; });
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog).toHaveAttribute("aria-hidden", "true");

  await page.getByRole("button", { name: "Close plugin dialog", exact: true }).click();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).not.toHaveAttribute("aria-hidden");
  await expect(page.getByRole("textbox", { name: "Dialog input" })).toBeFocused();
});

test("attachment sources stay hidden until requested and activate their native inputs", async ({ page }) => {
  const editor = page.locator("prompt-editor");
  const attach = editor.getByRole("button", { name: "Attach files", exact: true });
  const panel = editor.locator(".attach-source-panel");
  await expect(panel).toBeHidden();
  if (test.info().project.name !== "touch") {
    const chooser = page.waitForEvent("filechooser");
    await attach.click();
    const picker = await chooser;
    expect(await picker.element().getAttribute("class")).toBe("attachment-input");
    expect(picker.isMultiple()).toBe(true);
    await expect(panel).toBeHidden();
    return;
  }
  for (const [name, input] of [["Photos", "attachment-image-input"], ["Camera", "attachment-camera-input"], ["Files", "attachment-input"]] as const) {
    await attach.tap();
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("Missing attachment popup geometry");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const chooser = page.waitForEvent("filechooser");
    await panel.getByRole("button", { name, exact: true }).tap();
    expect(await (await chooser).element().getAttribute("class")).toBe(input);
    await expect(panel).toBeHidden();
    await expect(attach).toHaveAttribute("aria-expanded", "false");
  }
  await attach.tap();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(attach).toBeFocused();
});

test("hiding the conversation closes its suggestions", async ({ page }) => {
  await typeComposerText(page.locator("prompt-editor .cm-content"), "/");
  await expect(page.locator("autocomplete-menu button")).toBeVisible();
  await page.evaluate(() => { window.overlayFixture.hideConversation(); });
  await expect(page.locator("autocomplete-menu [popover]:popover-open")).toHaveCount(0);
});
