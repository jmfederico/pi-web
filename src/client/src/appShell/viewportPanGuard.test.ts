// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { dragWouldPanPage, ViewportPanGuard } from "./viewportPanGuard";

const atTop = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
const middle = { scrollTop: 300, scrollHeight: 1000, clientHeight: 400 };
const atBottom = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };

const vertical = (...scrollers: typeof atTop[]) => ({ vertical: scrollers, horizontal: false });
const none = vertical();

describe("dragWouldPanPage", () => {
  it("blocks any first move where nothing under the finger can scroll", () => {
    // Safari commits on the first move, which is often tiny, flat, or diagonal.
    expect(dragWouldPanPage(none, 0, 10)).toBe(true);
    expect(dragWouldPanPage(none, 0, 0)).toBe(true);
    expect(dragWouldPanPage(none, 20, 10)).toBe(true);
  });

  it("blocks vertical drags only once every vertical scroller is at that end", () => {
    expect(dragWouldPanPage(vertical(atTop), 0, 10)).toBe(true);
    expect(dragWouldPanPage(vertical(atBottom), 0, -10)).toBe(true);
    // A nested scroller at its end chains to an outer one that can still move.
    expect(dragWouldPanPage(vertical(atTop, middle), 0, 10)).toBe(false);
    expect(dragWouldPanPage(vertical(atTop), 0, -10)).toBe(false);
    expect(dragWouldPanPage(vertical(atBottom), 0, 10)).toBe(false);
    expect(dragWouldPanPage(vertical(middle), 0, 10)).toBe(false);
    expect(dragWouldPanPage(vertical(middle), 20, 10)).toBe(false);
  });

  it("keeps horizontal scrollers usable while blocking vertical page drags over them", () => {
    const strip = { vertical: [], horizontal: true };
    expect(dragWouldPanPage(strip, 20, 5)).toBe(false);
    expect(dragWouldPanPage(strip, 5, 20)).toBe(true);
  });
});

describe("ViewportPanGuard", () => {
  const guard = new ViewportPanGuard();
  afterEach(() => { guard.setActive(false); document.body.replaceChildren(); });

  function drag(target: Element, fromY: number, toY: number, x = 200): TouchEvent {
    const start = new TouchEvent("touchstart", { bubbles: true, composed: true, touches: [new Touch({ identifier: 1, target, clientX: x, clientY: fromY })] });
    target.dispatchEvent(start);
    const move = new TouchEvent("touchmove", { bubbles: true, composed: true, cancelable: true, touches: [new Touch({ identifier: 1, target, clientX: x, clientY: toY })] });
    target.dispatchEvent(move);
    return move;
  }

  it("cancels page-panning drags only while active, sparing editors and screen edges", () => {
    const header = document.createElement("header");
    const editor = document.createElement("textarea");
    document.body.append(header, editor);

    expect(drag(header, 100, 150).defaultPrevented).toBe(false);
    guard.setActive(true);
    expect(drag(header, 100, 150).defaultPrevented).toBe(true);
    expect(drag(editor, 100, 150).defaultPrevented).toBe(false);
    expect(drag(header, 100, 150, 5).defaultPrevented).toBe(false);
    guard.setActive(false);
    expect(drag(header, 100, 150).defaultPrevented).toBe(false);
  });

  it("cancels trackpad scrolling that would pan the page, but not pinch zoom", () => {
    const header = document.createElement("header");
    document.body.append(header);
    const wheel = (init: WheelEventInit): WheelEvent => {
      const event = new WheelEvent("wheel", { bubbles: true, composed: true, cancelable: true, ...init });
      // happy-dom ignores modifier keys in WheelEventInit.
      Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey === true });
      header.dispatchEvent(event);
      return event;
    };
    expect(wheel({ deltaY: 40 }).defaultPrevented).toBe(false);
    guard.setActive(true);
    expect(wheel({ deltaY: 40 }).defaultPrevented).toBe(true);
    expect(wheel({ deltaY: -40 }).defaultPrevented).toBe(true);
    expect(wheel({ deltaY: 40, ctrlKey: true }).defaultPrevented).toBe(false);
  });
});
