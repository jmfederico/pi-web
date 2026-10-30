import { expect, test } from "@playwright/test";
import type { ChatView } from "../../src/client/src/components/ChatView";

// Reuse the isolated real-component fixture; no daemon or live user state.
test.beforeEach(async ({ page }) => {
  await page.goto("/overlays.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("conversation hooks support theme edges, speaker masks, alignment, and cue removal", async ({ page }) => {
  await page.locator("chat-view").evaluate(async (chat: ChatView) => {
    chat.messages = [
      { role: "user", entryId: "request", parts: [{ type: "text", text: "Update the configuration." }] },
      { role: "assistant", entryId: "reply", parts: [{ type: "text", text: "The configuration has been updated." }] },
    ];
    await chat.updateComplete;
  });
  const chat = page.locator("chat-view");
  const user = chat.locator('.chat-message[data-speaker="user"]');
  const assistant = chat.locator('.chat-message[data-speaker="assistant"]');
  const userContent = user.locator(".chat-message-content");
  const info = user.getByRole("button", { name: "Message information", includeHidden: true });
  const originalBorder = await user.evaluate((element) => getComputedStyle(element).borderInlineStartWidth);
  const person = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="4" r="3"/><path d="M2 16v-3a6 6 0 0 1 12 0v3Z"/></svg>');
  const robot = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M7 0h2v3h5v12H2V3h5Z"/></svg>');
  await chat.evaluate((element, masks) => {
    const style = document.createElement("style");
    style.id = "contract-theme";
    style.textContent = `
      :host(chat-view) .chat-message { max-inline-size: 85%; border-inline-start: 5px dotted currentColor; }
      :host(chat-view) .chat-message[data-speaker="user"] { margin-inline-start: auto; --speaker-mask: url("data:image/svg+xml,${masks.person}"); }
      :host(chat-view) .chat-message[data-speaker="assistant"] { margin-inline-end: auto; --speaker-mask: url("data:image/svg+xml,${masks.robot}"); }
      :host(chat-view) .chat-message-content { display: grid; grid-template-columns: 20px minmax(0, 1fr); }
      :host(chat-view) .chat-message-content::before { content: ""; grid-column: 1; grid-row: 1; inline-size: 14px; block-size: 14px; margin-block-start: 12px; background: currentColor; mask: var(--speaker-mask) center / contain no-repeat; pointer-events: none; }
      :host(chat-view) .chat-message-body { grid-column: 2; grid-row: 1; }
    `;
    element.shadowRoot?.append(style);
  }, { person, robot });
  await expect(user).toHaveCSS("border-inline-start-style", "dotted");
  const cue = await userContent.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, mask: style.maskImage, pointerEvents: style.pointerEvents };
  });
  expect(cue).toMatchObject({ content: '""', pointerEvents: "none" });
  expect(cue.mask).toContain("data:image/svg+xml,");
  expect(await assistant.locator(".chat-message-content").evaluate((element) => getComputedStyle(element, "::before").maskImage)).not.toBe(cue.mask);

  const userBox = await user.boundingBox();
  const assistantBox = await assistant.boundingBox();
  if (!userBox || !assistantBox) throw new Error("Missing themed message geometry");
  expect(userBox.x).toBeGreaterThan(assistantBox.x);
  expect(userBox.y + userBox.height).toBeLessThanOrEqual(assistantBox.y + 1);
  expect(await chat.evaluate((element) => {
    const scroller = element.shadowRoot?.querySelector(".chat");
    return scroller !== null && scroller !== undefined && scroller.scrollWidth <= scroller.clientWidth;
  })).toBe(true);
  await user.getByRole("button", { name: "Message actions", exact: true }).click();
  await info.click();
  await expect(user.locator(".chat-message-meta")).toBeVisible();
  const screenshot = test.info().outputPath("speaker-theme.png");
  await chat.screenshot({ path: screenshot });
  await test.info().attach("speaker-theme", { path: screenshot, contentType: "image/png" });
  await expect(info).toHaveAttribute("aria-expanded", "true");

  // A structural theme can remove icons altogether, without changing component semantics.
  await chat.evaluate((element) => {
    const style = element.shadowRoot?.querySelector<HTMLStyleElement>("#contract-theme");
    if (!style) throw new Error("Missing contract theme");
    style.textContent += `
      :host(chat-view) .chat-message-content { display: block; }
      :host(chat-view) .chat-message-content::before { content: none; }
    `;
  });
  expect(await userContent.evaluate((element) => getComputedStyle(element, "::before").content)).toBe("none");
  expect((await user.boundingBox())?.x).toBeCloseTo(userBox.x, 0);
  await user.getByRole("button", { name: "Message actions", exact: true }).click();
  await info.click();
  await expect(user.locator(".chat-message-meta")).toBeHidden();
  await expect(info).toHaveAttribute("aria-expanded", "false");

  await chat.evaluate((element) => { element.shadowRoot?.querySelector("#contract-theme")?.remove(); });
  await expect(user).toHaveCSS("border-inline-start-width", originalBorder);
});

test("renderer choice hooks allow less-specific theme rules to override local selected-state defaults", async ({ page }) => {
  await page.evaluate(() => window.overlayFixture.mountRenderer());
  const renderer = page.locator("#theme-renderer");
  await renderer.evaluate((element) => {
    const sheet = new CSSStyleSheet();
    // This must beat the component's more-specific selected-state selector.
    sheet.replaceSync('[data-selected="true"] { background: rgb(40, 40, 40); }');
    const root = element.shadowRoot;
    if (!root) throw new Error("Missing renderer root");
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  });
  await expect(renderer.locator('.ui-choice[data-selected="true"]')).toHaveCSS("background-color", "rgb(40, 40, 40)");
});
