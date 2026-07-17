import type { TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import type { ChatLine } from "./shared";
import { ChatView, chatMessageMetadataLabel } from "./ChatView";

describe("ChatView image rendering", () => {
  // Direct handler extraction keeps this node-environment test focused on the
  // late image-load scroll wiring without introducing a component-wide DOM shim.
  it("renders native image data and re-pins late loads only while already pinned", () => {
    const view = new ChatView();
    let scrollCalls = 0;
    if (!Reflect.set(view, "scrollToBottom", () => { scrollCalls += 1; })) throw new Error("Could not observe ChatView.scrollToBottom");
    const rendered = renderPart(view, { type: "image", mimeType: "image/png", data: "QUJD" });
    const onLoad = templateEventHandler(rendered, "@load=");

    expect(templateStaticMarkup(rendered)).toContain("<img");
    expect(templateStaticMarkup(rendered)).toContain('loading="lazy"');
    expect(templateStaticMarkup(rendered)).toContain('role="button"');
    expect(templateValuesAfterMarker(rendered, "src=")).toEqual(["data:image/png;base64,QUJD"]);

    if (!Reflect.set(view, "pinnedToBottom", true)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));
    if (!Reflect.set(view, "pinnedToBottom", false)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));

    expect(scrollCalls).toBe(1);
  });

  // Clicking an image records the zoom target so the modal dialog can present
  // it at full size, and dismissing clears the target.
  it("opens and closes the image zoom target on click and close", () => {
    const view = new ChatView();
    const rendered = renderPart(view, { type: "image", mimeType: "image/png", data: "QUJD" });
    const onClick = templateEventHandler(rendered, "@click=");

    expect(zoomedImage(view)).toBeUndefined();
    onClick(new Event("click"));
    expect(zoomedImage(view)).toEqual({ src: "data:image/png;base64,QUJD", alt: "attached image" });

    const close: unknown = Reflect.get(view, "closeImageZoom");
    if (typeof close !== "function") throw new Error("ChatView.closeImageZoom is not callable");
    close.call(view);
    expect(zoomedImage(view)).toBeUndefined();
  });

  // Direct rendering keeps this node-environment test focused on the dedicated
  // tool-image presentation without introducing a component-wide DOM shim.
  it("renders tool images as labeled standard messages with final metadata", () => {
    const message: ChatLine = {
      role: "tool",
      parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }],
      meta: { timestamp: "2026-07-13T22:00:00.000Z" },
    };
    const rendered = renderToolImageOutput(new ChatView(), message, 7, "read");
    const markup = templateStaticMarkup(rendered);

    expect(markup).toContain('class="msg tool-image-output"');
    expect(markup).not.toContain('class="msg tool"');
    expect(markup).toContain("<img");
    expect(templateValuesAfterMarker(rendered, '<b class="label">')).toEqual(["read output"]);
    expect(templateValuesAfterMarker(rendered, "title=").filter((value) => typeof value === "string")).toEqual([chatMessageMetadataLabel(message)]);
    expect(templateValuesAfterMarker(rendered, "data-scroll-anchor-id=")).toEqual(["m:7"]);
  });
});

function zoomedImage(view: ChatView): unknown {
  return Reflect.get(view, "zoomedImage");
}

type RenderPart = (this: ChatView, part: ChatLine["parts"][number], message?: ChatLine) => TemplateResult;
type RenderToolImageOutput = (this: ChatView, message: ChatLine, index: number, toolName?: string) => TemplateResult;
type TemplateEventHandler = (event: Event) => void;

function renderPart(view: ChatView, part: ChatLine["parts"][number], message?: ChatLine): TemplateResult {
  const method: unknown = Reflect.get(view, "renderPart");
  if (!isRenderPart(method)) throw new Error("ChatView.renderPart is not callable");
  return method.call(view, part, message);
}

function renderToolImageOutput(view: ChatView, message: ChatLine, index: number, toolName?: string): TemplateResult {
  const method: unknown = Reflect.get(view, "renderToolImageOutput");
  if (!isRenderToolImageOutput(method)) throw new Error("ChatView.renderToolImageOutput is not callable");
  return method.call(view, message, index, toolName);
}

function templateEventHandler(template: TemplateResult, marker: string): TemplateEventHandler {
  const strings = templateStrings(template);
  const values = templateValues(template);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (strings[index]?.includes(marker) === true && isTemplateEventHandler(value)) return value;
  }
  throw new Error(`Expected template event handler after ${marker}`);
}

function isRenderPart(value: unknown): value is RenderPart {
  return typeof value === "function";
}

function isRenderToolImageOutput(value: unknown): value is RenderToolImageOutput {
  return typeof value === "function";
}

function isTemplateEventHandler(value: unknown): value is TemplateEventHandler {
  return typeof value === "function";
}

function templateStaticMarkup(template: TemplateResult): string {
  const chunks: string[] = [];
  visit(template);
  return chunks.join("");

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    chunks.push(...templateStrings(value));
    for (const child of templateValues(value)) visit(child);
  }
}

function templateValuesAfterMarker(template: TemplateResult, marker: string): unknown[] {
  const matches: unknown[] = [];
  visit(template);
  return matches;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isTemplateResult(value)) return;
    const strings = templateStrings(value);
    const values = templateValues(value);
    for (let index = 0; index < values.length; index += 1) {
      if (strings[index]?.includes(marker) === true) matches.push(values[index]);
      visit(values[index]);
    }
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
