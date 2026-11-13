// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { html, render, svg } from "lit";
import type { ApplicationPanelContextV5 } from "@jmfederico/pi-web/plugin-api";
import { managedMcpView } from "./managedMcp.testSupport.js";
import { managedMcpPanelContext } from "./panel.js";
import { panelServices } from "./panel.testSupport.js";
import plugin from "./pi-web-plugin.js";

function context(): Pick<ApplicationPanelContextV5, "state" | "machine" | "workspace"> {
  const machine = { id: "remote", name: "Remote", kind: "remote" as const };
  const workspace = { id: "workspace", projectId: "project", path: "/work", label: "Work", isMain: true };
  const session = { id: "session", cwd: "/work", archived: false, pending: false };
  return { machine, workspace, state: { selectedMachine: machine, selectedWorkspace: workspace, selectedSession: session } };
}
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it("derives a session only from the matching selected machine and workspace", () => {
  const ctx = context();
  expect(managedMcpPanelContext(ctx)).toEqual({ machineId: "remote", projectId: "project", workspaceId: "workspace", cwd: "/work", sessionId: "session" });
  expect(managedMcpPanelContext({ ...ctx, machine: { ...ctx.machine, id: "other" } })).not.toHaveProperty("sessionId");
  const withoutWorkspace = { ...ctx };
  delete withoutWorkspace.workspace;
  expect(managedMcpPanelContext(withoutWorkspace)).toEqual({ machineId: "remote" });
  if (!ctx.state.selectedSession || !ctx.workspace) throw new Error("Missing fixture context");
  const session = ctx.state.selectedSession;
  for (const patch of [{ cwd: "/other" }, { archived: true }, { pending: true }]) {
    ctx.state.selectedSession = { ...session, ...patch };
    expect(managedMcpPanelContext(ctx)).not.toHaveProperty("sessionId");
  }
});

it("activates an application panel using its injected machine backend and public styles", async () => {
  const services = panelServices();
  const request = vi.fn().mockResolvedValue(managedMcpView());
  const backend = { machineId: "remote", forScope: vi.fn(() => ({ request })) };
  const activation = plugin.activate({ apiVersion: 5, pluginId: "mcp-manager", runtimePluginId: "remote.mcp-manager", html, svg,
    signal: services.lifetime.signal, lifetimeSignal: services.lifetime.signal, localization: services.localization });
  activation.start({ capabilities: { resolve: (capability) => capability.parse(services.styles) }, signal: services.lifetime.signal });
  const contribution = activation.contributions.applicationPanels[0];
  if (!contribution) throw new Error("Missing MCP panel");
  const machine = context().machine;
  const panelContext: ApplicationPanelContextV5 = { machine, state: { selectedMachine: machine }, backend,
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null }, host: { requestRender: vi.fn() },
    catalog: { version: 1, machineId: machine.id, projects: { list: vi.fn(), get: vi.fn() }, workspaces: { list: vi.fn(), get: vi.fn() }, sessions: { list: vi.fn(), get: vi.fn() } } };
  render(contribution.render(panelContext), document.body);
  const element = document.querySelector("managed-mcp-panel");
  await element?.updateComplete;
  await element?.updateComplete;
  expect(element?.context).toEqual({ machineId: "remote" });
  expect(element?.backend).toBe(backend);
  expect(backend.forScope).toHaveBeenCalledWith({ kind: "machine" });
  expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["view", {}]);
  await vi.waitFor(() => { expect(element?.shadowRoot?.querySelector("input")).not.toBeNull(); });
  document.body.replaceChildren();
  services.lifetime.abort();
});
