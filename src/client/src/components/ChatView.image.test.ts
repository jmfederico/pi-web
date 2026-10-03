// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView, chatImagePartSource, chatMessageAnchorKey, chatToolOutputLabel } from "./ChatView";
import { TranscriptImage } from "./TranscriptImage";
import { MarkdownImage } from "./MarkdownImage";
import { FormattedText } from "./FormattedText";
import { ImageIntersectionObserver, imagePresentation, latestImageObserver, settleImage } from "./imagePresentation.testSupport";

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
    expect(chatMessageAnchorKey(7)).toBe("m:7");
  });
});

describe("ChatView image event wiring", () => {
  async function mountImage() {
    vi.stubGlobal("IntersectionObserver", undefined);
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

  it("re-pins late image layout changes only while already pinned to the bottom", async () => {
    const { view, presentation, native } = await mountImage();
    const scroll = vi.fn();
    Reflect.set(view, "scrollToBottom", scroll);
    Reflect.set(view, "pinnedToBottom", true);
    native.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    Reflect.set(view, "pinnedToBottom", false);
    native.dispatchEvent(new Event("error"));
    await presentation.updateComplete;
    expect(scroll).toHaveBeenCalledOnce();
  });

  it("opens and closes the image zoom target on click and close", async () => {
    const { view, presentation, native } = await mountImage();
    native.dispatchEvent(new Event("load"));
    await presentation.updateComplete;
    presentation.renderRoot.querySelector<HTMLButtonElement>(".image-button")?.click();
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".image-zoom-full")).not.toBeNull();
    view.renderRoot.querySelector<HTMLButtonElement>(".image-zoom-close")?.click();
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".image-zoom-full")).toBeNull();
  });

  it("finds the chat scroller across the actual formatted markdown shadow root before loading", async () => {
    ImageIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", ImageIntersectionObserver);
    const view = new ChatView();
    view.workspaceContext = { machineId: "local", projectId: "p", workspaceId: "w", root: "/repo" };
    view.messages = [{ role: "user", parts: [{ type: "text", text: "![screenshot](screenshot.png)" }] }];
    document.body.append(view);
    await view.updateComplete;
    const formatted = view.renderRoot.querySelector<FormattedText>("formatted-text");
    if (formatted === null) throw new Error("Expected formatted markdown");
    await formatted.updateComplete;
    const image = formatted.renderRoot.querySelector<MarkdownImage>("pi-web-markdown-image");
    if (image === null) throw new Error("Expected markdown image");
    expect(await image.updateComplete).toBe(true);
    expect(image.isUpdatePending).toBe(false);
    expect(image.getRootNode()).toBe(formatted.renderRoot);
    expect(formatted.getRootNode()).toBe(view.renderRoot);
    const scroller = view.renderRoot.querySelector(".chat[data-image-scroll-root]");
    if (scroller === null) throw new Error("Expected chat scroller");
    const presentation = imagePresentation(image);
    await presentation.updateComplete;
    expect(presentation.source).toBeUndefined();
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    const observer = latestImageObserver();
    expect(observer.root).toBe(scroller);
    expect(observer.observe).toHaveBeenCalledExactlyOnceWith(image);
    observer.notify();
    expect(await image.updateComplete).toBe(true);
    await presentation.updateComplete;
    const url = new URL(presentation.renderRoot.querySelector("img")?.src ?? "");
    expect(url.pathname).toBe("/api/machines/local/projects/p/workspaces/w/file/preview");
    expect(url.searchParams.get("path")).toBe("screenshot.png");
  });

  it("gives nested image observers the actual chat scroller and session cwd", async () => {
    ImageIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", ImageIntersectionObserver);
    const view = new ChatView();
    view.machineId = "remote /?";
    view.sessionId = "session /?";
    view.sessionCwd = "/correct session cwd";
    view.messages = [{ role: "user", parts: [{ type: "image", mediaId: "a".repeat(64), mimeType: "image/png", byteSize: 3 }] }];
    document.body.append(view);
    await view.updateComplete;
    const image = view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
    if (image === null) throw new Error("Expected transcript image");
    expect(await image.updateComplete).toBe(true);
    expect(image.isUpdatePending).toBe(false);
    expect(image.getRootNode()).toBe(view.renderRoot);
    const scroller = view.renderRoot.querySelector(".chat[data-image-scroll-root]");
    if (scroller === null) throw new Error("Expected chat scroller");
    const presentation = imagePresentation(image);
    await presentation.updateComplete;
    expect(presentation.source).toBeUndefined();
    expect(presentation.renderRoot.querySelector("img")).toBeNull();
    const observer = latestImageObserver();
    expect(observer.root).toBe(scroller);
    expect(observer.observe).toHaveBeenCalledExactlyOnceWith(image);
    observer.notify();
    expect(await image.updateComplete).toBe(true);
    await presentation.updateComplete;
    const url = new URL(presentation.renderRoot.querySelector("img")?.src ?? "");
    expect(url.searchParams.get("cwd")).toBe(view.sessionCwd);
    expect(url.pathname).toContain("/machines/remote%20%2F%3F/sessions/session%20%2F%3F/media/");
  });
});
