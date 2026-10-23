// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { html, render } from "lit";
import type { ContentRendererContribution } from "../../../plugin-api";
import { FormattedText } from "./FormattedText";
import { ContentRendererHost } from "./ContentRendererHost";
import { ContentRenderingBoundary } from "./ContentRenderingBoundary";
import { createContentRenderingCapability, createContentRenderingService } from "../formatting/contentRendering";
import * as markdown from "../formatting/markdown";
import { advanceContentFrame, settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";

useDeferredContent();
afterEach(() => { localStorage.clear(); });

function viewport() {
  const targets = new Map<Element, { callback: IntersectionObserverCallback; observer: IntersectionObserver }>();
  vi.stubGlobal("IntersectionObserver", class implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly scrollMargin = "0px";
    readonly thresholds = [0];
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { targets.set(target, { callback: this.callback, observer: this }); }
    unobserve(target: Element) { targets.delete(target); }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    disconnect() { for (const [target, entry] of targets) if (entry.observer === this) targets.delete(target); }
  });
  return (target: Element, ...intersections: boolean[]) => {
    const entry = targets.get(target);
    entry?.callback(intersections.map((isIntersecting) => ({
      target, isIntersecting, time: performance.now(), intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(), intersectionRect: new DOMRectReadOnly(), rootBounds: null,
    })), entry.observer);
  };
}

it("paints escaped source before Markdown, renderer inspection, and plugin execution in separate turns", async () => {
  const format = vi.spyOn(markdown, "toSafeMarkdownHtml");
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Enhanced</b>`);
  const select = vi.fn(() => [{ id: "test", label: "Test", renderer: { id: "test", renderMode: "automatic" as const, render: draw } }]);
  const view = new FormattedText();
  view.text = '**Readable**\n\n```test\n<script>unsafe()</script>\n```';
  view.contentRendering = createContentRenderingService(select);
  document.body.append(view);
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".pending-source")?.textContent).toBe(view.text);
  expect(view.renderRoot.querySelector("script, strong, pi-web-content-renderer")).toBeNull();
  expect(format).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  expect(draw).not.toHaveBeenCalled();

  await advanceContentFrame(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Readable");
  expect(select).not.toHaveBeenCalled();
  await advanceContentFrame(view);
  expect(select).toHaveBeenCalledOnce();
  expect(draw).not.toHaveBeenCalled();
  const host = view.renderRoot.querySelector<ContentRendererHost>("pi-web-content-renderer");
  expect(host?.renderRoot.querySelector("pre")?.textContent).toBe("<script>unsafe()</script>");
  await settleDeferredContent(view);
  expect(draw).toHaveBeenCalledOnce();
  expect(host?.renderRoot.querySelector("b")?.textContent).toBe("Enhanced");
});

it.each([false, true])("keeps formatted content without a raw tail between streaming updates (previews: %s)", async (previews) => {
  const view = new FormattedText();
  if (previews) view.contentRendering = createContentRenderingService(() => []);
  view.text = "A **streaming** paragraph";
  document.body.append(view);
  await settleDeferredContent(view);
  const paragraph = view.renderRoot.querySelector("p");
  expect(paragraph?.textContent).toBe("A streaming paragraph");

  for (const chunk of [" with", " more", " words"]) {
    const previousText = view.renderRoot.querySelector("p")?.textContent;
    view.text += chunk;
    await view.updateComplete;
    expect(view.renderRoot.querySelector("p")?.textContent).toBe(previousText);
    expect(view.renderRoot.querySelector<HTMLElement>(".pending-source")?.hidden).toBe(true);
    await settleDeferredContent(view);
  }
  expect(view.renderRoot.querySelector("p")?.textContent).toBe("A streaming paragraph with more words");
  expect(view.renderRoot.querySelector<HTMLElement>(".pending-source")?.hidden).toBe(true);
});

it("shows replacement source immediately instead of stale formatted content", async () => {
  const view = new FormattedText();
  view.text = "**Original**";
  document.body.append(view);
  await settleDeferredContent(view);
  view.text = "**Replacement**";
  await view.updateComplete;
  expect(view.renderRoot.querySelector<HTMLElement>(".enhanced-content")?.hidden).toBe(true);
  const source = view.renderRoot.querySelector<HTMLElement>(".pending-source");
  expect(source?.hidden).toBe(false);
  expect(source?.textContent).toBe("**Replacement**");
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Replacement");
});

it("falls back to the latest source if formatting a streaming update fails", async () => {
  const view = new FormattedText();
  view.text = "**Original**";
  document.body.append(view);
  await settleDeferredContent(view);
  vi.spyOn(markdown, "toSafeMarkdownHtml").mockImplementation(() => { throw new Error("Formatting failed"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  view.text += " latest words";
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector<HTMLElement>(".enhanced-content")?.hidden).toBe(true);
  const source = view.renderRoot.querySelector<HTMLElement>(".pending-source");
  expect(source?.hidden).toBe(false);
  expect(source?.textContent).toBe(view.text);
  expect(warn).toHaveBeenCalledWith("Chat Markdown formatting failed; source remains available", expect.any(Error));
});

it("formats only intersecting content and coalesces invisible updates to the latest source", async () => {
  const intersect = viewport();
  const format = vi.spyOn(markdown, "toSafeMarkdownHtml");
  const view = new FormattedText();
  view.text = "**Old**";
  document.body.append(view);
  await settleDeferredContent(view);
  view.text = "**Latest**";
  await settleDeferredContent(view);
  expect(format).not.toHaveBeenCalled();
  expect(view.renderRoot.querySelector(".pending-source")?.textContent).toBe("**Latest**");
  intersect(view, true);
  await settleDeferredContent(view);
  expect(format).toHaveBeenCalledOnce();
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Latest");
});

async function mountPendingMarkdown(kind: "chat" | "public") {
  const view = kind === "chat" ? new FormattedText() : new ContentRenderingBoundary();
  if (view instanceof FormattedText) view.text = "**Rendered**";
  else {
    view.source = "**Rendered**";
    view.renderContent = () => html`<strong>Rendered</strong>`;
  }
  document.body.append(view);
  await view.updateComplete;
  const target = view instanceof FormattedText ? view : view.querySelector(".content-rendering-body");
  if (target === null) throw new Error("Missing Markdown visibility target");
  return { view, target };
}

it.each(["chat", "public"] as const)("uses the latest batched visibility for %s Markdown", async (kind) => {
  const intersect = viewport();
  const { view, target } = await mountPendingMarkdown(kind);

  // One notification may contain several transitions for the same target.
  intersect(target, false, true);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Rendered");
});

it.each(["chat", "public"] as const)("keeps %s Markdown deferred when the latest batched visibility is offscreen", async (kind) => {
  const intersect = viewport();
  const { view, target } = await mountPendingMarkdown(kind);

  intersect(target, true, false);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")).toBeNull();
  expect(view.renderRoot.textContent).toContain("**Rendered**");
  intersect(target, true);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Rendered");
});

it.each(["chat", "public"] as const)("resumes cancelled %s Markdown without a source change", async (kind) => {
  const intersect = viewport();
  const { view, target } = await mountPendingMarkdown(kind);

  intersect(target, true);
  await view.updateComplete;
  intersect(target, false);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")).toBeNull();
  intersect(target, true);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Rendered");
});

it.each(["chat", "public"] as const)("resumes %s Markdown after an update completes while detached", async (kind) => {
  const intersect = viewport();
  const { view, target } = await mountPendingMarkdown(kind);
  if (view instanceof FormattedText) view.text = "**Replacement**";
  else {
    view.source = "**Replacement**";
    view.renderContent = () => html`<strong>Replacement</strong>`;
  }
  view.remove();
  await view.updateComplete;
  document.body.append(view);
  await view.updateComplete;
  // Only targets registered by the reconnected observer receive notifications.
  intersect(target, true);
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Replacement");
});

it("cancels queued formatting on detach and resumes the latest content on reconnect", async () => {
  const format = vi.spyOn(markdown, "toSafeMarkdownHtml");
  const view = new FormattedText();
  view.text = "**Before**";
  document.body.append(view);
  await view.updateComplete;
  view.remove();
  await settleDeferredContent();
  expect(format).not.toHaveBeenCalled();
  view.text = "**After**";
  document.body.append(view);
  await settleDeferredContent(view);
  expect(format).toHaveBeenCalledOnce();
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("After");
});

it("keeps Markdown readable when inspection fails and lets other content finish", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const inspect = vi.fn(() => { throw new Error("Plugin inspection failed"); });
  const first = new FormattedText();
  first.text = "**First**";
  first.contentRendering = { renderMarkdown: inspect };
  const second = new FormattedText();
  second.text = "**Second**";
  document.body.append(first, second);
  await settleDeferredContent(first);
  expect(first.renderRoot.querySelector("strong")?.textContent).toBe("First");
  expect(second.renderRoot.querySelector("strong")?.textContent).toBe("Second");
  expect(inspect).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("Chat content enhancement failed; Markdown remains available", expect.any(Error));
});

it("does not prepare Markdown inside closed composed disclosures", async () => {
  const format = vi.spyOn(markdown, "toSafeMarkdownHtml");
  const group = document.createElement("details");
  const bridge = document.createElement("div");
  const view = new FormattedText();
  view.text = "**Deferred**";
  bridge.attachShadow({ mode: "open" }).append(view);
  group.append(document.createElement("summary"), bridge);
  document.body.append(group);
  await settleDeferredContent(view);
  expect(format).not.toHaveBeenCalled();
  group.open = true;
  group.dispatchEvent(new Event("toggle"));
  await settleDeferredContent(view);
  expect(view.renderRoot.querySelector("strong")?.textContent).toBe("Deferred");
});

it("keeps public plugin Markdown calls independent of formatting work", async () => {
  const toSafeHtml = vi.fn(() => "<strong>Public content</strong>");
  const capability = createContentRenderingCapability(() => []);
  const root = document.createElement("div");
  document.body.append(root);
  render(capability.renderMarkdown({ text: "**Public content**", machineId: "local", toSafeHtml }), root);
  const boundary = root.querySelector<ContentRenderingBoundary>("pi-web-content-rendering-boundary");
  if (boundary === null) throw new Error("Missing boundary");
  await boundary.updateComplete;
  expect(toSafeHtml).not.toHaveBeenCalled();
  expect(boundary.textContent).toContain("**Public content**");
  await settleDeferredContent(boundary);
  expect(boundary.querySelector("strong")?.textContent).toBe("Public content");
});

it("defers offscreen plugin callbacks and aborts active previews when they leave the viewport", async () => {
  const intersect = viewport();
  const draw = vi.fn<ContentRendererContribution["render"]>(() => html`<b>Preview</b>`);
  const host = new ContentRendererHost();
  host.text = "source";
  host.choices = [{ id: "test", label: "Test", renderer: { id: "test", renderMode: "automatic", render: draw } }];
  document.body.append(host);
  await settleDeferredContent(host);
  expect(draw).not.toHaveBeenCalled();
  intersect(host, true);
  await host.updateComplete;
  intersect(host, false);
  await settleDeferredContent(host);
  expect(draw).not.toHaveBeenCalled();
  intersect(host, true);
  await settleDeferredContent(host);
  expect(draw).toHaveBeenCalledOnce();
  const input = draw.mock.calls[0]?.[0];
  intersect(host, false);
  expect(input?.signal.aborted).toBe(true);
  await settleDeferredContent(host);
  expect(host.renderRoot.querySelector("pre")?.textContent).toBe("source");
});
