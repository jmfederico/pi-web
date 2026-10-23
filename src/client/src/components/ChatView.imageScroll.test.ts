// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatScrollController } from "../chatScrollPosition";
import { ChatView } from "./ChatView";
import { settleImage } from "./imagePresentation.testSupport";
import type { TranscriptImage } from "./TranscriptImage";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function readingHistory() {
  // Session restoration remains frame-based; hold those unrelated startup frames.
  const scheduleFrame = vi.fn<typeof requestAnimationFrame>().mockReturnValue(1);
  vi.stubGlobal("requestAnimationFrame", scheduleFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const view = new ChatView();
  view.sessionId = "image-history";
  view.messages = [
    { role: "user", parts: [{ type: "image", mimeType: "image/png", data: "QUJD" }] },
    { role: "assistant", parts: [{ type: "text", text: "Reading history" }] },
  ];
  document.body.append(view);
  await view.updateComplete;
  const host = view.renderRoot.querySelector<TranscriptImage>("pi-web-transcript-image");
  if (host === null) throw new Error("Expected transcript image");
  const presentation = await settleImage(host);
  const image = presentation.renderRoot.querySelector("img");
  const scroller = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  if (image === null || scroller === null) throw new Error("Expected native image and transcript");
  // Geometry collaborators are stubbed; this test does not assert DOM layout.
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 6000 } });
  let top = 2445;
  const write = vi.fn((value: number) => { top = value; });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: write });
  scroller.dispatchEvent(new Event("scroll"));
  await view.updateComplete;
  const restore = vi.spyOn(ChatScrollController.prototype, "restoreExplicitPosition");
  const render = vi.spyOn(view, "render");
  scheduleFrame.mockClear();
  write.mockClear();
  return { view, presentation, image, scroller, write, restore, render, scheduleFrame };
}

describe("ChatView browser-owned image layout", () => {
  it.each(["load", "error"])("does not restore, follow, or rerender history on a native image %s event", async (type) => {
    const { presentation, image, scroller, write, restore, render, scheduleFrame } = await readingHistory();
    image.dispatchEvent(new Event(type));
    await presentation.updateComplete;
    expect(presentation.renderRoot.querySelector("img")).toBe(image);
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(scroller.scrollTop).toBe(2445);
    expect(write).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it("does not apply legacy image-layout corrections from transcript descendants", async () => {
    const { scroller, write, restore, render, scheduleFrame } = await readingHistory();
    for (const type of ["image-will-layout", "image-layout"]) {
      scroller.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
    expect(write).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(scheduleFrame).not.toHaveBeenCalled();
  });
});
