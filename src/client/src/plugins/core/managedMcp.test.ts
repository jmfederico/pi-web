// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { render } from "lit";
import { initialAppState } from "../../appState";
import { managedMcpApi } from "../../api/managedMcp";
import { managedMcpView } from "../../api/managedMcp.testSupport";
import type { ApplicationPanelContext } from "../types";
import { createCoreManagedMcpPanel, managedMcpPanelContext } from "./managedMcp";

function context(): ApplicationPanelContext {
  const state = initialAppState();
  state.selectedMachine = { id: "remote", name: "Remote", kind: "remote", createdAt: "", updatedAt: "" };
  state.selectedWorkspace = { id: "workspace", projectId: "project", path: "/work", label: "Work", isMain: true, effectiveConfig: {} };
  state.selectedSession = { id: "session", cwd: "/work", path: "/session.jsonl", created: "", modified: "", messageCount: 0, firstMessage: "" };
  return { state, machine: state.selectedMachine, workspace: state.selectedWorkspace,
    navigate: vi.fn(), prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null }, host: { requestRender: vi.fn() } };
}
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

it("derives a session only from the matching selected machine and workspace", () => {
  const ctx = context();
  expect(managedMcpPanelContext(ctx)).toEqual({ machineId: "remote", cwd: "/work", sessionId: "session" });
  expect(managedMcpPanelContext({ ...ctx, machine: { ...ctx.machine, id: "other" } })).not.toHaveProperty("sessionId");
  const withoutWorkspace = { ...ctx };
  delete withoutWorkspace.workspace;
  expect(managedMcpPanelContext(withoutWorkspace)).toEqual({ machineId: "remote" });
  if (!ctx.state.selectedSession || !ctx.workspace) throw new Error("Missing fixture context");
  ctx.state.selectedSession = { ...ctx.state.selectedSession, cwd: "/other" };
  expect(managedMcpPanelContext(ctx)).not.toHaveProperty("sessionId");
  ctx.state.selectedSession = { ...ctx.state.selectedSession, cwd: ctx.workspace.path, archived: true };
  expect(managedMcpPanelContext(ctx)).not.toHaveProperty("sessionId");
});

it("contributes an application panel without requiring a workspace or session", async () => {
  vi.spyOn(managedMcpApi, "get").mockResolvedValue(managedMcpView());
  const ctx = context();
  const machineOnly = { ...ctx };
  delete machineOnly.workspace;
  machineOnly.state.selectedWorkspace = undefined;
  machineOnly.state.selectedSession = undefined;
  const panel = createCoreManagedMcpPanel();
  expect(panel.id).toBe("mcp");
  expect(panel.visible?.(machineOnly) ?? true).toBe(true);
  render(panel.render(machineOnly), document.body);
  const element = document.querySelector("managed-mcp-panel");
  await element?.updateComplete;
  expect(element?.context).toEqual({ machineId: "remote" });
  expect(managedMcpApi.get).toHaveBeenCalledWith({ machineId: "remote" }, "remote");
});
