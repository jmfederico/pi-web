// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView, chatImagePartSource, chatMessageAnchorKey, chatToolOutputLabel } from "./ChatView";
import { TranscriptImage } from "./TranscriptImage";
import { settleImage } from "./imagePresentation.testSupport";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ChatView image content derivation", () => {
  it("derives the legacy image data URL and alt text", () => {
    expect(chatImagePartSource({ type: "image", mimeType: "image/png", data: "QUJD" })).toEqual({
      src: "data:image/png;base64,QUJD", alt: "attached image",
    });
  });

  it("derives reference URLs from selected machine/session context, not a server-provided URL", () => {
    vi.stubEnv("BASE_URL", "/nested/pi-web/");
    const part = { type: "image" as const, mimeType: "image/png", mediaId: "a".repeat(64), byteSize: 3 };
    expect(chatImagePartSource(part)).toBeUndefined();
    const source = chatImagePartSource(part, { id: "session /?#%", cwd: "/repo /?#%" }, "remote /?#%");
    if (source === undefined) throw new Error("Expected reference source");
    const url = new URL(source.src);
    expect(url.pathname).toBe(`/nested/pi-web/api/machines/remote%20%2F%3F%23%25/sessions/session%20%2F%3F%23%25/media/${part.mediaId}`);
    expect(url.searchParams.get("cwd")).toBe("/repo /?#%");
  });

  it("labels tool image output by tool name and falls back to a generic label", () => {
    expect(chatToolOutputLabel("read")).toBe("read output");
    expect(chatToolOutputLabel(undefined)).toBe("tool output");
    expect(chatToolOutputLabel("")).toBe("tool output");
  });

  it("keys a tool image message to its stable scroll anchor", () => {
    expect(chatMessageAnchorKey(7, { entryId: "image-entry", role: "tool", parts: [] })).toBe('m:["image-entry","tool","message"]');
  });
});

describe("ChatView image event wiring", () => {
  async function mountImage() {
    const view = new ChatView();
    view.messages = [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] }];
    document.body.append(view);
    await view.updateComplete;
    const image = view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
    if (image === null) throw new Error("Expected transcript image");
    const presentation = await settleImage(image);
    const native = presentation.renderRoot.querySelector("img");
    if (native === null) throw new Error("Expected native image");
    return { view, presentation, native };
  }

  it("presents tool images as conversation while keeping their technical context in collapsed activity", async () => {
    const view = new ChatView();
    view.messages = [
      { role: "tool", entryId: "tool-image", parts: [
        { type: "toolResult", toolName: "read", text: "Read image file", isError: false },
        { type: "image", mimeType: "image/png", data: "QUJD" },
      ] },
      { role: "assistant", entryId: "reply", parts: [{ type: "text", text: "Here is the image." }] },
    ];
    document.body.append(view);
    await view.updateComplete;

    const activity = view.renderRoot.querySelector<HTMLDetailsElement>(".event-group");
    const imageMessage = view.renderRoot.querySelector("article.tool-image-output");
    expect(activity?.open).toBe(false);
    expect(imageMessage?.classList.contains("conversation-message")).toBe(true);
    expect(imageMessage?.closest(".event-group")).toBeNull();
    expect(imageMessage?.querySelector(".label")?.textContent).toBe("read output");
    expect(imageMessage?.querySelector("pi-web-transcript-image")).not.toBeNull();
    expect(view.renderRoot.querySelector("article.assistant")?.classList.contains("conversation-message")).toBe(true);
    expect(activity?.querySelector(".conversation-message")).toBeNull();
  });

  it("leaves native image load/error events free of custom scroll corrections", async () => {
    const { view, presentation, native } = await mountImage();
    const scroll = vi.fn();
    Reflect.set(view, "scrollToBottom", scroll);
    Reflect.set(view, "pinnedToBottom", true);
    native.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    Reflect.set(view, "pinnedToBottom", false);
    native.dispatchEvent(new Event("error"));
    await presentation.updateComplete;
    expect(scroll).not.toHaveBeenCalled();
    expect(presentation.renderRoot.querySelector("img")).toBe(native);
  });

  it("opens and closes the image zoom target without waiting for native loading", async () => {
    const { view, presentation } = await mountImage();
    presentation.renderRoot.querySelector<HTMLButtonElement>(".image-button")?.click();
    await view.updateComplete;
    const gallery = view.renderRoot.querySelector("pi-web-image-gallery-dialog");
    expect(gallery?.shadowRoot?.querySelector(".image-zoom-full")).not.toBeNull();
    gallery?.shadowRoot?.querySelector<HTMLButtonElement>(".image-zoom-close")?.click();
    await view.updateComplete;
    expect(gallery?.shadowRoot?.querySelector(".image-zoom-full")).toBeNull();
  });

  it("assigns native image sources immediately with the selected machine and session cwd", async () => {
    const view = new ChatView();
    view.machineId = "remote /?";
    view.sessionId = "session /?";
    view.sessionCwd = "/correct session cwd";
    view.messages = [{ role: "user", parts: [{ type: "image", mediaId: "a".repeat(64), mimeType: "image/png", byteSize: 3 }] }];
    document.body.append(view);
    await view.updateComplete;
    const image = view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
    if (image === null) throw new Error("Expected transcript image");
    const presentation = await settleImage(image);
    const native = presentation.renderRoot.querySelector("img");
    expect(native?.getAttribute("loading")).toBe("lazy");
    expect(native?.getAttribute("decoding")).toBe("async");
    const url = new URL(native?.src ?? "");
    expect(url.searchParams.get("cwd")).toBe(view.sessionCwd);
    expect(url.pathname).toContain("/machines/remote%20%2F%3F/sessions/session%20%2F%3F/media/");
  });
});
