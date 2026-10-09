import { html, svg } from "lit";
import { expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { adaptPublicPlugin, publicPluginSession, publicPluginState } from "./publicContext";
import type { SessionLabelContext, WorkspacePanelContext } from "./types";

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

it("exposes detached public session metadata without sharing nested values with host state", () => {
  const metadata = { "example.workflow": { identity: { leg: 2 }, flags: [true] } };
  const state = { ...initialAppState(), selectedSession: { ...session, metadata } };
  const projected = publicPluginState(state).selectedSession;
  expect(projected?.metadata).toEqual(metadata);
  if (projected?.metadata === undefined) throw new Error("Expected public metadata");
  expect(projected.metadata).not.toBe(metadata);
  expect(projected.metadata["example.workflow"]).not.toBe(metadata["example.workflow"]);
  Reflect.set(projected.metadata["example.workflow"] ?? {}, "identity", { leg: 99 });
  expect(metadata["example.workflow"].identity.leg).toBe(2);
  expect(publicPluginState({ ...initialAppState(), selectedSession: session }).selectedSession).not.toHaveProperty("metadata");
});

it("projects an unselected row independently of the selected conversation", () => {
  const row = { ...session, id: "other-row", archived: true, clientPendingStart: false,
    metadata: { workflow: { nested: { leg: 3 } } } };
  const snapshot = publicPluginSession(row);
  expect(snapshot).toEqual({ id: "other-row", cwd: "/workspace", name: "Conversation", archived: true, pending: false,
    metadata: row.metadata });
  expect(snapshot).not.toHaveProperty("path");
  expect(snapshot).not.toHaveProperty("firstMessage");
  Reflect.set(snapshot.metadata?.["workflow"] ?? {}, "nested", { leg: 100 });
  expect(row.metadata.workflow.nested.leg).toBe(3);
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
    sessionLabels: [{ id: "session-label", visible, items }],
  } }) });
  const activation = await plugin.activate({ apiVersion: 4, pluginId: "external", runtimePluginId: "external", html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });
  const unused = () => { throw new Error("Unexpected host call"); };
  const context: WorkspacePanelContext = {
    navigate: () => Promise.resolve(),
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
  const rowContext: SessionLabelContext = { ...context, session: publicPluginSession({ ...session, id: "row" }) };
  activation.contributions.sessionLabels?.[0]?.visible?.(rowContext);
  activation.contributions.sessionLabels?.[0]?.items(rowContext);
  expect(items).toHaveBeenLastCalledWith(expect.objectContaining({ session: { id: "row", cwd: "/workspace", name: "Conversation", archived: false, pending: true } }));
  for (const callback of [visible, badge, onInvalidate, render, items]) {
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ state: publicPluginState(context.state) }),
      ...(callback === onInvalidate ? [{ reason: "manual", resources: ["workspace.files"] }] : []));
  }
  expect(context.state.selectedSession).toBe(session);
});
