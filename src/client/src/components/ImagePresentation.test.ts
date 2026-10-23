// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { ImageDimensions } from "../../../shared/sessionMedia";
import { ImagePresentation } from "./ImagePresentation";
import { imageButton, loadIntrinsicDimensions, nativeImage } from "./imagePresentation.testSupport";

const source = "https://example.test/first.png";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

async function mount(initialSource?: string, dimensions?: ImageDimensions) {
  const presentation = new ImagePresentation();
  presentation.source = initialSource;
  presentation.dimensions = dimensions;
  presentation.description = "Example screenshot";
  presentation.label = "/private/example.png";
  document.body.append(presentation);
  await presentation.updateComplete;
  return presentation;
}

it.each([undefined, ""])('keeps a native image without a src while pending (%s)', async (initialSource) => {
  const presentation = await mount(initialSource);
  const native = nativeImage(presentation);
  expect(native.hasAttribute("src")).toBe(false);
  expect(native.getAttribute("loading")).toBe("lazy");
  expect(native.getAttribute("decoding")).toBe("async");
  expect(imageButton(presentation).hidden).toBe(true);
  expect(imageButton(presentation).disabled).toBe(true);
  const request = imageButton(presentation, ".placeholder");
  expect(request.hidden).toBe(false);
  expect(request.type).toBe("button");
  expect(request.textContent).toContain("Show image");
  expect(request.textContent).toContain("/private/example.png");

  const approval = vi.fn<(event: Event) => void>();
  const zoom = vi.fn();
  document.body.addEventListener("image-request", approval, { once: true });
  presentation.addEventListener("image-open", zoom);
  request.click();
  expect(approval).toHaveBeenCalledOnce();
  expect(approval.mock.calls[0]?.[0]).toMatchObject({ bubbles: true, composed: true });
  expect(zoom).not.toHaveBeenCalled();
  expect(native.hasAttribute("src")).toBe(false);

  presentation.source = source;
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.getAttribute("src")).toBe(source);
  expect(imageButton(presentation).hidden).toBe(false);
  expect(imageButton(presentation).disabled).toBe(false);
  expect(imageButton(presentation, ".placeholder")).toBe(request);
  expect(request.hidden).toBe(true);
});

it("declares intrinsic geometry before loading and updates or clears it in place", async () => {
  const presentation = await mount(source, { width: 1200, height: 800 });
  const native = nativeImage(presentation);
  expect(native.getAttribute("width")).toBe("1200");
  expect(native.getAttribute("height")).toBe("800");
  expect(native.style.getPropertyValue("--image-width")).toBe("1200px");
  expect(native.style.getPropertyValue("--image-height")).toBe("800px");
  expect(native.style.getPropertyValue("--image-ratio")).toBe("1.5");

  presentation.source = "https://example.test/portrait.png";
  presentation.dimensions = { width: 400, height: 1600 };
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.getAttribute("width")).toBe("400");
  expect(native.getAttribute("height")).toBe("1600");
  expect(native.style.getPropertyValue("--image-ratio")).toBe("0.25");

  presentation.dimensions = undefined;
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("width")).toBe(false);
  expect(native.hasAttribute("height")).toBe(false);
  for (const name of ["--image-width", "--image-height", "--image-ratio"]) {
    expect(native.style.getPropertyValue(name)).toBe("");
  }
});

it("leaves load/error display to the browser without renders, layout events or image replacement", async () => {
  const layout = vi.fn();
  const presentation = new ImagePresentation();
  presentation.addEventListener("image-will-layout", layout);
  presentation.addEventListener("image-layout", layout);
  presentation.source = source;
  presentation.dimensions = { width: 1200, height: 800 };
  document.body.append(presentation);
  await presentation.updateComplete;
  const native = nativeImage(presentation);
  const enlarge = imageButton(presentation);
  const requestUpdate = vi.spyOn(presentation, "requestUpdate");

  for (const type of ["load", "error"]) {
    native.dispatchEvent(new Event(type));
    await presentation.updateComplete;
    expect(nativeImage(presentation)).toBe(native);
    expect(imageButton(presentation)).toBe(enlarge);
    expect(native.getAttribute("src")).toBe(source);
    expect(native.getAttribute("width")).toBe("1200");
    expect(native.getAttribute("height")).toBe("800");
    expect(enlarge.hidden).toBe(false);
    expect(enlarge.disabled).toBe(false);
  }
  expect(requestUpdate).not.toHaveBeenCalled();
  expect(presentation.renderRoot.querySelector('[role="status"], [aria-busy]')).toBeNull();

  presentation.description = "Updated alt text";
  presentation.label = "updated path";
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.alt).toBe("Updated alt text");
  expect(enlarge.getAttribute("aria-label")).toBe("Enlarge Updated alt text");

  presentation.source = "https://example.test/second.png";
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.getAttribute("src")).toBe(presentation.source);
  presentation.source = undefined;
  await presentation.updateComplete;
  expect(nativeImage(presentation)).toBe(native);
  expect(native.hasAttribute("src")).toBe(false);
  expect(enlarge.hidden).toBe(true);
  expect(layout).not.toHaveBeenCalled();
});

it("reports successful intrinsic metadata only to an opted-in owner without rerendering itself", async () => {
  const presentation = await mount(source);
  const report = vi.fn();
  presentation.onIntrinsicDimensions = report;
  await presentation.updateComplete;
  const native = nativeImage(presentation);
  const update = vi.spyOn(presentation, "requestUpdate");
  loadIntrinsicDimensions(native, 1200, 800);
  expect(report).toHaveBeenCalledExactlyOnceWith(source, { width: 1200, height: 800 });
  expect(update).not.toHaveBeenCalled();
  expect(nativeImage(presentation)).toBe(native);

  native.dispatchEvent(new Event("error"));
  loadIntrinsicDimensions(native, 0, 800);
  loadIntrinsicDimensions(native, 1200, 0);
  expect(report).toHaveBeenCalledOnce();

  presentation.source = "https://example.test/next.png";
  // An old DOM load must not report geometry under a newly selected source.
  loadIntrinsicDimensions(native, 1200, 800);
  expect(report).toHaveBeenCalledOnce();
  await presentation.updateComplete;
  presentation.source = undefined;
  await presentation.updateComplete;
  loadIntrinsicDimensions(native, 1200, 800);
  expect(report).toHaveBeenCalledOnce();
});

it("opens zoom with click, Enter and Space without waiting for a native load event", async () => {
  const presentation = await mount(source);
  const open = vi.fn<(event: Event) => void>();
  document.body.addEventListener("image-open", open);
  try {
    const enlarge = imageButton(presentation);
    expect(enlarge.type).toBe("button");
    expect(enlarge.getAttribute("aria-label")).toBe("Enlarge Example screenshot");
    enlarge.focus();
    expect(presentation.shadowRoot?.activeElement).toBe(enlarge);
    enlarge.click();
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      enlarge.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    const otherKey = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true, bubbles: true });
    enlarge.dispatchEvent(otherKey);
    expect(otherKey.defaultPrevented).toBe(false);
    expect(open).toHaveBeenCalledTimes(3);
    for (const [event] of open.mock.calls) {
      expect(event).toMatchObject({
        detail: { src: source, alt: "Example screenshot" }, bubbles: true, composed: true,
      });
    }

    presentation.source = undefined;
    await presentation.updateComplete;
    enlarge.click();
    enlarge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(open).toHaveBeenCalledTimes(3);
  } finally {
    document.body.removeEventListener("image-open", open);
  }
});
