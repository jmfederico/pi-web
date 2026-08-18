import type { TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import type { ChatLine } from "./shared";
import {
  ChatView,
  chatImagePartSource,
  chatMessageAnchorKey,
  chatToolOutputLabel,
} from "./ChatView";
import { templateEventHandlerAfterMarker } from "../templateInspection.testSupport";

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
  // Escape hatch: these two cases verify Lit event wiring (`@load` re-pin and
  // `@click` zoom) whose only observable effect is a private state/scroll side
  // effect. Vitest runs with no DOM environment here, so a shadow-DOM click
  // harness would add disproportionate setup; direct handler extraction anchored
  // to the stable `@load=`/`@click=` attribute markup is proportionate.
  it("re-pins late image loads only while already pinned to the bottom", () => {
    const view = new ChatView();
    let scrollCalls = 0;
    if (!Reflect.set(view, "scrollToBottom", () => { scrollCalls += 1; })) throw new Error("Could not observe ChatView.scrollToBottom");
    const rendered = renderPart(view, { type: "image", mimeType: "image/png", data: "QUJD" });
    const onLoad = templateEventHandlerAfterMarker(rendered, "@load=");

    if (!Reflect.set(view, "pinnedToBottom", true)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));
    if (!Reflect.set(view, "pinnedToBottom", false)) throw new Error("Could not set ChatView.pinnedToBottom");
    onLoad(new Event("load"));

    expect(scrollCalls).toBe(1);
  });

  it("opens and closes the image zoom target on click and close", () => {
    const view = new ChatView();
    const part = { type: "image", mimeType: "image/png", data: "QUJD" } as const;
    const rendered = renderPart(view, part);
    const onClick = templateEventHandlerAfterMarker(rendered, "@click=");

    expect(zoomedImage(view)).toBeUndefined();
    onClick(new Event("click"));
    expect(zoomedImage(view)).toEqual(chatImagePartSource(part));

    const close: unknown = Reflect.get(view, "closeImageZoom");
    if (typeof close !== "function") throw new Error("ChatView.closeImageZoom is not callable");
    close.call(view);
    expect(zoomedImage(view)).toBeUndefined();
  });
});

function zoomedImage(view: ChatView): unknown {
  return Reflect.get(view, "zoomedImage");
}

type RenderPart = (this: ChatView, part: ChatLine["parts"][number], message?: ChatLine) => TemplateResult;

function renderPart(view: ChatView, part: ChatLine["parts"][number], message?: ChatLine): TemplateResult {
  const method: unknown = Reflect.get(view, "renderPart");
  if (!isRenderPart(method)) throw new Error("ChatView.renderPart is not callable");
  return method.call(view, part, message);
}

function isRenderPart(value: unknown): value is RenderPart {
  return typeof value === "function";
}
