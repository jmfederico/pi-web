// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, configApi, mcpApi, piPackagesApi, pluginsApi } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import { configResponse, pluginsResponse, remoteMachine, secondRemoteMachine } from "./SettingsDialog.testSupport";
import type { SettingsMcpPanel } from "./settings/SettingsMcpPanel";

beforeEach(() => {
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({}));
  vi.spyOn(configApi, "namingModels").mockResolvedValue({ models: [] });
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
  vi.spyOn(api, "mcpAuthServers").mockResolvedValue({ servers: [{ name: "docs" }] });
  vi.spyOn(mcpApi, "list").mockResolvedValue({ servers: [], errors: [], userConfigPath: "/home/pi/.pi/agent/mcp.json" });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(dialog: SettingsDialog): Promise<void> {
  await dialog.updateComplete;
  await dialog.updateComplete;
  const panel = dialog.shadowRoot?.querySelector("settings-mcp-panel");
  await panel?.updateComplete;
  await panel?.updateComplete;
}

function panel(dialog: SettingsDialog): SettingsMcpPanel {
  const result = dialog.shadowRoot?.querySelector("settings-mcp-panel");
  if (!result) throw new Error("Missing MCP panel");
  return result;
}

async function mount(): Promise<SettingsDialog> {
  const dialog = new SettingsDialog();
  dialog.machine = remoteMachine;
  dialog.machines = [remoteMachine, secondRemoteMachine];
  dialog.mcpContext = { session: { id: "session-a", cwd: "/workspace/a" }, machineId: remoteMachine.id };
  dialog.onMcpAuth = vi.fn();
  dialog.onNavigate = (section) => { dialog.section = section; };
  document.body.append(dialog);
  await settle(dialog);
  const nav = Array.from(dialog.shadowRoot?.querySelectorAll("nav button") ?? [])
    .find((button) => button.querySelector("strong")?.textContent === "MCP servers");
  if (!(nav instanceof HTMLButtonElement)) throw new Error("Missing MCP navigation");
  nav.click();
  await settle(dialog);
  return dialog;
}

async function selectMachine(dialog: SettingsDialog, id: string): Promise<void> {
  const select = dialog.shadowRoot?.querySelector<HTMLSelectElement>("#settings-machine");
  if (!select) throw new Error("Missing machine selector");
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(dialog);
}

describe("settings MCP integration", () => {
  it("navigates to MCP and forwards server actions with their origin", async () => {
    const dialog = await mount();
    expect(dialog.section).toBe("mcp");
    const selectedTab = dialog.shadowRoot?.querySelector("nav button.selected");
    expect(vi.spyOn(Element.prototype, "scrollIntoView").mock.contexts).toContain(selectedTab);
    const login = panel(dialog).shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Login to docs"]');
    if (!login) throw new Error("Missing login");
    login.click();
    expect(dialog.onMcpAuth).toHaveBeenCalledWith("login", "docs", dialog.mcpContext);
  });

  it("withholds mismatched context instead of fetching from the settings machine", async () => {
    const dialog = await mount();
    vi.mocked(api.mcpAuthServers).mockClear();
    await selectMachine(dialog, secondRemoteMachine.id);
    expect(panel(dialog).context).toBeUndefined();
    expect(panel(dialog).shadowRoot?.textContent).toContain("Select a nonarchived session on");
    expect(panel(dialog).shadowRoot?.querySelector("li")).toBeNull();
    expect(api.mcpAuthServers).not.toHaveBeenCalled();
    expect(dialog.machine).toBe(remoteMachine);
    await selectMachine(dialog, remoteMachine.id);
    expect(api.mcpAuthServers).toHaveBeenCalledExactlyOnceWith(dialog.mcpContext?.session, remoteMachine.id);
  });

  it("configures the chosen machine without carrying another machine's workspace scope", async () => {
    const dialog = await mount();
    const workspace = { id: "w1", projectId: "p1", path: "/workspace/a", label: "Repo", isMain: true, effectiveConfig: {} };
    dialog.workspace = workspace;
    await settle(dialog);
    const scope = panel(dialog).shadowRoot?.querySelector<HTMLSelectElement>('select[aria-label="MCP configuration scope"]');
    if (!scope) throw new Error("Missing configuration scope");
    scope.value = "workspace";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(dialog);
    expect(mcpApi.list).toHaveBeenLastCalledWith(remoteMachine.id, { projectId: "p1", workspaceId: "w1" });

    await selectMachine(dialog, secondRemoteMachine.id);
    expect(panel(dialog).machine).toBe(secondRemoteMachine);
    expect(panel(dialog).workspace).toBeUndefined();
    expect(panel(dialog).shadowRoot?.querySelector('option[value="workspace"]')).toBeNull();
    expect(mcpApi.list).toHaveBeenLastCalledWith(secondRemoteMachine.id, undefined);
    expect(dialog.workspace).toBe(workspace);

    await selectMachine(dialog, remoteMachine.id);
    expect(panel(dialog).workspace).toBe(workspace);
    expect(mcpApi.list).toHaveBeenLastCalledWith(remoteMachine.id, undefined);
  });

  it("removes controls when the parent withdraws an archived or missing session", async () => {
    const dialog = await mount();
    dialog.mcpContext = undefined;
    await settle(dialog);
    expect(panel(dialog).context).toBeUndefined();
    expect(panel(dialog).shadowRoot?.querySelector("li")).toBeNull();
  });
});
