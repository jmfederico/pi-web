// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView, chatImagePartSource, chatMessageAnchorKey, chatToolOutputLabel } from "./ChatView";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

describe("ChatView image content derivation", () => {
  // Content/attribute derivation (image src/alt, the tool-output header label,
  // and the scroll-anchor key) lives in pure exported seams rather than being
  // scraped from rendered `TemplateResult` markup, per the testing-guide rule
  // that TemplateResult inspection is not for general content assertions.
  it("derives the image data URL and alt text from an image part", () => {
    expect(chatImagePartSource({ type: "image", mimeType: "image/png", data: "QUJD" })).toEqual({
      src: "data:image/png;base64,QUJD",
      alt: "attached image",
    });
  });

  it("labels tool image output by tool name and falls back to a generic label", () => {
    expect(chatToolOutputLabel("read")).toBe("read output");
    expect(chatToolOutputLabel(undefined)).toBe("tool output");
    expect(chatToolOutputLabel("")).toBe("tool output");
  });

  it("keys a tool image message to its stable scroll anchor", () => {
    expect(chatMessageAnchorKey(7)).toBe("m:7");
  });
});

describe("ChatView image event wiring", () => {
  async function mountImage() {
    const view = new ChatView();
    view.messages = [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] }];
    document.body.append(view);
    await view.updateComplete;
    const image = view.renderRoot.querySelector<HTMLImageElement>(".chat-image");
    if (image === null) throw new Error("Expected image");
    return { view, image };
  }

  it("re-pins late image loads only while already pinned to the bottom", async () => {
    const { view, image } = await mountImage();
    const scroll = vi.fn();
    Reflect.set(view, "scrollToBottom", scroll);
    Reflect.set(view, "pinnedToBottom", true);
    image.dispatchEvent(new Event("load"));
    Reflect.set(view, "pinnedToBottom", false);
    image.dispatchEvent(new Event("load"));
    expect(scroll).toHaveBeenCalledOnce();
  });

  it("opens and closes the image zoom target on click and close", async () => {
    const { view, image } = await mountImage();
    image.click();
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".image-zoom-full")).not.toBeNull();
    view.renderRoot.querySelector<HTMLButtonElement>(".image-zoom-close")?.click();
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".image-zoom-full")).toBeNull();
  });
});
