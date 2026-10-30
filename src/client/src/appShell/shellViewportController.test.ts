// @vitest-environment happy-dom
import { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShellController } from "./appShellController";
import { ShellViewportController } from "./shellViewportController";
import { ViewportPositionRepairer } from "./viewportPositionRepair";

class ViewportHost extends LitElement {
  readonly repairer = new ViewportPositionRepairer();
  readonly viewportController = new ShellViewportController(this, this.repairer);
}
customElements.define("viewport-test-host", ViewportHost);

describe("ShellViewportController", () => {
  let host: ViewportHost;
  let viewport: EventTarget & { height: number; scale: number; offsetTop: number; offsetLeft: number };
  let frames: Map<number, FrameRequestCallback>;
  let scrollTo: ReturnType<typeof vi.spyOn>;

  function flushFrame(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  }

  beforeEach(async () => {
    frames = new Map();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    viewport = Object.assign(new EventTarget(), { height: 800, scale: 1, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    host = new ViewportHost();
    document.body.append(host);
    await host.updateComplete;
    flushFrame();
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces keyboard signals, restores the shell height on dismissal, and leaves panels alone", () => {
    const panel = document.createElement("div");
    host.append(panel);
    panel.scrollTop = 120;
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    flushFrame();
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("460px");
    expect(panel.scrollTop).toBe(120);
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.height = 800;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("800px");
  });

  it("repairs root scroll and visual-only displacement without scheduling repair loops", () => {
    document.documentElement.scrollTop = 60;
    document.body.scrollTop = 30;
    window.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);

    window.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    viewport.offsetTop = 45;
    viewport.dispatchEvent(new Event("scroll"));
    flushFrame();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it("preserves zoom panning and the pre-zoom shell size, then resumes on zoom reset", () => {
    viewport.scale = 2;
    viewport.height = 400;
    viewport.offsetTop = 90;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("800px");
    expect(scrollTo).not.toHaveBeenCalled();

    viewport.scale = 1;
    viewport.height = 760;
    viewport.dispatchEvent(new Event("resize"));
    flushFrame();
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("760px");
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("does not observe panel scrolling and removes listeners and pending work on disconnect", () => {
    const panel = document.createElement("div");
    host.append(panel);
    panel.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);

    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    host.remove();
    expect(frames.size).toBe(0);
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("");
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(0);
  });

  it("uses CSS sizing when the visual viewport API is unavailable", async () => {
    host.remove();
    vi.stubGlobal("visualViewport", undefined);
    host = new ViewportHost();
    document.body.append(host);
    await host.updateComplete;
    flushFrame();
    expect(host.style.getPropertyValue("--pi-app-viewport-height")).toBe("");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("repairs on resume even in wide, non-PWA layouts", () => {
    const repair = vi.spyOn(host.repairer, "repair").mockImplementation(() => undefined);
    const shell = new AppShellController(new ViewportHost(), { viewportPositionRepairer: host.repairer });
    shell.isMobileNavigationLayout = false;
    shell.isPwaDisplayMode = false;
    shell.repairViewportPosition();
    expect(repair).toHaveBeenCalledExactlyOnceWith(true);
  });
});
