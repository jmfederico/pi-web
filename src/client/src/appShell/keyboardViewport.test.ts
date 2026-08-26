import { describe, expect, it } from "vitest";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { KeyboardViewportController, type KeyboardViewport, type KeyboardViewportControllerOptions, type StyleProperties } from "./keyboardViewport";

function fakeStyle(): StyleProperties & {
  properties(): ReadonlyMap<string, string>;
} {
  const values = new Map<string, string>();
  return {
    setProperty(name: string, value: string): void {
      values.set(name, value);
    },
    removeProperty(name: string): void {
      values.delete(name);
    },
    properties(): ReadonlyMap<string, string> {
      return values;
    },
  };
}

interface Harness {
  controller: KeyboardViewportController;
  style: ReturnType<typeof fakeStyle>;
  viewport: ReturnType<typeof fakeViewport>;
  connect(): void;
  disconnect(): void;
}

function fakeViewport(initial: { height: number; offsetTop?: number; scale?: number }): KeyboardViewport & {
  resizeListeners: (() => void)[];
  scrollListeners: (() => void)[];
  height: number;
  offsetTop: number;
  scale: number;
  resize(): void;
  scroll(): void;
} {
  const resizeListeners: (() => void)[] = [];
  const scrollListeners: (() => void)[] = [];
  const viewport = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    scale: initial.scale ?? 1,
    resizeListeners,
    scrollListeners,
    addEventListener(type: "resize" | "scroll", listener: () => void): void {
      (type === "resize" ? resizeListeners : scrollListeners).push(listener);
    },
    removeEventListener(type: "resize" | "scroll", listener: () => void): void {
      const listeners = type === "resize" ? resizeListeners : scrollListeners;
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    resize(): void {
      for (const listener of [...resizeListeners]) listener();
    },
    scroll(): void {
      for (const listener of [...scrollListeners]) listener();
    },
  };
  return viewport;
}

interface FakeHost extends ReactiveControllerHost {
  style: StyleProperties;
  connect(): void;
  disconnect(): void;
}

function fakeHost(style: StyleProperties): FakeHost {
  const controllers: ReactiveController[] = [];
  return {
    style,
    addController(controller: ReactiveController): void {
      controllers.push(controller);
    },
    removeController(controller: ReactiveController): void {
      const index = controllers.indexOf(controller);
      if (index >= 0) controllers.splice(index, 1);
    },
    requestUpdate(): void {
      // No rendering in the test harness.
    },
    updateComplete: Promise.resolve(false),
    connect(): void {
      for (const controller of [...controllers]) controller.hostConnected?.();
    },
    disconnect(): void {
      for (const controller of [...controllers]) controller.hostDisconnected?.();
    },
  };
}

function createHarness(windowInnerHeight: number, options: Partial<KeyboardViewportControllerOptions> = {}): Harness {
  const style = fakeStyle();
  const viewport = fakeViewport({ height: windowInnerHeight });
  const host = fakeHost(style);
  const controller = new KeyboardViewportController(host, {
    viewport,
    windowViewport: { innerHeight: windowInnerHeight },
    style,
    ...options,
  });
  return {
    controller,
    style,
    viewport,
    connect: () => { host.connect(); },
    disconnect: () => { host.disconnect(); },
  };
}

describe("KeyboardViewportController", () => {
  it("pins the shell to the visual viewport while the keyboard is open", () => {
    const harness = createHarness(800);
    harness.connect();

    harness.viewport.height = 420;
    harness.viewport.offsetTop = 30;
    harness.viewport.resize();

    expect(harness.style.properties().get("--pi-app-viewport-top")).toBe("30px");
    expect(harness.style.properties().get("--pi-app-viewport-height")).toBe("420px");
  });

  it("restores CSS sizing when the keyboard closes", () => {
    const harness = createHarness(800);
    harness.connect();
    harness.viewport.height = 420;
    harness.viewport.resize();
    expect(harness.style.properties().size).toBe(2);

    harness.viewport.height = 800;
    harness.viewport.resize();

    expect(harness.style.properties().size).toBe(0);
  });

  it("ignores small visual viewport differences from browser chrome changes", () => {
    const harness = createHarness(800);
    harness.connect();

    harness.viewport.height = 790;
    harness.viewport.resize();

    expect(harness.style.properties().size).toBe(0);
  });

  it("does not fight pinch zoom", () => {
    const harness = createHarness(800);
    harness.connect();
    harness.viewport.height = 420;
    harness.viewport.resize();
    expect(harness.style.properties().size).toBe(2);

    harness.viewport.scale = 1.5;
    harness.viewport.resize();

    expect(harness.style.properties().size).toBe(0);
  });

  it("refits while the keyboard is open and the visual viewport scrolls", () => {
    const harness = createHarness(800);
    harness.connect();
    harness.viewport.height = 420;
    harness.viewport.resize();

    harness.viewport.offsetTop = 64;
    harness.viewport.scroll();

    expect(harness.style.properties().get("--pi-app-viewport-top")).toBe("64px");
  });

  it("clears overrides and detaches listeners when disconnected", () => {
    const harness = createHarness(800);
    harness.connect();
    harness.viewport.height = 420;
    harness.viewport.resize();
    expect(harness.style.properties().size).toBe(2);

    harness.disconnect();

    expect(harness.style.properties().size).toBe(0);
    expect(harness.viewport.resizeListeners).toHaveLength(0);
    expect(harness.viewport.scrollListeners).toHaveLength(0);

    harness.viewport.height = 100;
    harness.viewport.offsetTop = 50;
    harness.viewport.resize();
    expect(harness.style.properties().size).toBe(0);
  });

  it("does nothing when the browser has no visual viewport", () => {
    const style = fakeStyle();
    const host = fakeHost(style);
    const controller = new KeyboardViewportController(host, {
      windowViewport: { innerHeight: 800 },
      style,
    });
    controller.hostConnected();

    expect(style.properties().size).toBe(0);
    controller.hostDisconnected();
  });
});
