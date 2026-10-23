// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();
import type { ImageGalleryDialog } from "./ImageGalleryDialog";
import { deepActiveElement } from "./modalLayerRegistry";
import { ModalSurface } from "./ModalSurface";
import { hasRenderedModal } from "./modalLayerRegistry";
import { TranscriptImage } from "./TranscriptImage";
import { FormattedText } from "./FormattedText";
import { MarkdownImage } from "./MarkdownImage";
import type { ChatLine } from "./shared";
import { PluginRegistry } from "../plugins/registry";
import { imagePresentation, settleImage } from "./imagePresentation.testSupport";

const IMAGE_DATA = "iVBORw0KGgo=";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatView native image modal", () => {
  it("preserves cancel and backdrop close behavior while restoring the image trigger", async () => {
    const view = await mountImageView();
    const image = chatImage(view);

    image.focus();
    image.click();
    await view.updateComplete;
    const firstDialog = imageDialog(view);
    expect(firstDialog.open).toBe(true);
    expect(deepActiveElement(document)).toBe(imageCloseButton(firstDialog));
    expect(hasRenderedModal(document)).toBe(true);

    const cancel = new Event("cancel", { cancelable: true });
    firstDialog.dispatchEvent(cancel);
    await view.updateComplete;
    expect(cancel.defaultPrevented).toBe(false);
    expect(firstDialog.open).toBe(false);
    expect(image.getRootNode()).toHaveProperty("activeElement", image);
    expect(hasRenderedModal(document)).toBe(false);

    image.click();
    await view.updateComplete;
    const secondDialog = imageDialog(view);
    secondDialog.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
    await view.updateComplete;

    expect(secondDialog.open).toBe(false);
    expect(image.getRootNode()).toHaveProperty("activeElement", image);
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("keeps the native top layer above a shared modal and restores focus into the survivor", async () => {
    const trigger = appendButton("Open lower dialog");
    trigger.focus();
    const lower = new ModalSurface();
    lower.initialFocus = "button";
    lower.innerHTML = "<button>Lower action</button>";
    document.body.append(lower);
    await lower.updateComplete;
    const lowerButton = requiredElement(lower.querySelector<HTMLButtonElement>("button"), "lower modal button");
    expect(document.activeElement).toBe(lowerButton);

    const view = await mountImageView();
    chatImage(view).click();
    await view.updateComplete;
    await lower.updateComplete;
    const dialog = imageDialog(view);

    expect(dialog.open).toBe(true);
    expect(lowerDialogSection(lower).getAttribute("aria-modal")).toBe("false");
    expect(lowerDialogSection(lower).getAttribute("aria-hidden")).toBe("true");
    expect(deepActiveElement(document)).toBe(imageCloseButton(dialog));

    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await view.updateComplete;
    await lower.updateComplete;

    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(lowerButton);
    expect(lowerDialogSection(lower).getAttribute("aria-modal")).toBe("true");
    expect(lowerDialogSection(lower).getAttribute("aria-hidden")).toBeNull();

    lower.remove();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ChatView tool-image gallery", () => {
  it("combines consecutive image outputs into one strip and gallery while retaining source details and actions", async () => {
    const view = await mountGalleryView([
      { role: "tool", entryId: "first", parts: [imagePart("QUJD")], meta: { model: { id: "first-model" } } },
      { role: "tool", entryId: "second", parts: [imagePart("REVG")], meta: { model: { id: "second-model" } } },
      { role: "tool", entryId: "third", parts: [imagePart("R0hJ")] },
    ]);
    const registry = new PluginRegistry();
    await registry.register({ id: "gallery-test", plugin: { apiVersion: 5, name: "Gallery test", activate: () => ({ contributions: {
      messageActions: [{ id: "inspect", title: "Inspect output", run: () => undefined }],
    } }) } });
    view.messageActions = registry.getMessageActions("local");
    view.messageActionContext = { machine: { id: "local", name: "Local", kind: "local" }, session: { id: view.sessionId, cwd: "/repo", archived: false, pending: false, busy: false } };
    const inspect = vi.fn<NonNullable<ChatView["onMessageAction"]>>(() => Promise.resolve());
    view.onMessageAction = inspect;
    await view.updateComplete;

    expect(view.renderRoot.querySelectorAll("article.tool-image-output")).toHaveLength(1);
    const thumbnails = transcriptImages(view);
    expect(thumbnails).toHaveLength(3);
    const origin = imageTrigger(thumbnails[1]);
    origin.focus();
    origin.click();
    await view.updateComplete;
    expectSelection(imageDialog(view), "REVG", 2, 3);
    galleryButton(imageDialog(view), "Next image").click();
    await view.updateComplete;
    expectSelection(imageDialog(view), "R0hJ", 3, 3);
    imageCloseButton(imageDialog(view)).click();
    await view.updateComplete;
    expect(origin.getRootNode()).toHaveProperty("activeElement", origin);

    const sources = requiredElement(view.renderRoot.querySelector<HTMLDetailsElement>(".image-output-sources"), "source details");
    expect(sources.open).toBe(false);
    expect(sources.querySelector("summary")?.textContent).toBe("Sources (3)");
    expect(sources.querySelector(".image-output-source")).toBeNull();
    sources.open = true;
    sources.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
    const second = requiredElement(sources.querySelector('[aria-label="Output 2"]'), "second source");
    const info = requiredElement(second.querySelector<HTMLButtonElement>('[aria-label="Message information"]'), "source information");
    info.click();
    await view.updateComplete;
    expect(second.querySelector(".msg-meta-details")?.textContent).toContain("second-model");
    requiredElement(second.querySelector<HTMLButtonElement>('[aria-label="Inspect output"]'), "source action").click();
    await view.updateComplete;
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[0].message.entryId).toBe("second");
    expect(inspect.mock.calls[0]?.[1]).toBe("gallery-test:inspect");
    sources.open = false;
    sources.dispatchEvent(new Event("toggle"));
    await view.updateComplete;
    expect(sources.querySelector(".image-output-source")).toBeNull();
    const anchors = [...view.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]")].map((element) => element.dataset["scrollAnchorId"]);
    expect(anchors).toEqual(['m:["first","tool","message"]', 'm:["second","tool","message"]', 'm:["third","tool","message"]']);
  });

  it("retains existing thumbnails when another consecutive output arrives", async () => {
    const view = await mountGalleryView([{ role: "tool", entryId: "first", parts: [imagePart("QUJD")] }]);
    const first = transcriptImages(view)[0];
    const trigger = imageTrigger(first);
    const native = imagePresentation(requiredElement(first, "first image")).renderRoot.querySelector("img");
    view.messages = [...view.messages, { role: "tool", entryId: "second", parts: [imagePart("REVG")] }];
    await view.updateComplete;
    for (const image of transcriptImages(view)) await settleImage(image);
    expect(view.renderRoot.querySelectorAll("article.tool-image-output")).toHaveLength(1);
    expect(transcriptImages(view)[0]).toBe(first);
    expect(imageTrigger(first)).toBe(trigger);
    expect(imagePresentation(requiredElement(first, "first image")).renderRoot.querySelector("img")).toBe(native);
    trigger.click();
    await view.updateComplete;
    expectSelection(imageDialog(view), "QUJD", 1, 2);
  });

  it("does not cross intervening activity when navigating separate tool outputs", async () => {
    const view = await mountGalleryView([
      toolImages("first", ["QUJD", "REVG", "R0hJ"]),
      toolImages("second", ["SktM", "TU5P"]),
    ]);
    const thumbnails = transcriptImages(view);
    expect(thumbnails).toHaveLength(5);
    const descriptions = [
      "read output image 1 of 3", "read output image 2 of 3", "read output image 3 of 3",
      "read output image 1 of 2", "read output image 2 of 2",
    ];
    for (const [index, image] of thumbnails.entries()) {
      expect(image).toHaveProperty("thumbnail", true);
      expect(image).toHaveProperty("description", descriptions[index]);
    }

    imageTrigger(thumbnails[1]).click();
    await view.updateComplete;
    let dialog = imageDialog(view);
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-label")).toBe("Image preview");
    expectSelection(dialog, "REVG", 2, 3);
    galleryButton(dialog, "Next image").click();
    await view.updateComplete;
    expectSelection(imageDialog(view), "R0hJ", 3, 3);
    expect(galleryButton(imageDialog(view), "Next image").disabled).toBe(true);
    imageCloseButton(imageDialog(view)).click();
    await view.updateComplete;

    imageTrigger(thumbnails[3]).click();
    await view.updateComplete;
    dialog = imageDialog(view);
    expectSelection(dialog, "SktM", 1, 2);
    expect(galleryButton(dialog, "Previous image").disabled).toBe(true);
    galleryButton(dialog, "Next image").click();
    await view.updateComplete;
    expectSelection(imageDialog(view), "TU5P", 2, 2);
    expect(galleryButton(imageDialog(view), "Next image").disabled).toBe(true);
  });

  it("restores focus to the originating thumbnail after navigating and closing", async () => {
    const view = await mountGalleryView([toolImages("read", ["QUJD", "REVG", "R0hJ"])]);
    const origin = imageTrigger(transcriptImages(view)[1]);
    origin.focus();
    origin.click();
    await view.updateComplete;
    galleryButton(imageDialog(view), "Next image").click();
    await view.updateComplete;
    imageCloseButton(imageDialog(view)).click();
    await view.updateComplete;
    expect(origin.getRootNode()).toHaveProperty("activeElement", origin);
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("shows a single tool image without gallery navigation", async () => {
    const view = await mountGalleryView([toolImages("read", ["QUJD"])]);
    imageTrigger(transcriptImages(view)[0]).click();
    await view.updateComplete;
    expectSingleImage(imageDialog(view), "data:image/png;base64,QUJD");
  });

  it("keeps adjacent user attachments as independent single-image previews", async () => {
    const view = await mountGalleryView([{ role: "user", parts: [imagePart("QUJD"), imagePart("REVG")] }]);
    imageTrigger(transcriptImages(view)[1]).click();
    await view.updateComplete;
    expectSingleImage(imageDialog(view), "data:image/png;base64,REVG");
  });

  it("keeps markdown images as single-image previews", async () => {
    const view = await mountGalleryView([{ role: "assistant", parts: [{ type: "text", text: "![Preview](/work/preview.png)" }] }]);
    view.workspaceContext = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };
    await view.updateComplete;
    const formatted = requiredElement(view.renderRoot.querySelector<FormattedText>("formatted-text"), "formatted text");
    await settleDeferredContent(view);
    const markdownImage = requiredElement(formatted.renderRoot.querySelector<MarkdownImage>("pi-web-markdown-image"), "markdown image");
    const presentation = await settleImage(markdownImage);
    const src = requiredElement(presentation.renderRoot.querySelector("img")?.getAttribute("src"), "markdown image source");
    requiredElement(presentation.renderRoot.querySelector<HTMLButtonElement>(".image-button"), "markdown image trigger").click();
    await view.updateComplete;
    expectSingleImage(imageDialog(view), src);
  });

  it.each(["sessionId", "machineId"] as const)("closes the gallery when %s changes", async (property) => {
    const view = await mountGalleryView([toolImages("read", ["QUJD", "REVG"])]);
    imageTrigger(transcriptImages(view)[0]).click();
    await view.updateComplete;
    const dialog = imageDialog(view);
    expect(dialog.open).toBe(true);
    view[property] = "other-context";
    await view.updateComplete;
    await view.updateComplete;
    expect(dialog.open).toBe(false);
    expect(imageDialog(view).querySelector(".image-zoom-full")).toBeNull();
    expect(hasRenderedModal(document)).toBe(false);
  });

  it("closes an open gallery and disables thumbnails when image loading is disabled", async () => {
    const view = await mountGalleryView([toolImages("read", ["QUJD", "REVG"])]);
    imageTrigger(transcriptImages(view)[0]).click();
    await view.updateComplete;
    const dialog = imageDialog(view);
    view.behaviors = { ...view.behaviors, loadImages: false };
    await view.updateComplete;
    await view.updateComplete;
    expect(dialog.open).toBe(false);
    expect(imageDialog(view).querySelector(".image-zoom-full")).toBeNull();
    expect(hasRenderedModal(document)).toBe(false);
    for (const image of transcriptImages(view)) {
      const presentation = await settleImage(image);
      expect(presentation.renderRoot.querySelector("img")?.hasAttribute("src")).toBe(false);
      expect(presentation.renderRoot.textContent).toContain("Image loading disabled");
      const trigger = presentation.renderRoot.querySelector<HTMLButtonElement>(".image-button");
      if (trigger !== null) {
        expect(trigger.disabled).toBe(true);
        trigger.click();
        await view.updateComplete;
        expect(hasRenderedModal(document)).toBe(false);
      }
    }
  });

});

function imagePart(data: string) {
  return { type: "image" as const, mimeType: "image/png", data };
}

function toolImages(entryId: string, data: string[]): ChatLine {
  return { role: "tool", entryId, parts: [
    { type: "toolResult", toolName: "read", text: "Read image file", isError: false },
    ...data.map(imagePart),
  ] };
}

async function mountGalleryView(messages: ChatLine[]): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-image";
  view.messages = messages;
  document.body.append(view);
  await view.updateComplete;
  for (const image of transcriptImages(view)) await settleImage(image);
  return view;
}

function transcriptImages(view: ChatView): TranscriptImage[] {
  return Array.from(view.renderRoot.querySelectorAll<TranscriptImage>("pi-web-transcript-image"));
}

function imageTrigger(image: TranscriptImage | undefined): HTMLButtonElement {
  return requiredElement(imagePresentation(requiredElement(image, "transcript image")).renderRoot.querySelector<HTMLButtonElement>(".image-button"), "thumbnail trigger");
}

function galleryButton(dialog: HTMLDialogElement, label: string): HTMLButtonElement {
  return requiredElement(dialog.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`), label);
}

function expectSelection(dialog: HTMLDialogElement, data: string, position: number, count: number): void {
  expect(dialog.querySelector(".image-zoom-full")?.getAttribute("src")).toBe(`data:image/png;base64,${data}`);
  expect(dialog.querySelector(".image-gallery-position")?.textContent.trim()).toBe(`Image ${String(position)} of ${String(count)}`);
}

function expectSingleImage(dialog: HTMLDialogElement, src: string): void {
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector(".image-zoom-full")?.getAttribute("src")).toBe(src);
  expect(dialog.querySelector('button[aria-label="Previous image"]')).toBeNull();
  expect(dialog.querySelector('button[aria-label="Next image"]')).toBeNull();
}

async function mountImageView(): Promise<ChatView> {
  const view = new ChatView();
  view.sessionId = "session-image";
  view.messages = [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: IMAGE_DATA }] }];
  document.body.append(view);
  await view.updateComplete;
  const transcript = requiredElement(view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image"), "transcript image");
  await settleImage(transcript);
  return view;
}

function chatImage(view: ChatView): HTMLElement {
  const transcript = requiredElement(view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image"), "transcript image");
  return requiredElement(imagePresentation(transcript).renderRoot.querySelector<HTMLElement>(".image-button"), "image trigger");
}

function imageGallery(view: ChatView): ImageGalleryDialog {
  return requiredElement(view.renderRoot.querySelector<ImageGalleryDialog>("pi-web-image-gallery-dialog"), "image gallery");
}

function imageDialog(view: ChatView): HTMLDialogElement {
  return requiredElement(imageGallery(view).renderRoot.querySelector<HTMLDialogElement>("dialog.image-zoom"), "image zoom dialog");
}

function imageCloseButton(dialog: HTMLDialogElement): HTMLButtonElement {
  return requiredElement(dialog.querySelector<HTMLButtonElement>(".image-zoom-close"), "image close button");
}

function lowerDialogSection(surface: ModalSurface): HTMLElement {
  return requiredElement(surface.shadowRoot?.querySelector<HTMLElement>("dialog[role='dialog']"), "lower dialog section");
}

function appendButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = text;
  document.body.append(button);
  return button;
}

function requiredElement<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`);
  return value;
}
