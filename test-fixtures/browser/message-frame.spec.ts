import { expect, test, type Locator } from "@playwright/test";
import type { ChatView } from "../../src/client/src/components/ChatView";

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (result === null) throw new Error("Missing message geometry");
  return result;
}

async function bottomOffset(locator: Locator, reference: Locator) {
  const referenceElement = await reference.elementHandle();
  try {
    // Disclosure layout can adjust scroll between separate boundingBox calls.
    // Sample both edges in one callback so they share the same scroll offset.
    return await locator.evaluate((element, anchor) => {
      return Math.abs(element.getBoundingClientRect().bottom - anchor.getBoundingClientRect().bottom);
    }, referenceElement);
  } finally {
    await referenceElement.dispose();
  }
}

for (const visualEffects of [true, false]) {
  test(`grouped reasoning shares the message corner without a header row (effects: ${String(visualEffects)})`, async ({ page }, testInfo) => {
    await page.goto("/overlays.html");
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    const chat = page.locator("chat-view");
    await chat.evaluate(async (view: ChatView, effects) => {
      view.behaviors = { ...view.behaviors, visualEffects: effects };
      view.messages = [
        { role: "user", parts: [{ type: "text", text: "Check the release." }] },
        { role: "tool", parts: [{ type: "toolExecution", toolName: "bash", summary: "npm view version", status: "error", resultText: "Version not found" }] },
        { role: "assistant", entryId: "reasoning", parts: [{ type: "thinking", text: "**Inspecting npm config**" }], meta: { model: { provider: "example", id: "reasoning-model" } } },
        { role: "tool", parts: [{ type: "toolExecution", toolName: "bash", summary: "npm config get registry", status: "success", resultText: "Registry checked" }] },
        { role: "assistant", entryId: "reply", parts: [{ type: "text", text: "The registry was checked." }] },
      ];
      await view.updateComplete;
    }, visualEffects);
    const group = chat.locator("details.event-group");
    await group.locator(":scope > summary").click();
    const message = group.locator(".group-msg.assistant");
    const reasoning = message.locator("details.thinking");
    const trigger = message.getByRole("button", { name: "Message actions", exact: true });
    const info = message.getByRole("button", { name: "Message information", exact: true });
    const metadata = message.locator(".msg-meta-details");
    const summary = reasoning.locator(":scope > summary");

    for (const open of [true, false]) {
      if (!open) await summary.click();
      await expect(reasoning).toHaveJSProperty("open", open);
      await trigger.scrollIntoViewIfNeeded();
      const messageBox = await box(message);
      const reasoningBox = await box(reasoning);
      const triggerBox = await box(trigger);
      // The reasoning starts at the message edge, not after an empty action row.
      expect(Math.abs(reasoningBox.y - messageBox.y)).toBeLessThanOrEqual(1);
      expect(await bottomOffset(trigger, reasoning)).toBeLessThanOrEqual(1);
      expect(Math.abs(triggerBox.x + triggerBox.width - messageBox.x - messageBox.width)).toBeLessThanOrEqual(1);

      if (testInfo.project.name === "touch") await trigger.tap();
      else await trigger.click();
      await info.click();
      await expect(metadata).toBeVisible();
      await expect(metadata).toContainText("example/reasoning-model");
      await expect(trigger).toBeFocused();
      await expect(reasoning).toHaveJSProperty("open", open);
      // Metadata follows the content; it does not move the menu or precede reasoning.
      const contentBox = await box(reasoning);
      expect((await box(metadata)).y).toBeGreaterThanOrEqual(contentBox.y + contentBox.height);
      await trigger.click();
      await info.click();
      await expect(metadata).toBeHidden();
    }
    await summary.click();
    await expect(reasoning).toHaveJSProperty("open", true);
    await expect(group.locator(".group-msg.tool pi-message-actions-menu")).toHaveCount(0);
    const reply = chat.locator("article.assistant");
    const replyContent = reply.locator(".chat-message-content");
    const replyTrigger = reply.getByRole("button", { name: "Message actions", exact: true });
    expect(await bottomOffset(replyTrigger, replyContent)).toBeLessThanOrEqual(1);
    const screenshot = testInfo.outputPath("message-frames.png");
    await chat.screenshot({ path: screenshot });
    await testInfo.attach("message-frames", { path: screenshot, contentType: "image/png" });
  });
}

test("mixed grouped content keeps section edges full-width and actions scoped to the whole message", async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const chat = page.locator("chat-view");
  await chat.evaluate(async (view: ChatView) => {
    view.messages = [{ role: "assistant", source: "branch_summary", parts: [
      { type: "thinking", text: "Plan" },
      { type: "text", text: "Context between sections" },
      { type: "toolCall", toolName: "read", summary: "package.json" },
    ] }];
    view.isSendingPrompt = true;
    await view.updateComplete;
  });
  const message = chat.locator(".group-msg.assistant");
  const thinking = message.locator(".thinking");
  const tool = message.locator(".tool-line");
  const text = message.locator("formatted-text").filter({ hasText: "Context between sections" });
  await expect(text).toBeVisible();
  const messageBox = await box(message);
  for (const section of [thinking, tool]) {
    const sectionBox = await box(section);
    expect(sectionBox.x).toBeCloseTo(messageBox.x, 0);
    expect(sectionBox.width).toBeCloseTo(messageBox.width, 0);
  }
  const textBox = await box(text);
  const thinkingBox = await box(thinking);
  const toolBox = await box(tool);
  expect(textBox.y).toBeGreaterThanOrEqual(thinkingBox.y + thinkingBox.height);
  expect(textBox.x).toBeGreaterThan(messageBox.x);
  expect(textBox.y + textBox.height).toBeLessThanOrEqual(toolBox.y);
  await message.getByRole("button", { name: "Message actions", exact: true }).click();
  await message.getByRole("button", { name: "Message information", exact: true }).click();
  expect((await box(message.locator(".msg-meta-details"))).y).toBeGreaterThanOrEqual(toolBox.y + toolBox.height);
});
