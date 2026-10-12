// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, mcpApi, piPackagesApi, pluginsApi, type Workspace } from "../api";
import { deepActiveElement, dialogSection, dialogSurface, pressKey, requiredElement, settleRenderedDialog, surfaceBackdrop } from "./modalSurfaceTestSupport";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, pluginsResponse, remoteMachine } from "./SettingsDialog.testSupport";

beforeEach(() => {
  // The dialog loads gateway and selected-machine settings data when it
  // connects; stub those boundary calls so the shell tests stay deterministic.
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({}));
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
  vi.spyOn(mcpApi, "list").mockResolvedValue({ servers: [], errors: [], userConfigPath: "/home/pi/.pi/agent/mcp.json" });
  vi.spyOn(mcpApi, "check").mockResolvedValue({ checkedAt: "now", servers: [], errors: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("settings-dialog modal surface", () => {
  it("moves focus into the labelled dialog when opened", async () => {
    const dialog = await mountDialog();

    expect(deepActiveElement()).toBe(dialogSection(dialog));
    expect(dialogSection(dialog).getAttribute("aria-label")).toBe("PI WEB settings");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn<() => void>();
    const dialog = await mountDialog({ onClose });

    pressKey(dialogSurface(dialog), "Escape");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes when the backdrop itself is pressed", async () => {
    const onClose = vi.fn<() => void>();
    const dialog = await mountDialog({ onClose });

    surfaceBackdrop(dialog).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus from the dialog section to the first dialog control on Tab", async () => {
    const dialog = await mountDialog();
    const closeButton = requiredElement(dialog.shadowRoot?.querySelector<HTMLButtonElement>("header .close-button"), "settings close button");
    expect(deepActiveElement()).toBe(dialogSection(dialog));

    pressKey(dialogSurface(dialog), "Tab");

    expect(deepActiveElement()).toBe(closeButton);
  });
});

describe("settings-dialog MCP routing", () => {
  it("loads MCP only when selected and passes the selected machine and workspace to its panel", async () => {
    const workspace: Workspace = { id: "w1", projectId: "p1", path: "/repo", label: "Repo", isMain: true, effectiveConfig: {} };
    const dialog = await mountDialog();
    dialog.machine = remoteMachine;
    dialog.workspace = workspace;
    dialog.onNavigate = (section) => { dialog.section = section; };
    await settleRenderedDialog(dialog);
    expect(mcpApi.list).not.toHaveBeenCalled();
    expect(dialog.shadowRoot?.querySelector("settings-mcp-panel")).toBeNull();

    const navButton = requiredElement(Array.from(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>("nav button") ?? []).find((button) => button.textContent.includes("MCP servers")), "MCP navigation button");
    navButton.click();
    await vi.waitFor(() => { expect(mcpApi.list).toHaveBeenCalledExactlyOnceWith("remote-a", undefined); });
    const panel = requiredElement(dialog.shadowRoot?.querySelector("settings-mcp-panel"), "MCP settings panel");
    await panel.updateComplete;
    expect(panel.machine).toBe(remoteMachine);
    expect(panel.workspace).toBe(workspace);
    expect(navButton.getAttribute("aria-current")).toBe("page");
    const select = requiredElement(panel.shadowRoot?.querySelector("select"), "MCP scope selector");
    select.value = "workspace";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.updateComplete;
    await panel.updateComplete;
    expect(mcpApi.list).toHaveBeenLastCalledWith("remote-a", { projectId: "p1", workspaceId: "w1" });
    expect(mcpApi.check).not.toHaveBeenCalled();

    dialog.actions = [];
    await settleRenderedDialog(dialog);
    expect(mcpApi.list).toHaveBeenCalledTimes(2);
  });
});

interface SettingsDialogCallbacks {
  onClose?: () => void;
}

async function mountDialog(callbacks: SettingsDialogCallbacks = {}): Promise<SettingsDialog> {
  const dialog = new SettingsDialog();
  Object.assign(dialog, callbacks);
  document.body.append(dialog);
  await settleRenderedDialog(dialog);
  return dialog;
}
