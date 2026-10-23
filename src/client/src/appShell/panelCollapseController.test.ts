import type { ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_COLLAPSE_STORAGE_KEY, PanelCollapseController } from "./panelCollapseController";

function host(): ReactiveControllerHost {
  return { addController: vi.fn(), removeController: vi.fn(), requestUpdate: vi.fn(), updateComplete: Promise.resolve(true) };
}

function storage(initial: string | null = null) {
  let value = initial;
  return { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("panel collapse preferences", () => {
  it("restores both collapsed panels and persists explicit expansion", () => {
    const saved = storage();
    const first = new PanelCollapseController(host(), { storage: saved });
    expect(first.navigationPanelCollapsed).toBe(false);
    expect(first.workspacePanelCollapsed).toBe(false);
    first.toggleNavigationPanel();
    first.toggleWorkspacePanel();
    expect(saved.setItem).toHaveBeenLastCalledWith(PANEL_COLLAPSE_STORAGE_KEY, JSON.stringify({
      version: 1, navigationPanelCollapsed: true, workspacePanelCollapsed: true,
    }));
    const restored = new PanelCollapseController(host(), { storage: saved });
    expect(restored.shellClass("chat")).toContain("navigation-panel-collapsed");
    expect(restored.shellClass("chat")).toContain("workspace-panel-collapsed");
    restored.expandNavigationPanel();
    restored.expandWorkspacePanel();
    const expanded = new PanelCollapseController(host(), { storage: saved });
    expect(expanded.navigationPanelCollapsed).toBe(false);
    expect(expanded.workspacePanelCollapsed).toBe(false);
  });

  it("persists expansion through the toggle controls", () => {
    const saved = storage(JSON.stringify({ version: 1, navigationPanelCollapsed: true, workspacePanelCollapsed: true }));
    const controller = new PanelCollapseController(host(), { storage: saved });
    controller.toggleNavigationPanel();
    controller.toggleWorkspacePanel();
    const restored = new PanelCollapseController(host(), { storage: saved });
    expect(restored.navigationPanelCollapsed).toBe(false);
    expect(restored.workspacePanelCollapsed).toBe(false);
  });

  it.each([
    null, "null", "[]", '{"version":2,"workspacePanelCollapsed":true}',
    '{"version":1,"navigationPanelCollapsed":"true","workspacePanelCollapsed":1}',
  ])("defaults to expanded for unsupported preferences: %s", (value) => {
    const controller = new PanelCollapseController(host(), { storage: storage(value) });
    expect(controller.navigationPanelCollapsed).toBe(false);
    expect(controller.workspacePanelCollapsed).toBe(false);
  });

  it("uses defaults for malformed JSON and reports the failure", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new PanelCollapseController(host(), { storage: storage("invalid") });
    expect(controller.workspacePanelCollapsed).toBe(false);
    expect(warning).toHaveBeenCalled();
  });

  it("still updates the layout when storage fails", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unavailable = {
      getItem: () => { throw new Error("Storage blocked"); },
      setItem: () => { throw new Error("Storage blocked"); },
    };
    const requestUpdate = vi.fn();
    const owner = { ...host(), requestUpdate };
    const controller = new PanelCollapseController(owner, { storage: unavailable });
    controller.toggleWorkspacePanel();
    expect(controller.workspacePanelCollapsed).toBe(true);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
