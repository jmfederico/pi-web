import { describe, expect, it } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { PANEL_COLLAPSE_STORAGE_KEY, PanelCollapseController, readStoredPanelCollapse, writeStoredPanelCollapse } from "./panelCollapseController";

describe("panel collapse persistence", () => {
  it("reads, writes, and clears stored panel collapse state", () => {
    const storage = new FakeStorage();

    expect(readStoredPanelCollapse(storage)).toEqual({});
    writeStoredPanelCollapse({ navigationPanelCollapsed: true }, storage);

    expect(JSON.parse(storage.value(PANEL_COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      navigationPanelCollapsed: true,
    });
    expect(readStoredPanelCollapse(storage)).toEqual({ navigationPanelCollapsed: true });

    writeStoredPanelCollapse({}, storage);
    expect(storage.value(PANEL_COLLAPSE_STORAGE_KEY)).toBeUndefined();
    expect(readStoredPanelCollapse(storage)).toEqual({});
  });

  it("ignores malformed or stale stored values", () => {
    const wrongVersion = new FakeStorage({
      [PANEL_COLLAPSE_STORAGE_KEY]: JSON.stringify({ version: 2, navigationPanelCollapsed: true }),
    });
    expect(readStoredPanelCollapse(wrongVersion)).toEqual({});

    const nonBoolean = new FakeStorage({
      [PANEL_COLLAPSE_STORAGE_KEY]: JSON.stringify({ version: 1, navigationPanelCollapsed: "yes" }),
    });
    expect(readStoredPanelCollapse(nonBoolean)).toEqual({});
  });

  it("ignores storage failures", () => {
    const storage = new ThrowingStorage();

    expect(readStoredPanelCollapse(storage)).toEqual({});
    expect(() => { writeStoredPanelCollapse({ navigationPanelCollapsed: true }, storage); }).not.toThrow();
  });

  it("reads stored collapse state on construction", () => {
    const storage = new FakeStorage({
      [PANEL_COLLAPSE_STORAGE_KEY]: JSON.stringify({ version: 1, navigationPanelCollapsed: true }),
    });

    const controller = new PanelCollapseController(new FakeHost(), { storage });

    expect(controller.navigationPanelCollapsed).toBe(true);
    expect(controller.workspacePanelCollapsed).toBe(false);
  });

  it("persists explicit toggles", () => {
    const storage = new FakeStorage();
    const controller = new PanelCollapseController(new FakeHost(), { storage });

    controller.toggleNavigationPanel();

    expect(controller.navigationPanelCollapsed).toBe(true);
    expect(JSON.parse(storage.value(PANEL_COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      navigationPanelCollapsed: true,
    });
  });

  it("does not persist programmatic expand calls", () => {
    const storage = new FakeStorage({
      [PANEL_COLLAPSE_STORAGE_KEY]: JSON.stringify({ version: 1, navigationPanelCollapsed: true }),
    });
    const controller = new PanelCollapseController(new FakeHost(), { storage });

    controller.expandNavigationPanel();

    expect(controller.navigationPanelCollapsed).toBe(false);
    expect(JSON.parse(storage.value(PANEL_COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      navigationPanelCollapsed: true,
    });
  });
});

class FakeHost implements ReactiveControllerHost {
  addController(): void {
    return;
  }

  removeController(): void {
    return;
  }

  requestUpdate(): void {
    return;
  }

  get updateComplete(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeStorage {
  private readonly values = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }
}

class ThrowingStorage {
  getItem(): string | null {
    throw new Error("blocked");
  }

  setItem(): void {
    throw new Error("blocked");
  }

  removeItem(): void {
    throw new Error("blocked");
  }
}
