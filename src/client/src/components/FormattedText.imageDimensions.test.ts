// @vitest-environment happy-dom
import { useDeferredContent, settleDeferredContent } from "../formatting/deferredContent.testSupport";
import { afterEach, expect, it, vi } from "vitest";
import { html } from "lit";
import { workspaceFilePreviewUrl } from "../api/urls";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { createContentRenderingService } from "../formatting/contentRendering";
import { readMarkdownImageDimensions, rememberMarkdownImageDimensions } from "../formatting/markdownImageDimensions";
import { FormattedText } from "./FormattedText";
import type { MarkdownImage } from "./MarkdownImage";
import { loadIntrinsicDimensions, nativeImage, settleImage } from "./imagePresentation.testSupport";

const source = "https://placehold.co/640x360/png?text=remembered";
const text = `Before\n\n![External image](${source})\n\nAfter`;

useDeferredContent();

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

async function mount(content = text, imagesEnabled = true) {
  const view = new FormattedText();
  view.text = content;
  view.imagesEnabled = imagesEnabled;
  document.body.append(view);
  await settleDeferredContent(view);
  return view;
}

function imageIn(view: FormattedText): HTMLImageElement {
  const image = view.renderRoot.querySelector("img");
  if (image === null) throw new Error("Expected ordinary native image");
  return image;
}

it("learns from a non-bubbling native load without rerendering or rebuilding surrounding content", async () => {
  const view = await mount(`${text}\n\n\`\`\`js\nconst retained = true;\n\`\`\``);
  const image = imageIn(view);
  const copyButton = view.renderRoot.querySelector(".code-copy-button");
  expect(copyButton).not.toBeNull();
  expect(image.hasAttribute("width")).toBe(false);
  const render = vi.spyOn(view, "render");
  const update = vi.spyOn(view, "requestUpdate");
  loadIntrinsicDimensions(image, 640, 360);
  await settleDeferredContent(view);
  expect(readMarkdownImageDimensions(source)).toEqual({ width: 640, height: 360 });
  expect(image.getAttribute("width")).toBe("640");
  expect(image.getAttribute("height")).toBe("360");
  expect(imageIn(view)).toBe(image);
  expect(view.renderRoot.querySelector(".code-copy-button")).toBe(copyButton);
  expect(render).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it("restores hints on a new mount even when the Markdown HTML was cached before the image loaded", async () => {
  const html = toSafeMarkdownHtml(text);
  expect(html).not.toContain("width=");
  const first = await mount();
  loadIntrinsicDimensions(imageIn(first), 640, 360);
  first.remove();
  expect(toSafeMarkdownHtml(text)).toBe(html);
  const returned = await mount();
  const image = imageIn(returned);
  expect(image.getAttribute("width")).toBe("640");
  expect(image.getAttribute("height")).toBe("360");
  expect(image.src).toBe(source);
  expect(image.getAttribute("loading")).toBe("lazy");
  expect(image.getAttribute("decoding")).toBe("async");
  expect(image.hasAttribute("crossorigin")).toBe(false);
  expect(returned.renderRoot.querySelector("pi-web-markdown-image")).toBeNull();
});

it("reserves external images through the normal content-rendering service without activating Mermaid", async () => {
  rememberMarkdownImageDimensions(source, { width: 640, height: 360 });
  const draw = vi.fn(() => html`<p>Unrequested preview</p>`);
  const view = new FormattedText();
  view.contentRendering = createContentRenderingService((request) => request.language === "mermaid" ? [{
    id: "test:diagram", label: "Mermaid", renderer: { id: "diagram", languages: ["mermaid"], render: draw },
  }] : []);
  view.text = `${text}\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\``;
  document.body.append(view);
  await settleDeferredContent(view);
  const image = imageIn(view);
  expect(image.getAttribute("width")).toBe("640");
  expect(image.getAttribute("height")).toBe("360");
  loadIntrinsicDimensions(image, 640, 360);
  expect(readMarkdownImageDimensions(source)).toEqual({ width: 640, height: 360 });
  expect(view.renderRoot.querySelector("pi-web-content-renderer")).not.toBeNull();
  expect(draw).not.toHaveBeenCalled();
});

it("corrects stale dimensions in place without reactive history updates", async () => {
  rememberMarkdownImageDimensions(source, { width: 1200, height: 800 });
  const view = await mount();
  const image = imageIn(view);
  expect(image.getAttribute("width")).toBe("1200");
  const update = vi.spyOn(view, "requestUpdate");
  loadIntrinsicDimensions(image, 400, 1600);
  expect(image.getAttribute("width")).toBe("400");
  expect(image.getAttribute("height")).toBe("1600");
  expect(imageIn(view)).toBe(image);
  expect(image.src).toBe(source);
  expect(readMarkdownImageDimensions(source)).toEqual({ width: 400, height: 1600 });
  expect(update).not.toHaveBeenCalled();
});

it("retains linked images as ordinary native images without adding controls", async () => {
  rememberMarkdownImageDimensions(source, { width: 640, height: 360 });
  const view = await mount(`[![External image](${source})](https://example.test/destination)`);
  const image = imageIn(view);
  const anchor = view.renderRoot.querySelector("a");
  expect(anchor).not.toBeNull();
  expect(image.parentElement).toBe(anchor);
  expect(anchor?.href).toBe("https://example.test/destination");
  expect(anchor?.target).toBe("_blank");
  expect(view.renderRoot.querySelector("button")).toBeNull();
});

it("does not record errors or invalid decode metadata", async () => {
  const view = await mount();
  const image = imageIn(view);
  image.dispatchEvent(new Event("error"));
  loadIntrinsicDimensions(image, 0, 360);
  expect(localStorage.length).toBe(0);
  expect(image.hasAttribute("width")).toBe(false);
});

it("keeps disabled images inert even with a saved hint, and restores hints when enabled", async () => {
  rememberMarkdownImageDimensions(source, { width: 640, height: 360 });
  const view = await mount(text, false);
  const disabled = imageIn(view);
  expect(disabled.hasAttribute("src")).toBe(false);
  expect(disabled.hasAttribute("width")).toBe(false);
  loadIntrinsicDimensions(disabled, 400, 1600);
  expect(readMarkdownImageDimensions(source)).toEqual({ width: 640, height: 360 });
  view.imagesEnabled = true;
  await settleDeferredContent(view);
  const enabled = imageIn(view);
  expect(enabled.src).toBe(source);
  expect(enabled.getAttribute("width")).toBe("640");
  expect(enabled.getAttribute("height")).toBe("360");
});

it("does not traverse filesystem-image shadow roots or turn geometry into outside-workspace approval", async () => {
  const context = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };
  const preview = workspaceFilePreviewUrl("p", "w", "/tmp/outside.png", { machineId: "local", showImage: true });
  rememberMarkdownImageDimensions(preview, { width: 1200, height: 800 });
  const view = new FormattedText();
  view.workspaceContext = context;
  view.text = "![Outside](/tmp/outside.png)";
  document.body.append(view);
  await settleDeferredContent(view);
  const markdownImage = view.renderRoot.querySelector<MarkdownImage>("pi-web-markdown-image");
  if (markdownImage === null) throw new Error("Expected gated filesystem image");
  const presentation = await settleImage(markdownImage);
  const image = nativeImage(presentation);
  expect(view.renderRoot.querySelector("img")).toBeNull();
  expect(image.hasAttribute("src")).toBe(false);
  loadIntrinsicDimensions(image, 400, 1600);
  expect(image.hasAttribute("src")).toBe(false);
  expect(readMarkdownImageDimensions(preview)).toEqual({ width: 1200, height: 800 });
});

it("preserves normal loading and current geometry when storage reads and writes are blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
  const view = await mount();
  const image = imageIn(view);
  expect(image.src).toBe(source);
  expect(image.hasAttribute("width")).toBe(false);
  loadIntrinsicDimensions(image, 640, 360);
  expect(imageIn(view)).toBe(image);
  expect(image.src).toBe(source);
  expect(image.getAttribute("width")).toBe("640");
  expect(image.getAttribute("height")).toBe("360");
});
