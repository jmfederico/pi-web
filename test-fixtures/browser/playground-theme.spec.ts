import { expect, test } from "@playwright/test";
import type { ChatView } from "../../src/client/src/components/ChatView";

function messageGeometry(element: Element) {
  const content = element.querySelector(".chat-message-content");
  const paragraph = element.querySelector("formatted-text")?.shadowRoot?.querySelector("p");
  if (!content || !paragraph) throw new Error("Missing message anatomy");
  const box = content.getBoundingClientRect();
  const marker = getComputedStyle(content, "::before");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 0).sort((a, b) => a.top - b.top || a.left - b.left);
  const first = lines[0], last = lines.at(-1);
  if (!first || !last) throw new Error("Missing rendered text lines");
  const markerLeft = box.left + parseFloat(marker.insetInlineStart);
  return {
    firstInset: first.left - box.left, lastInset: last.left - box.left,
    firstLineLeft: first.left, contentLeft: box.left,
    markerLeft, markerRight: markerLeft + parseFloat(marker.width),
    markerBottom: box.top + parseFloat(marker.top) + parseFloat(marker.height),
    contentBottom: box.bottom,
  };
}

for (const scheme of ["dark", "light"] as const) {
  test(`Playground ${scheme} keeps readable, non-intercepting cues isolated from established themes`, async ({ page }) => {
    await page.goto("/overlays.html");
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await page.locator("chat-view").evaluate(async (chat: ChatView) => {
      chat.messages = [
        { role: "user", parts: [{ type: "text", text: "Please update the retry limit to three and show me the change. Keep the existing timeout and connection settings unchanged. Explain what you changed and how you checked it so I can review the result before we move on." }] },
        { role: "assistant", parts: [{ type: "text", text: "Updated **retries** to **3**. The request now retries up to three times before reporting an error." }] },
      ];
      await chat.updateComplete;
    });
    const chat = page.locator("chat-view");
    const request = chat.locator('.chat-message[data-speaker="user"]');
    const reply = chat.locator('.chat-message[data-speaker="assistant"]');
    await page.evaluate((scheme) => window.overlayFixture.applyTheme(`themes:pi-web-${scheme}`), scheme);
    await expect(request.locator("formatted-text p").first()).toBeVisible();
    const baseline = await request.evaluate(messageGeometry);
    const border = await request.evaluate((element) => getComputedStyle(element).borderInlineStartWidth);
    await page.evaluate((scheme) => window.overlayFixture.applyTheme(`playground:playground-${scheme}`), scheme);
    await expect(request).toHaveCSS("border-inline-start-width", border);
    const cue = (element: Element) => {
      const style = getComputedStyle(element, "::before");
      return { content: style.content, clip: style.clipPath, background: style.backgroundColor, pointerEvents: style.pointerEvents };
    };
    const requestCue = await request.locator(".chat-message-content").evaluate(cue);
    const replyCue = await reply.locator(".chat-message-content").evaluate(cue);
    expect(requestCue.content).not.toBe("none");
    expect(requestCue.clip).not.toBe("none");
    expect(replyCue.clip).not.toBe(requestCue.clip);
    expect(requestCue.pointerEvents).toBe("none");
    for (const bubble of [request, reply]) {
      const geometry = await bubble.evaluate(messageGeometry);
      expect(geometry.markerLeft).toBeGreaterThanOrEqual(geometry.contentLeft);
      expect(geometry.markerRight).toBeLessThanOrEqual(geometry.firstLineLeft);
      expect(geometry.markerBottom).toBeLessThanOrEqual(geometry.contentBottom);
      if (bubble === request) {
        // Preserve the established text inset on all lines, not a copied pixel recipe.
        expect(geometry.firstInset).toBeCloseTo(baseline.firstInset, 0);
        expect(geometry.lastInset).toBeCloseTo(baseline.lastInset, 0);
      }
    }
    // Real clicks protect hit targeting around the decorative cue and metadata.
    await request.getByRole("button", { name: "Message actions", exact: true }).click();
    await request.getByRole("button", { name: "Message information" }).click();
    await expect(request.locator(".chat-message-meta")).toBeVisible();

    // Resolve the real CSS custom properties, including color-mix, in the browser.
    // These are the small-text foreground/background pairs used by chat, code,
    // shared controls, and diff metadata; this is not a whole-app certification.
    const contrasts = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Missing color conversion canvas");
      const luminance = (value: string): number => {
        probe.style.color = value;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(probe).color;
        context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        const linear = (channel: number): number => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return linear(red ?? 0) * 0.2126 + linear(green ?? 0) * 0.7152 + linear(blue ?? 0) * 0.0722;
      };
      const ratio = (foreground: string, background: string): number => {
        const a = luminance(`var(--pi-${foreground})`);
        const b = luminance(`var(--pi-${background})`);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const result: Record<string, number> = {};
      for (const foreground of ["text", "text-secondary", "muted", "dim", "accent", "success", "warning", "danger", "syntax-keyword", "syntax-title", "syntax-string", "syntax-number", "syntax-comment"]) {
        for (const background of ["bg", "surface", "surface-hover", "selection-bg"]) {
          result[`${foreground}/${background}`] = ratio(foreground, background);
        }
      }
      probe.remove();
      return result;
    });
    for (const [pair, ratio] of Object.entries(contrasts)) expect(ratio, `${scheme}: ${pair}`).toBeGreaterThanOrEqual(4.5);


    const input = page.locator("prompt-editor .cm-content");
    await input.pressSequentially("/");
    const candidate = page.locator('autocomplete-menu .ui-choice[data-selected="true"]');
    await expect(candidate).toBeVisible();
    expect(await candidate.evaluate((element) => getComputedStyle(element, "::after").content)).not.toBe("none");
    await input.press("Escape");
    await page.evaluate(() => window.overlayFixture.mountRenderer());
    const renderer = page.locator("#theme-renderer");
    const highlighted = renderer.getByRole("button", { name: "Highlighted", exact: true });
    const raw = renderer.getByRole("button", { name: "Raw", exact: true });
    await raw.click();
    expect(await raw.evaluate((element) => getComputedStyle(element, "::after").content)).not.toBe("none");
    expect(await highlighted.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");

    await page.emulateMedia({ forcedColors: "active" });
    const forcedCue = await request.locator(".chat-message-content").evaluate(cue);
    expect(forcedCue.clip).toBe(requestCue.clip);
    expect(forcedCue.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(await raw.evaluate((element) => parseFloat(getComputedStyle(element, "::after").borderBlockEndWidth))).toBeGreaterThan(0);
    await page.emulateMedia({ forcedColors: "none" });
    const screenshot = test.info().outputPath(`playground-${scheme}.png`);
    await page.screenshot({ path: screenshot });
    await test.info().attach(`playground-${scheme}`, { path: screenshot, contentType: "image/png" });

    await page.evaluate(() => { document.documentElement.dir = "rtl"; });
    expect((await request.locator(".chat-message-content").evaluate(cue)).clip).toBe(requestCue.clip);
    expect(await chat.evaluate((element) => {
      const scroller = element.shadowRoot?.querySelector(".chat");
      return scroller !== null && scroller !== undefined && scroller.scrollWidth <= scroller.clientWidth;
    })).toBe(true);
    await page.evaluate(() => { document.documentElement.dir = "ltr"; });
    await page.evaluate((scheme) => window.overlayFixture.applyTheme(`themes:pi-web-${scheme}`), scheme);
    expect((await request.locator(".chat-message-content").evaluate(cue)).content).toBe("none");
    expect(await raw.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
  });
}
