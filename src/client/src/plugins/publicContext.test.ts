import { html, svg } from "lit";
import { expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { adaptPublicPlugin, publicPluginState } from "./publicContext";
import type { WorkspacePanelContext } from "./types";

const session = {
  id: "session", cwd: "/workspace", name: "Conversation", path: "/private/session.jsonl",
  created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: "Private message",
  clientPendingStart: true,
};

it("projects only documented session fields and does not share the internal session object", () => {
  const state = { ...initialAppState(), selectedSession: session };
  const projected = publicPluginState(state);
  expect(projected.selectedSession).toEqual({ id: "session", cwd: "/workspace", name: "Conversation", archived: false, pending: true });
  expect(projected).not.toHaveProperty("sessions");
  expect(projected.selectedSession).not.toBe(session);
  if (projected.selectedSession) projected.selectedSession.name = "Plugin mutation";
  expect(session.name).toBe("Conversation");
  expect(publicPluginState(initialAppState())).not.toHaveProperty("selectedSession");
  const archived = { ...session, archived: true, clientPendingStart: false };
  expect(publicPluginState({ ...state, selectedSession: archived }).selectedSession)
    .toMatchObject({ archived: true, pending: false });
});

it("preserves lifecycle callback receivers while adapting contributions", async () => {
  class Activation {
    contributions = {};
    started = false;
    start() { this.started = true; }
    dispose() { this.started = false; }
  }
  const source = new Activation();
  const plugin = adaptPublicPlugin({ apiVersion: 4, name: "Lifecycle", activate: () => source });
  const signal = new AbortController().signal;
  const activation = await plugin.activate({ apiVersion: 4, pluginId: "lifecycle", runtimePluginId: "lifecycle", html, svg,
    signal, lifetimeSignal: signal });
  await activation.start?.({ signal, capabilities: { resolve() { throw new Error("Unexpected dependency"); } } });
  expect(source.started).toBe(true);
  await activation.dispose?.(signal);
  expect(source.started).toBe(false);
});

it("projects state for every external workspace callback without changing the host context", async () => {
  const visible = vi.fn(() => true);
  const badge = vi.fn(() => "badge");
  const onInvalidate = vi.fn();
  const render = vi.fn(() => html`panel`);
  const items = vi.fn(() => []);
  const plugin = adaptPublicPlugin({ apiVersion: 4, name: "External", activate: () => ({ contributions: {
    workspacePanels: [{ id: "panel", title: "Panel", visible, badge, onInvalidate, render }],
    workspaceLabels: [{ id: "label", visible, items }],
  } }) });
  const activation = await plugin.activate({ apiVersion: 4, pluginId: "external", runtimePluginId: "external", html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
  const unused = () => { throw new Error("Unexpected host call"); };
  const context: WorkspacePanelContext = {
    state: { ...initialAppState(), selectedSession: session },
    machine: { id: "remote", name: "Remote", kind: "remote" },
    workspace: { id: "workspace", projectId: "project", path: "/workspace", label: "Workspace", isMain: true, effectiveConfig: {} },
    files: { readFile: unused, listFiles: unused, writeFile: unused, deleteFile: unused, moveFile: unused },
    prompt: { insertText: unused, getText: unused, getSelection: unused },
    terminal: { open: unused, runCommand: unused }, host: { requestRender: unused },
  };
  const panel = activation.contributions.workspacePanels?.[0];
  const label = activation.contributions.workspaceLabels?.[0];
  expect(panel?.visible?.(context)).toBe(true);
  expect(panel?.badge?.(context)).toBe("badge");
  await panel?.onInvalidate?.(context, { reason: "manual", resources: ["workspace.files"] });
  panel?.render(context);
  label?.visible?.(context);
  label?.items(context);
  for (const callback of [visible, badge, onInvalidate, render, items]) {
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: publicPluginState(context.state) }),
      ...(callback === onInvalidate ? [{ reason: "manual", resources: ["workspace.files"] }] : []));
  }
  expect(context.state.selectedSession).toBe(session);
});
