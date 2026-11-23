// @vitest-environment happy-dom
import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AppShellController } from "./appShellController";
import { SHORTCUTS_RESERVE_PROPERTY, SHORTCUTS_RESERVE_SETTLE_MS, SHORTCUTS_RESERVED_ATTRIBUTE, ShellViewportController, type ShortcutsReserveStore } from "./shellViewportController";
import { ViewportPanGuard } from "./viewportPanGuard";
import { ViewportPositionRepairer } from "./viewportPositionRepair";

let storedReserve: number | undefined;
const reserveStore: ShortcutsReserveStore = {
  load: () => storedReserve,
  save: (height) => { storedReserve = height; },
  clear: () => { storedReserve = undefined; },
};

class ViewportHost extends LitElement {
  readonly repairer = new ViewportPositionRepairer();
  readonly viewportController = new ShellViewportController(this, this.repairer, reserveStore);
}
customElements.define("viewport-test-host", ViewportHost);

describe("iPad Shortcuts overlay repair", () => {
  let host: ViewportHost;
  let input: HTMLTextAreaElement;
  let viewport: EventTarget & { height: number; scale: number; offsetTop: number; offsetLeft: number };
  let frames: Map<number, FrameRequestCallback>;
  let scrollTo: MockInstance<Window["scrollTo"]>;

  function flushFrame(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }

  async function mount(): Promise<void> {
    host = new ViewportHost();
    document.body.append(host);
    await host.updateComplete;
    // The real editor is inside nested component shadow roots.
    const editor = document.createElement("div");
    host.renderRoot.append(editor);
    input = document.createElement("textarea");
    editor.attachShadow({ mode: "open" }).append(input);
    input.focus();
    flushFrame();
  }

  beforeEach(async () => {
    storedReserve = undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    frames = new Map();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)");
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    viewport = Object.assign(new EventTarget(), { height: 750, scale: 1, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    await mount();
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function reserve(element: HTMLElement = host): string {
    return element.style.getPropertyValue(SHORTCUTS_RESERVE_PROPERTY);
  }

  function showBar(inset: number): void {
    viewport.height = 800 - inset;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
  }

  it("reserves a settled Shortcuts bar permanently and remembers it", async () => {
    expect(reserve()).toBe("");
    showBar(49.5);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("50px");
    expect(storedReserve).toBe(50);
    expect(document.documentElement.hasAttribute(SHORTCUTS_RESERVED_ATTRIBUTE)).toBe(true);

    // With space reserved, CSS owns stability: scrolling is never scripted back.
    scrollTo.mockClear();
    document.documentElement.scrollTop = 40;
    viewport.offsetTop = 30;
    window.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("scroll"));
    showBar(50);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(40);
    viewport.offsetTop = 0;
    document.documentElement.scrollTop = 0;

    // Hiding the bar or leaving the field never gives the space back.
    showBar(0);
    input.blur();
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("50px");

    // A shorter bar keeps the reserve; a taller one (e.g. other orientation) grows it.
    input.focus();
    showBar(40);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("50px");
    showBar(70);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("70px");

    host.remove();
    await mount();
    expect(reserve()).toBe("70px");
  });

  it("frees the reserve on request and learns it again when the bar returns", async () => {
    storedReserve = 60;
    host.remove();
    await mount();
    const update = vi.spyOn(host, "requestUpdate");
    host.viewportController.removeReserve();
    expect(host.viewportController.reserve).toBeUndefined();
    expect(reserve()).toBe("");
    expect(storedReserve).toBeUndefined();
    expect(document.documentElement.hasAttribute(SHORTCUTS_RESERVED_ATTRIBUTE)).toBe(false);
    expect(update).toHaveBeenCalled();

    // Without a reserve, page displacement is repaired again until relearned.
    document.documentElement.scrollTop = 40;
    window.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    showBar(55);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(host.viewportController.reserve).toBe(55);
    expect(storedReserve).toBe(55);
  });

  it("learns the bar again when it is still showing at removal", () => {
    showBar(50);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(host.viewportController.reserve).toBe(50);
    host.viewportController.removeReserve();
    expect(host.viewportController.reserve).toBeUndefined();
    showBar(50);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(host.viewportController.reserve).toBe(50);
    expect(storedReserve).toBe(50);
  });

    it("guards against page panning only while the Shortcuts bar is up", async () => {
    const setActive = vi.spyOn(ViewportPanGuard.prototype, "setActive");
    storedReserve = 50;
    host.remove();
    await mount();
    expect(setActive).toHaveBeenLastCalledWith(true);
    showBar(0);
    expect(setActive).toHaveBeenLastCalledWith(false);
    showBar(50);
    expect(setActive).toHaveBeenLastCalledWith(true);
    input.blur();
    document.dispatchEvent(new Event("focusout"));
    flushFrame();
    expect(setActive).toHaveBeenLastCalledWith(false);
    input.focus();
    flushFrame();
    expect(setActive).toHaveBeenLastCalledWith(true);
    host.remove();
    expect(setActive).toHaveBeenLastCalledWith(false);
  });

  it("does not learn an occlusion that keeps changing or exceeds the bar range", () => {
    // A software keyboard animating up passes through the Shortcuts range.
    showBar(50);
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS / 2);
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("");

    showBar(50);
    viewport.height = 460;
    vi.advanceTimersByTime(SHORTCUTS_RESERVE_SETTLE_MS);
    expect(reserve()).toBe("");
    expect(storedReserve).toBeUndefined();
  });

  it("restores a remembered reserve only on iPad, without live scroll repair", async () => {
    storedReserve = 60;
    host.remove();
    await mount();
    expect(reserve()).toBe("60px");
    expect(document.documentElement.hasAttribute(SHORTCUTS_RESERVED_ATTRIBUTE)).toBe(true);
    document.documentElement.scrollTop = 40;
    window.dispatchEvent(new Event("scroll"));
    showBar(50);
    expect(scrollTo).not.toHaveBeenCalled();
    document.documentElement.scrollTop = 0;

    host.remove();
    expect(document.documentElement.hasAttribute(SHORTCUTS_RESERVED_ATTRIBUTE)).toBe(false);
    host.style.removeProperty(SHORTCUTS_RESERVE_PROPERTY);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
    await mount();
    expect(reserve()).toBe("");
    expect(document.documentElement.hasAttribute(SHORTCUTS_RESERVED_ATTRIBUTE)).toBe(false);
  });

  it("coalesces signals, repairs outer displacement, and leaves panel scrolling alone", () => {
    const panel = document.createElement("div");
    host.renderRoot.append(panel);
    panel.scrollTop = 120;
    panel.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);

    document.documentElement.scrollTop = 60;
    document.body.scrollTop = 30;
    window.dispatchEvent(new Event("scroll"));
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
    expect(panel.scrollTop).toBe(120);

    window.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    viewport.offsetTop = 45;
    viewport.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it.each([
    ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", 5],
    ["Android tablet", "Mozilla/5.0 (Linux; Android 14)", 5],
    ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)", 0],
    ["touch Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 5],
  ])("does not install live repair on %s", async (_device, userAgent, touchPoints) => {
    host.remove();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(touchPoints);
    await mount();
    document.documentElement.scrollTop = 50;
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("focus"));
    expect(frames.size).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(50);
  });

  it("also recognizes an explicit iPad user agent on resume", async () => {
    host.remove();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPad; CPU OS 18_0)");
    await mount();
    viewport.offsetLeft = 20;
    window.dispatchEvent(new Event("pageshow"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("rechecks occlusion at execution, leaving software keyboards and dismissal alone", () => {
    document.documentElement.scrollTop = 50;
    viewport.dispatchEvent(new Event("resize"));
    // A software keyboard can animate through a small inset before the frame.
    viewport.height = 460;
    flushFrame();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(50);

    for (const height of [0, 800, 790, 679]) {
      viewport.height = height;
      viewport.dispatchEvent(new Event("resize"));
      flushFrame();
      expect(scrollTo).not.toHaveBeenCalled();
    }

    viewport.height = 750;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("requires an editable focused field, including contenteditable editors", () => {
    document.documentElement.scrollTop = 50;
    input.blur();
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(scrollTo).not.toHaveBeenCalled();

    input.readOnly = true;
    input.focus();
    flushFrame();
    expect(scrollTo).not.toHaveBeenCalled();

    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    host.renderRoot.append(editor);
    editor.focus();
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("preserves pinch panning and only resumes repair at normal scale", () => {
    viewport.scale = 1.05;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("removes listeners and pending work on disconnect and can reconnect", async () => {
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    host.remove();
    expect(frames.size).toBe(0);
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("focusin"));
    expect(frames.size).toBe(0);

    document.body.append(host);
    await host.updateComplete;
    input.focus();
    document.documentElement.scrollTop = 50;
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("does nothing without the visual viewport API", async () => {
    host.remove();
    vi.stubGlobal("visualViewport", undefined);
    await mount();
    document.documentElement.scrollTop = 50;
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("retains the pre-existing mobile/PWA resume policy rather than enabling it everywhere", () => {
    const repair = vi.spyOn(host.repairer, "repair").mockImplementation(() => undefined);
    const shell = new AppShellController(new ViewportHost(), { viewportPositionRepairer: host.repairer });
    shell.isMobileNavigationLayout = false;
    shell.isPwaDisplayMode = false;
    shell.repairViewportPosition();
    expect(repair).toHaveBeenLastCalledWith(false);
    shell.isMobileNavigationLayout = true;
    shell.repairViewportPosition();
    expect(repair).toHaveBeenLastCalledWith(true);
    shell.isMobileNavigationLayout = false;
    shell.isPwaDisplayMode = true;
    shell.repairViewportPosition();
    expect(repair).toHaveBeenLastCalledWith(true);
  });
});
