import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NAVIGATION_SECTION_SIZE_STORAGE_KEY,
  NavigationSectionResizeController,
  navigationSectionHeightFromDrag,
  navigationSectionHeightFromKeyboard,
  type NavigationSectionSizeStorage,
} from "./navigationSectionResizeController";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture(storage: NavigationSectionSizeStorage = new FakeStorage()) {
  const host = {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const controller = new NavigationSectionResizeController(host, { storage });
  return { host, controller };
}

class FakeStorage implements NavigationSectionSizeStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("navigation section resizing", () => {
  it("registers with the host and leaves both sections content-sized initially", () => {
    const { host, controller } = fixture();
    expect(host.addController).toHaveBeenCalledWith(controller);
    expect(controller.height("projects")).toBeUndefined();
    expect(controller.height("workspaces")).toBeUndefined();
    expect(host.requestUpdate).not.toHaveBeenCalled();
  });

  it("persists independent pixel heights and restores them without a viewport maximum", () => {
    const storage = new FakeStorage();
    const { controller, host } = fixture(storage);
    controller.resize("projects", 180.6);
    controller.resize("workspaces", 9000);

    expect(host.requestUpdate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.getItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY) ?? "null")).toEqual({
      version: 1, projects: 181, workspaces: 9000,
    });
    const restored = fixture(storage).controller;
    expect(restored.height("projects")).toBe(181);
    expect(restored.height("workspaces")).toBe(9000);
  });

  it("clamps to 44px, ignores non-finite inputs, and skips unchanged updates", () => {
    const { controller, host } = fixture();
    controller.resize("projects", -10);
    controller.resize("projects", 44);
    controller.resize("projects", NaN);
    controller.resize("projects", Infinity);
    controller.resize("workspaces", -Infinity);
    expect(controller.height("projects")).toBe(44);
    expect(controller.height("workspaces")).toBeUndefined();
    expect(host.requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("resets only the selected section and removes storage after the last reset", () => {
    const storage = new FakeStorage();
    const { controller, host } = fixture(storage);
    controller.resize("projects", 120);
    controller.resize("workspaces", 240);
    controller.reset("projects");
    expect(controller.height("projects")).toBeUndefined();
    expect(fixture(storage).controller.height("workspaces")).toBe(240);
    expect(fixture(storage).controller.height("projects")).toBeUndefined();
    controller.reset("workspaces");
    controller.reset("workspaces");
    expect(storage.getItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY)).toBeNull();
    expect(host.requestUpdate).toHaveBeenCalledTimes(4);
  });

  it.each(["{", "null", "[]", "42", '{"version":2,"projects":120}'])("ignores malformed or unsupported saved data: %s", raw => {
    const storage = new FakeStorage();
    storage.setItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY, raw);
    const { controller } = fixture(storage);
    expect(controller.height("projects")).toBeUndefined();
    expect(controller.height("workspaces")).toBeUndefined();
  });

  it("validates saved sections independently and clamps restored heights", () => {
    const storage = new FakeStorage();
    storage.setItem(NAVIGATION_SECTION_SIZE_STORAGE_KEY, '{"version":1,"projects":12,"workspaces":"240"}');
    const { controller } = fixture(storage);
    expect(controller.height("projects")).toBe(44);
    expect(controller.height("workspaces")).toBeUndefined();
  });

  it("keeps in-memory resizing and reset usable when storage operations throw", () => {
    const blocked = (): never => { throw new Error("blocked"); };
    const { controller, host } = fixture({ getItem: blocked, setItem: blocked, removeItem: blocked });
    controller.resize("projects", 200);
    expect(controller.height("projects")).toBe(200);
    controller.reset("projects");
    expect(controller.height("projects")).toBeUndefined();
    expect(host.requestUpdate).toHaveBeenCalledTimes(2);
  });

  it("defaults to browser localStorage", () => {
    const storage = new FakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const { host } = fixture();
    const controller = new NavigationSectionResizeController(host);
    controller.resize("projects", 150);
    expect(new NavigationSectionResizeController(host).height("projects")).toBe(150);
  });

  it("works when browser storage access is blocked", () => {
    vi.stubGlobal("window", { get localStorage(): never { throw new Error("blocked"); } });
    const { host } = fixture();
    const controller = new NavigationSectionResizeController(host);
    controller.resize("workspaces", 160);
    expect(controller.height("workspaces")).toBe(160);
  });
});

describe("navigation section resize helpers", () => {
  it("grows downwards and clamps upward dragging to the minimum", () => {
    expect(navigationSectionHeightFromDrag(200, 100, 150)).toBe(250);
    expect(navigationSectionHeightFromDrag(200, 100, -100)).toBe(44);
    expect(navigationSectionHeightFromDrag(200, 100, 10000)).toBe(10100);
  });

  it("supports arrow keys, larger steps and Home without inventing an End maximum", () => {
    expect(navigationSectionHeightFromKeyboard(200, "ArrowDown")).toBe(224);
    expect(navigationSectionHeightFromKeyboard(200, "ArrowUp")).toBe(176);
    expect(navigationSectionHeightFromKeyboard(200, "ArrowDown", { largeStep: true })).toBe(272);
    expect(navigationSectionHeightFromKeyboard(200, "ArrowUp", { largeStep: true })).toBe(128);
    expect(navigationSectionHeightFromKeyboard(50, "ArrowUp")).toBe(44);
    expect(navigationSectionHeightFromKeyboard(200, "Home")).toBe(44);
    expect(navigationSectionHeightFromKeyboard(200, "End")).toBeUndefined();
    expect(navigationSectionHeightFromKeyboard(200, "Enter")).toBeUndefined();
  });
});
