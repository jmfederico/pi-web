// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { NavigationSectionResizeHandle } from "./NavigationSectionResizeHandle";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mountHandle() {
  const handle = new NavigationSectionResizeHandle();
  handle.sectionLabel = "Projects";
  handle.controls = "navigation-projects";
  handle.measurement = { height: 150, maxHeight: 400 };
  const resize = vi.fn<(height: number) => void>();
  handle.onResize = resize;
  handle.onReset = vi.fn();
  document.body.append(handle);
  await handle.updateComplete;
  const separator = handle.shadowRoot?.querySelector<HTMLElement>('[role="separator"]');
  if (separator === null || separator === undefined) throw new Error("Missing resize separator");
  return { handle, separator, resize };
}

describe("navigation section resizing", () => {
  it("exposes a horizontal separator for the section above and supports keyboard sizing", async () => {
    const { handle, separator } = await mountHandle();
    expect(separator.getAttribute("aria-label")).toBe("Resize Projects");
    expect(separator.getAttribute("aria-controls")).toBe("navigation-projects");
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.getAttribute("aria-valuenow")).toBe("150");
    expect(separator.getAttribute("aria-valuemax")).toBe("400");

    for (const [key, shiftKey, expected] of [
      ["ArrowDown", false, 174], ["ArrowUp", false, 126],
      ["ArrowDown", true, 222], ["Home", false, 44], ["End", false, 400],
    ] as const) {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
      expect(handle.onResize).toHaveBeenLastCalledWith(expected);
    }
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(handle.onReset).toHaveBeenCalledOnce();
  });

  it("uses updated measurements supplied by its owner for accessibility and interaction", async () => {
    const { handle, separator, resize } = await mountHandle();
    handle.measurement = { height: 220, maxHeight: 230 };
    await handle.updateComplete;
    expect(separator.getAttribute("aria-valuenow")).toBe("220");
    expect(separator.getAttribute("aria-valuemax")).toBe("230");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(resize).toHaveBeenLastCalledWith(230);
  });

  it("drags the section above, clamps to available space, and stops on cancellation", async () => {
    const { handle, separator, resize } = await mountHandle();
    // Pointer capture is a browser boundary, not implemented by happy-dom.
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    separator.setPointerCapture = setCapture;
    separator.hasPointerCapture = vi.fn(() => true);
    separator.releasePointerCapture = releaseCapture;
    const pointer = (type: string, clientY: number) => separator.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientY }));
    pointer("pointerdown", 200);
    expect(setCapture).toHaveBeenCalledWith(1);
    pointer("pointermove", 230);
    expect(handle.onResize).toHaveBeenLastCalledWith(180);
    pointer("pointermove", 1000);
    expect(handle.onResize).toHaveBeenLastCalledWith(400);
    pointer("pointermove", 0);
    expect(handle.onResize).toHaveBeenLastCalledWith(44);
    // Reverse immediately after overshooting either bound; do not retrace the overshoot.
    pointer("pointermove", 20);
    expect(handle.onResize).toHaveBeenLastCalledWith(64);
    pointer("pointermove", 1000);
    expect(handle.onResize).toHaveBeenLastCalledWith(400);
    pointer("pointermove", 980);
    expect(handle.onResize).toHaveBeenLastCalledWith(380);
    pointer("pointercancel", 980);
    expect(releaseCapture).toHaveBeenCalledWith(1);
    const calls = resize.mock.calls.length;
    pointer("pointermove", 250);
    expect(handle.onResize).toHaveBeenCalledTimes(calls);
    expect(handle.hasAttribute("resizing")).toBe(false);
  });

  it("resets with a double tap, without saving an untouched size", async () => {
    const { handle, separator } = await mountHandle();
    separator.setPointerCapture = vi.fn();
    separator.hasPointerCapture = vi.fn(() => false);
    for (let tap = 0; tap < 2; tap++) {
      separator.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientY: 100 }));
      separator.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, button: 0, clientY: 100 }));
    }
    expect(handle.onReset).toHaveBeenCalledOnce();
    expect(handle.onResize).not.toHaveBeenCalled();
  });
});
