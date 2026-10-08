// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpApi, type Machine, type McpCheckResponse, type McpServerInfo, type McpServersResponse, type Workspace } from "../../api";
import { HttpRequestError } from "../../api/http";
import { SettingsMcpPanel } from "./SettingsMcpPanel";
import type { SettingsPanelFrame } from "./SettingsPanelFrame";

const machine: Machine = { id: "remote-a", name: "Build host", kind: "remote", baseUrl: "https://remote.example.test", createdAt: "now", updatedAt: "now" };
const workspace: Workspace = { id: "w1", projectId: "p1", path: "/repo", label: "Repo", isMain: true, effectiveConfig: {} };
const server: McpServerInfo = {
  name: "catalog", scope: "user", source: "/home/pi/.pi/agent/mcp.json", enabled: true,
  transport: "http", description: "Service catalog", exposure: "tools", overridden: false,
};
const config: McpServersResponse = { servers: [server], errors: [], userConfigPath: server.source };
const check: McpCheckResponse = {
  checkedAt: "2026-10-01T12:00:00Z", errors: ["A test connection failed"], note: "Temporary connections closed",
  servers: [
    { name: "catalog", scope: "user", state: "connected", tools: ["lookup", "search"] },
    { name: "private", scope: "project", state: "needs-auth", tools: [], error: "Sign-in required" },
    { name: "offline", scope: "user", state: "failed", tools: [], error: "Connection refused" },
    { name: "disabled", scope: "user", state: "disabled", tools: [] },
  ],
};

function client() {
  return {
    list: vi.fn<typeof mcpApi.list>().mockResolvedValue(config),
    setEnabled: vi.fn<typeof mcpApi.setEnabled>().mockResolvedValue({ ...config, servers: [{ ...server, enabled: false }] }),
    check: vi.fn<typeof mcpApi.check>().mockResolvedValue(check),
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized"); };
  let reject: (error: Error) => void = () => { throw new Error("Promise not initialized"); };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(panel: SettingsMcpPanel): Promise<void> {
  await panel.updateComplete;
  await panel.updateComplete;
  await frame(panel).updateComplete;
}

async function mount(apiClient = client(), target: { machine: Machine | undefined } = { machine }): Promise<SettingsMcpPanel> {
  const panel = new SettingsMcpPanel();
  panel.apiClient = apiClient;
  panel.machine = target.machine;
  panel.workspace = workspace;
  document.body.append(panel);
  await settle(panel);
  return panel;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Required MCP control not rendered");
  return value;
}

function frame(panel: SettingsMcpPanel): SettingsPanelFrame {
  return required(panel.shadowRoot?.querySelector("settings-panel-frame"));
}

function text(panel: SettingsMcpPanel): string {
  return `${panel.shadowRoot?.textContent ?? ""} ${frame(panel).shadowRoot?.textContent ?? ""}`;
}

function checkButton(panel: SettingsMcpPanel): HTMLButtonElement {
  return required(panel.shadowRoot?.querySelector("button"));
}

function toggle(panel: SettingsMcpPanel, index = 0): HTMLInputElement {
  return required(panel.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]);
}

function refreshButton(panel: SettingsMcpPanel): HTMLButtonElement {
  return required(frame(panel).shadowRoot?.querySelector("button"));
}

async function selectScope(panel: SettingsMcpPanel, value: "machine" | "workspace"): Promise<void> {
  const select = required(panel.shadowRoot?.querySelector("select"));
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(panel);
}

describe("settings-mcp-panel", () => {
  it("reads only configuration on mount, defaults to machine-wide and renders safe summaries and lifecycle help", async () => {
    const apiClient = client();
    apiClient.list.mockResolvedValue({ ...config, servers: [Object.assign({ ...server }, { headers: { Authorization: "raw-secret" }, args: ["raw-secret"], env: { TOKEN: "raw-secret" } })] });
    const panel = await mount(apiClient);

    expect(apiClient.list).toHaveBeenCalledExactlyOnceWith("remote-a", undefined);
    expect(apiClient.check).not.toHaveBeenCalled();
    expect(apiClient.setEnabled).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.querySelector("select")?.value).toBe("machine");
    const content = text(panel);
    for (const expected of ["Machine-wide", "Selected workspace", "Build host", "Service catalog", "Scope: user", "Enabled", "Transport: http", "Exposure: tools", server.source, "Credentials remain in Pi files", "New sessions pick up saved configuration", "/reload", "each idle session", "does not stop connections", "already-running sessions", "/mcp reconnect catalog", "not required for ordinary coding"]) {
      expect(content).toContain(expected);
    }
    expect(content).not.toContain("/mcp login");
    expect(content).not.toContain("OAuth");
    expect(content).not.toContain("raw-secret");
    expect(content).not.toContain("Authorization");
    expect(panel.shadowRoot?.querySelector('[aria-label="Temporary MCP connection test"]')).toBeNull();
    expect(panel.shadowRoot?.querySelectorAll("button")).toHaveLength(1);
  });

  it("does not suggest OAuth login for public HTTP or local stdio servers, before or after a successful check", async () => {
    const apiClient = client();
    apiClient.list.mockResolvedValue({ ...config, servers: [{ ...server, name: "deepwiki" }, { ...server, name: "filesystem", transport: "stdio" }] });
    apiClient.check.mockResolvedValue({
      checkedAt: check.checkedAt, errors: [], servers: [
        { name: "deepwiki", scope: "user", state: "connected", tools: ["read_wiki_contents"] },
        { name: "filesystem", scope: "user", state: "connected", tools: ["read_file"] },
      ],
    });
    const panel = await mount(apiClient);
    const configuration = required(panel.shadowRoot?.querySelector('[aria-label="MCP configuration"]'));
    expect(configuration.textContent).not.toContain("/mcp login");
    expect(configuration.textContent).toContain("/mcp reconnect deepwiki");
    expect(configuration.textContent).toContain("/mcp reconnect filesystem");
    expect(text(panel)).toContain("/mcp");
    expect(text(panel)).not.toContain("/mcp login");
    expect(text(panel)).not.toContain("OAuth");

    checkButton(panel).click();
    await settle(panel);
    const result = required(panel.shadowRoot?.querySelector('[aria-label="Temporary MCP connection test"]'));
    expect(result.textContent).toContain("Status: connected");
    expect(result.textContent).not.toContain("/mcp login");
  });

  it("uses the local selected-machine endpoint even without an explicit machine", async () => {
    const apiClient = client();
    await mount(apiClient, { machine: undefined });
    expect(apiClient.list).toHaveBeenCalledExactlyOnceWith("local", undefined);
  });

  it("shows untrusted project, parse errors and overridden user entries; disables invalid and overridden toggles", async () => {
    const apiClient = client();
    apiClient.list.mockResolvedValue({
      ...config, projectConfigPath: "/repo/.pi/mcp.json", projectTrusted: false, errors: ["Could not parse another config"],
      servers: [
        server,
        { ...server, scope: "project", source: "/repo/.pi/mcp.json", enabled: false },
        { ...server, overridden: true },
        { ...server, name: "broken", transport: "unknown", error: "Invalid command" },
        { ...server, name: "unknown", transport: "unknown" },
      ],
    });
    const panel = await mount(apiClient);
    expect(text(panel)).toContain("Untrusted project configuration");
    expect(text(panel)).toContain("Saved/default trust here is not a running session's trust decision");
    expect(text(panel)).toContain("Project config: /repo/.pi/mcp.json");
    expect(text(panel)).toContain("Could not parse another config");
    expect(text(panel)).toContain("Overridden by project configuration");
    expect(text(panel)).toContain("Invalid command");
    expect(text(panel)).toContain("Invalid or unknown transport");
    expect(toggle(panel).disabled).toBe(false);
    expect(toggle(panel, 1).checked).toBe(false);
    for (const index of [2, 3, 4]) {
      expect(toggle(panel, index).disabled).toBe(true);
      toggle(panel, index).click();
    }
    expect(apiClient.setEnabled).not.toHaveBeenCalled();
  });

  it("runs an explicit temporary check and renders states, tools and errors, never live-session status", async () => {
    const apiClient = client();
    const pending = deferred<McpCheckResponse>();
    apiClient.check.mockReturnValue(pending.promise);
    const panel = await mount(apiClient);
    checkButton(panel).click();
    await settle(panel);
    expect(apiClient.check).toHaveBeenCalledExactlyOnceWith("remote-a", undefined);
    expect(checkButton(panel).disabled).toBe(true);
    expect(toggle(panel).disabled).toBe(true);
    expect(refreshButton(panel).disabled).toBe(true);
    expect(text(panel)).toContain("Checking connections…");

    pending.resolve(check);
    await settle(panel);
    const result = required(panel.shadowRoot?.querySelector('[aria-label="Temporary MCP connection test"]'));
    for (const expected of ["not live session status", check.checkedAt, "Temporary connections closed", "Status: connected", "Status: needs-auth", "Status: failed", "Status: disabled", "lookup", "search", "Tools (2)", "Tools (0): None", "A test connection failed", "Sign-in required", "Connection refused", "Inspect session status with /mcp inside a session", "/mcp reconnect offline"]) {
      expect(result.textContent).toContain(expected);
    }
    expect(text(panel)).not.toContain("/mcp login");
    expect(text(panel)).not.toContain("OAuth");
    expect(checkButton(panel).disabled).toBe(false);
    expect(apiClient.list).toHaveBeenCalledOnce();
    expect(apiClient.setEnabled).not.toHaveBeenCalled();
  });

  it("persists only configuration on toggle and invalidates the last check", async () => {
    const apiClient = client();
    const pending = deferred<McpServersResponse>();
    apiClient.setEnabled.mockReturnValue(pending.promise);
    const panel = await mount(apiClient);
    checkButton(panel).click();
    await settle(panel);
    expect(text(panel)).toContain(check.checkedAt);

    toggle(panel).click();
    await settle(panel);
    expect(apiClient.setEnabled).toHaveBeenCalledExactlyOnceWith("catalog", "user", false, "remote-a", undefined);
    expect(toggle(panel).disabled).toBe(true);
    expect(checkButton(panel).disabled).toBe(true);
    expect(text(panel)).not.toContain(check.checkedAt);
    expect(text(panel)).not.toContain("Configuration saved.");

    pending.resolve({ ...config, servers: [{ ...server, enabled: false }] });
    await settle(panel);
    expect(toggle(panel).checked).toBe(false);
    expect(toggle(panel).disabled).toBe(false);
    expect(text(panel)).toContain("Configuration saved.");
    expect(apiClient.check).toHaveBeenCalledOnce();
    expect(apiClient.list).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("Read-only Pi file"),
    new HttpRequestError("user MCP configuration changed during the update; refresh configuration and retry", 409),
  ])("shows mutation failure rather than success and restores the saved checkbox state (%s)", async (failure) => {
    const apiClient = client();
    apiClient.setEnabled.mockRejectedValue(failure);
    const panel = await mount(apiClient);
    checkButton(panel).click();
    await settle(panel);
    toggle(panel).click();
    await settle(panel);

    expect(text(panel)).toContain(`Failed to save MCP configuration on Build host: ${failure.message}`);
    expect(text(panel)).not.toContain("Configuration saved.");
    expect(text(panel)).not.toContain(check.checkedAt);
    expect(toggle(panel).checked).toBe(true);
    expect(toggle(panel).disabled).toBe(false);
  });

  it("explains update/restart for an older selected-machine 404 without a gateway read", async () => {
    const apiClient = client();
    apiClient.list.mockRejectedValue(new HttpRequestError("Not found", 404));
    const panel = await mount(apiClient);
    for (const expected of ["Build host", "older PI WEB version", "update PI WEB on that machine", "restart its web/API service and session daemon", "No gateway fallback", "MCP configuration unavailable"]) {
      expect(text(panel)).toContain(expected);
    }
    expect(apiClient.list).toHaveBeenCalledExactlyOnceWith("remote-a", undefined);
    expect(checkButton(panel).disabled).toBe(true);
    expect(refreshButton(panel).disabled).toBe(false);
  });

  it("renders check failures and allows an explicit retry without clearing configuration", async () => {
    const apiClient = client();
    apiClient.check.mockRejectedValueOnce(new Error("Temporary CLI check failed"));
    const panel = await mount(apiClient);
    checkButton(panel).click();
    await settle(panel);
    expect(text(panel)).toContain("Failed to check MCP connections on Build host: Temporary CLI check failed");
    expect(text(panel)).toContain("Service catalog");
    expect(panel.shadowRoot?.querySelector('[aria-label="Temporary MCP connection test"]')).toBeNull();
    checkButton(panel).click();
    await settle(panel);
    expect(text(panel)).not.toContain("Temporary CLI check failed");
    expect(text(panel)).toContain(check.checkedAt);
  });

  it("routes workspace reads, checks and project/user toggles to the selected machine and workspace", async () => {
    const apiClient = client();
    apiClient.list.mockResolvedValue({ ...config, servers: [server, { ...server, scope: "project", enabled: false }] });
    apiClient.setEnabled.mockImplementation((_name, scope, enabled) => Promise.resolve({ ...config, servers: [{ ...server, scope, enabled }] }));
    const panel = await mount(apiClient);
    await selectScope(panel, "workspace");
    const target = { projectId: "p1", workspaceId: "w1" };
    expect(apiClient.list).toHaveBeenLastCalledWith("remote-a", target);
    expect(text(panel)).toContain("Selected workspace: Repo");
    checkButton(panel).click();
    await settle(panel);
    expect(apiClient.check).toHaveBeenCalledExactlyOnceWith("remote-a", target);
    toggle(panel, 1).click();
    await settle(panel);
    expect(apiClient.setEnabled).toHaveBeenLastCalledWith("catalog", "project", true, "remote-a", target);

    refreshButton(panel).click();
    await settle(panel);
    toggle(panel).click();
    await settle(panel);
    expect(apiClient.setEnabled).toHaveBeenLastCalledWith("catalog", "user", false, "remote-a", target);
  });

  it("resets checks/errors on target change and falls back to machine-wide when the workspace disappears", async () => {
    const apiClient = client();
    const panel = await mount(apiClient);
    await selectScope(panel, "workspace");
    checkButton(panel).click();
    await settle(panel);
    apiClient.setEnabled.mockRejectedValue(new Error("Old workspace error"));
    toggle(panel).click();
    await settle(panel);
    expect(text(panel)).toContain("Old workspace error");
    panel.workspace = undefined;
    await settle(panel);
    expect(text(panel)).not.toContain("Old workspace error");
    expect(text(panel)).not.toContain(check.checkedAt);
    expect(panel.shadowRoot?.querySelector("select")?.value).toBe("machine");
    expect(panel.shadowRoot?.querySelectorAll("option")).toHaveLength(1);
    expect(apiClient.list).toHaveBeenLastCalledWith("remote-a", undefined);
  });

  it("shows empty configuration without adding or connecting servers", async () => {
    const apiClient = client();
    apiClient.list.mockResolvedValue({ ...config, servers: [] });
    const panel = await mount(apiClient);
    expect(text(panel)).toContain("No MCP servers configured.");
    expect(apiClient.check).not.toHaveBeenCalled();
    expect(apiClient.setEnabled).not.toHaveBeenCalled();
  });
});

const staleCases: { target: "machine" | "workspace"; operation: "load" | "check" | "save"; outcome: "resolve" | "reject" }[] = [];
for (const target of ["machine", "workspace"] as const) {
  for (const operation of ["load", "check", "save"] as const) {
    for (const outcome of ["resolve", "reject"] as const) staleCases.push({ target, operation, outcome });
  }
}

describe("MCP target-switch protection", () => {
  it.each(staleCases)("ignores stale $operation $outcome after $target change", async ({ target, operation, outcome }) => {
    const apiClient = client();
    const panel = await mount(apiClient);
    await selectScope(panel, "workspace");
    const pendingConfig = deferred<McpServersResponse>();
    const pendingCheck = deferred<McpCheckResponse>();
    if (operation === "load") {
      apiClient.list.mockReturnValueOnce(pendingConfig.promise);
      refreshButton(panel).click();
    } else if (operation === "check") {
      apiClient.check.mockReturnValueOnce(pendingCheck.promise);
      checkButton(panel).click();
    } else {
      apiClient.setEnabled.mockReturnValueOnce(pendingConfig.promise);
      toggle(panel).click();
    }
    await settle(panel);
    const next = deferred<McpServersResponse>();
    apiClient.list.mockReturnValueOnce(next.promise);
    if (target === "machine") panel.machine = { ...machine, id: "remote-b", name: "New host" };
    else panel.workspace = { ...workspace, id: "w2", label: "New workspace" };
    await settle(panel);
    expect(text(panel)).toContain("Loading MCP configuration…");
    expect(text(panel)).not.toContain("Service catalog");
    next.resolve({ ...config, servers: [{ ...server, name: "New target server" }] });
    await settle(panel);

    if (outcome === "reject") (operation === "check" ? pendingCheck : pendingConfig).reject(new Error("Stale target failure"));
    else if (operation === "check") pendingCheck.resolve({ checkedAt: "STALE CHECK", servers: [], errors: ["STALE RESULT"] });
    else pendingConfig.resolve({ servers: [], errors: ["STALE RESULT"], userConfigPath: "STALE CONFIG" });
    await settle(panel);
    expect(text(panel)).toContain("New target server");
    expect(text(panel)).not.toContain("STALE");
    expect(text(panel)).not.toContain("Stale target failure");
    expect(text(panel)).not.toContain("Configuration saved.");
    expect(checkButton(panel).disabled).toBe(false);
    expect(apiClient.list).toHaveBeenLastCalledWith(target === "machine" ? "remote-b" : "remote-a", { projectId: "p1", workspaceId: target === "workspace" ? "w2" : "w1" });
  });

  it("does not send checks or mutations from stale controls before the new target renders", async () => {
    const apiClient = client();
    const panel = await mount(apiClient);
    panel.machine = { ...machine, id: "remote-b" };
    toggle(panel).click();
    checkButton(panel).click();
    expect(apiClient.setEnabled).not.toHaveBeenCalled();
    expect(apiClient.check).not.toHaveBeenCalled();
    await settle(panel);
    expect(apiClient.list).toHaveBeenLastCalledWith("remote-b", undefined);
  });

  it("does not read or apply pending results while disconnected and reloads on reconnection", async () => {
    const apiClient = client();
    const first = deferred<McpServersResponse>();
    apiClient.list.mockReturnValueOnce(first.promise);
    const panel = await mount(apiClient);
    panel.remove();
    first.resolve({ ...config, servers: [{ ...server, name: "Disconnected result" }] });
    await settle(panel);
    expect(apiClient.list).toHaveBeenCalledOnce();
    expect(text(panel)).not.toContain("Disconnected result");
    document.body.append(panel);
    await settle(panel);
    expect(apiClient.list).toHaveBeenCalledTimes(2);
    expect(text(panel)).toContain("Service catalog");
  });

  it("invalidates requests even when scope switches away and back to the same target", async () => {
    const apiClient = client();
    const panel = await mount(apiClient);
    const first = deferred<McpServersResponse>();
    apiClient.list.mockReturnValueOnce(first.promise);
    refreshButton(panel).click();
    await settle(panel);
    await selectScope(panel, "workspace");
    await selectScope(panel, "machine");
    first.resolve({ ...config, servers: [{ ...server, name: "Stale original target" }] });
    await settle(panel);
    expect(text(panel)).not.toContain("Stale original target");
    expect(text(panel)).toContain("Service catalog");
  });
});
