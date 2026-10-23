import { describe, expect, it, vi } from "vitest";
import type { PluginBackendScope, PluginPeer } from "@jmfederico/pi-web/plugin-api";
import { applicationTerminalContext, terminalBinding, terminalBindings } from "./TerminalContext";

const machine = { id: "remote", name: "Remote", kind: "remote" as const };
const host = { requestRender: vi.fn() };

describe("Terminal application context", () => {
  it("keeps workspace navigation and distinct workspace/machine authority", () => {
    const workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true };
    const navigation = { version: 1 as const, contributionId: "pi-web.terminal:workspace.terminal", query: { terminal: "selected" }, set: vi.fn() };
    const workspacePeer: PluginPeer = { request: vi.fn() };
    const maintenancePeer: PluginPeer = { request: vi.fn() };
    const forScope = vi.fn((scope: PluginBackendScope) => scope.kind === "machine" ? maintenancePeer : workspacePeer);
    const context = applicationTerminalContext({ machine, host, workspace, navigation, backend: { machineId: machine.id, forScope } });
    expect(context.workspace?.navigation).toBe(navigation);
    expect(forScope.mock.calls).toEqual([[{ kind: "machine" }], [{ kind: "workspace", projectId: "project", workspaceId: "workspace" }]]);
    expect(terminalBinding(context, "maintenance")).toEqual({ scope: "maintenance", peer: maintenancePeer });
    expect(terminalBinding(context, "workspace")).toEqual({ scope: "workspace", workspace, peer: workspacePeer, navigation });
    expect(terminalBindings(context).map((binding) => binding.scope)).toEqual(["workspace", "maintenance"]);
  });

  it("does not invent workspace authority when no workspace is selected", () => {
    const forScope = vi.fn(() => ({ request: vi.fn() }));
    const context = applicationTerminalContext({ machine, host, backend: { machineId: machine.id, forScope } });
    expect(forScope).toHaveBeenCalledExactlyOnceWith({ kind: "machine" });
    expect(context.workspace).toBeUndefined();
    expect(terminalBindings(context).map((binding) => binding.scope)).toEqual(["maintenance"]);
    expect(() => terminalBinding(context, "workspace")).toThrow("workspace binding is unavailable");
  });
});
