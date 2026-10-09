import { html } from "lit";
import { expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { PluginRegistry, installSessionLabelScope } from "./registry";
import type { PiWebPlugin, PluginContributions, PluginPeer, SessionLabelContext, SessionLabelContribution, SessionLabelItem, WorkspacePluginBinding } from "./types";

it("collects visible row items by order, default order, and qualified contribution id", async () => {
  const registry = new PluginRegistry();
  const context = sessionLabelContext("local");
  const firstItems: SessionLabelItem[] = [
    { type: "text", text: "Archived row", title: "Row metadata" },
    { type: "link", text: "Details", href: "https://example.test/session", target: "_blank" },
    { type: "render", render: () => html`<span>Indicator</span>` },
  ];
  const visible = vi.fn<NonNullable<SessionLabelContribution["visible"]>>((row) => row.session.archived);
  const items = vi.fn<SessionLabelContribution["items"]>(() => firstItems);
  const hiddenItems = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "hidden" }]);
  const labels: SessionLabelContribution[] = [
    { id: "late", order: 1100, items: () => [{ type: "text", text: "late" }] },
    { id: "default", items: () => [{ type: "text", text: "default" }] },
    { id: "a", order: 20, items: () => [{ type: "text", text: "zeta:a" }] },
    { id: "hidden", order: 0, visible: () => false, items: hiddenItems },
    { id: "first", order: 10, visible, items },
  ];
  try {
    await registry.register({ id: "zeta", plugin: sessionLabelPlugin(labels) });
    await registry.register({ id: "alpha", plugin: sessionLabelPlugin([
      { id: "z", order: 20, items: () => [{ type: "text", text: "alpha:z" }] },
    ]) });

    const collected = registry.getSessionLabelItems(context);
    expect(collected).toHaveLength(7);
    expect(collected.slice(0, 2)).toEqual(firstItems.slice(0, 2));
    expect(collected.slice(3)).toEqual([
      { type: "text", text: "alpha:z" },
      { type: "text", text: "zeta:a" },
      { type: "text", text: "default" },
      { type: "text", text: "late" },
    ]);
    const rendered = collected[2];
    const original = firstItems[2];
    if (rendered?.type !== "render" || original?.type !== "render") throw new Error("Expected custom label");
    expect(rendered.render()).toEqual(original.render());
    expect(visible).toHaveBeenCalledExactlyOnceWith(context);
    expect(items).toHaveBeenCalledExactlyOnceWith(context);
    expect(items.mock.calls[0]?.[0].session).toBe(context.session);
    expect(hiddenItems).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
  }
});

it("gates portable labels against the row machine and rechecks availability without reactivation", async () => {
  const availableMachines = new Set(["remote"]);
  const isContributionEnabled = vi.fn((pluginId: string, effectiveMachineId: string | undefined) =>
    pluginId === "labels" && effectiveMachineId !== undefined && availableMachines.has(effectiveMachineId));
  const registry = new PluginRegistry({ isContributionEnabled });
  const visible = vi.fn<NonNullable<SessionLabelContribution["visible"]>>(() => true);
  const items = vi.fn<SessionLabelContribution["items"]>((row) => [{ type: "text", text: row.machine.id }]);
  const activate = vi.fn<PiWebPlugin["activate"]>(() => ({ contributions: { sessionLabels: [{ id: "badge", visible, items }] } }));
  const plugin: PiWebPlugin = { apiVersion: 4, name: "Labels", activate };
  const local = sessionLabelContext("local");
  const remote = sessionLabelContext("remote");
  try {
    await registry.register({ id: "labels", plugin });
    expect(registry.getSessionLabelItems(local)).toEqual([]);
    expect(visible).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(registry.getSessionLabelItems(remote)).toEqual([{ type: "text", text: "remote" }]);
    expect(isContributionEnabled).toHaveBeenCalledWith("labels", "local");
    expect(isContributionEnabled).toHaveBeenCalledWith("labels", "remote");

    visible.mockClear();
    items.mockClear();
    availableMachines.delete("remote");
    availableMachines.add("local");
    expect(registry.getSessionLabelItems(remote)).toEqual([]);
    expect(visible).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
    expect(registry.hasPlugin("labels")).toBe(true);
    expect(registry.getSessionLabelItems(local)).toEqual([{ type: "text", text: "local" }]);
    expect(activate).toHaveBeenCalledOnce();
  } finally {
    await registry.dispose();
  }
});

it.each(["gateway-first", "remote-first"] as const)("prefers portable gateway labels over portable remote duplicates (%s)", async (loadOrder) => {
  const registry = new PluginRegistry();
  const remoteVisible = vi.fn<NonNullable<SessionLabelContribution["visible"]>>(() => true);
  const remoteItems = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "remote" }]);
  const gateway: PiWebPlugin = sessionLabelPlugin([{ id: "badge", items: () => [{ type: "text", text: "portable" }] }]);
  const remote: PiWebPlugin = sessionLabelPlugin([{ id: "badge", visible: remoteVisible, items: remoteItems }]);
  try {
    if (loadOrder === "gateway-first") await registry.register({ id: "labels", plugin: gateway });
    await registry.register({ id: "remote-labels", sourcePluginId: "labels", machineId: "remote", plugin: remote });
    if (loadOrder === "remote-first") {
      expect(registry.getSessionLabelItems(sessionLabelContext("local"))).toEqual([]);
      expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual([{ type: "text", text: "remote" }]);
      await registry.register({ id: "labels", plugin: gateway });
    }
    remoteVisible.mockClear();
    remoteItems.mockClear();

    for (const machineId of ["local", "remote", "other"]) {
      expect(registry.getSessionLabelItems(sessionLabelContext(machineId))).toEqual([{ type: "text", text: "portable" }]);
    }
    expect(remoteVisible).not.toHaveBeenCalled();
    expect(remoteItems).not.toHaveBeenCalled();
    expect(registry.hasPlugin("remote-labels")).toBe(loadOrder === "remote-first");
  } finally {
    await registry.dispose();
  }
});

it.each([false, true])("uses a machine-specific remote label only on its machine (gateway machineSpecific: %s)", async (machineSpecific) => {
  let remoteEnabled = true;
  const registry = new PluginRegistry({ isContributionEnabled: (pluginId) => pluginId !== "remote-labels" || remoteEnabled });
  const gateway: PiWebPlugin = sessionLabelPlugin([{ id: "badge", items: () => [{ type: "text", text: "gateway" }] }]);
  const remote: PiWebPlugin = sessionLabelPlugin([{ id: "badge", items: () => [{ type: "text", text: "remote" }] }]);
  try {
    await registry.register({ id: "labels", machineSpecific, plugin: gateway });
    expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual(machineSpecific ? [] : [{ type: "text", text: "gateway" }]);
    await registry.register({ id: "remote-labels", sourcePluginId: "labels", machineId: "remote", machineSpecific: true, plugin: remote });

    expect(registry.getSessionLabelItems(sessionLabelContext("local"))).toEqual([{ type: "text", text: "gateway" }]);
    expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual([{ type: "text", text: "remote" }]);
    expect(registry.getSessionLabelItems(sessionLabelContext("other"))).toEqual(machineSpecific ? [] : [{ type: "text", text: "gateway" }]);
    remoteEnabled = false;
    expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual([]);
    expect(registry.hasPlugin("remote-labels")).toBe(true);
  } finally {
    await registry.dispose();
  }
});

it("passes source-bound backend identity and the scoped context to both label callbacks", async () => {
  let enabled = true;
  const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
  const visible = vi.fn<NonNullable<SessionLabelContribution["visible"]>>(() => true);
  const items = vi.fn<SessionLabelContribution["items"]>((row) => [{ type: "text", text: row.session.id }]);
  const base = sessionLabelContext("remote");
  const peer: PluginPeer = { request: vi.fn<NonNullable<PluginPeer["request"]>>(() => Promise.resolve(null)) };
  const scoped: SessionLabelContext = { ...base, peer };
  const binding: WorkspacePluginBinding = {
    registrationPluginId: "remote-labels",
    sourcePluginId: "labels",
    backendRevision: "server-r7",
    pairedRequestVersion: 1,
    pairedChannelVersion: 1,
  };
  const scope = vi.fn<(binding: WorkspacePluginBinding) => SessionLabelContext>(() => scoped);
  const context = installSessionLabelScope(base, scope);
  try {
    await registry.register({
      id: binding.registrationPluginId,
      sourcePluginId: binding.sourcePluginId,
      machineId: "remote",
      backendRevision: "server-r7",
      pairedRequestVersion: 1,
      pairedChannelVersion: 1,
      plugin: sessionLabelPlugin([{ id: "badge", visible, items }]),
    });

    expect(context).toBe(base);
    expect(registry.getSessionLabelItems(context)).toEqual([{ type: "text", text: "row-session" }]);
    expect(scope.mock.calls).toEqual([[binding], [binding]]);
    expect(visible).toHaveBeenCalledExactlyOnceWith(scoped);
    expect(items).toHaveBeenCalledExactlyOnceWith(scoped);
    expect(items.mock.calls[0]?.[0].peer).toBe(peer);
    expect(items.mock.calls[0]?.[0].session).toBe(base.session);

    scope.mockClear();
    visible.mockClear();
    items.mockClear();
    enabled = false;
    expect(registry.getSessionLabelItems(context)).toEqual([]);
    expect(scope).not.toHaveBeenCalled();
    expect(visible).not.toHaveBeenCalled();
    expect(items).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
  }
});

it("keeps failed-start labels unpublished, aborts before rollback, retries cleanly, and disposes once", async () => {
  const registry = new PluginRegistry();
  const context = sessionLabelContext("local");
  const startError = new Error("labels start failed");
  const items = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "ready" }]);
  const disposed = vi.fn<(lifetimeAborted: boolean) => void>();
  const lifetimes: AbortSignal[] = [];
  let failStart = true;
  const plugin: PiWebPlugin = {
    apiVersion: 4,
    name: "Retryable labels",
    activate: ({ lifetimeSignal }) => {
      lifetimes.push(lifetimeSignal);
      return {
        contributions: { sessionLabels: [{ id: "badge", items }] },
        start: () => {
          expect(lifetimeSignal.aborted).toBe(false);
          expect(registry.hasPlugin("labels")).toBe(false);
          expect(registry.getSessionLabelItems(context)).toEqual([]);
          if (failStart) throw startError;
        },
        dispose: () => {
          disposed(lifetimeSignal.aborted);
          expect(registry.getSessionLabelItems(context)).toEqual([]);
        },
      };
    },
  };
  try {
    const result = await registry.registerBatch([{ id: "labels", plugin }]);
    expect(result.failures).toEqual([{ declaration: { id: "labels" }, phase: "start", error: startError }]);
    expect(registry.hasPlugin("labels")).toBe(false);
    expect(registry.getSessionLabelItems(context)).toEqual([]);
    expect(items).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledExactlyOnceWith(true);
    expect(lifetimes[0]?.aborted).toBe(true);

    failStart = false;
    await registry.register({ id: "labels", plugin });
    expect(registry.hasPlugin("labels")).toBe(true);
    expect(lifetimes[1]?.aborted).toBe(false);
    expect(registry.getSessionLabelItems(context)).toEqual([{ type: "text", text: "ready" }]);
    expect(items).toHaveBeenCalledOnce();
    registry.beginShutdown();
    expect(lifetimes[1]?.aborted).toBe(true);
    expect(registry.getSessionLabelItems(context)).toEqual([]);
    expect(items).toHaveBeenCalledOnce();
    await registry.dispose();
    await registry.dispose();
    expect(disposed.mock.calls).toEqual([[true], [true]]);
    expect(registry.hasPlugin("labels")).toBe(false);
    expect(registry.getSessionLabelItems(context)).toEqual([]);
  } finally {
    await registry.dispose();
  }
});

it("does not fall back to portable labels when a declared machine-specific remote fails to start", async () => {
  const registry = new PluginRegistry();
  const items = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "failed remote" }]);
  const remote: PiWebPlugin = {
    apiVersion: 4,
    name: "Failed remote labels",
    activate: () => ({
      contributions: { sessionLabels: [{ id: "badge", items }] },
      start: () => { throw new Error("remote start failed"); },
    }),
  };
  try {
    await registry.register({ id: "labels", plugin: sessionLabelPlugin([{ id: "badge", items: () => [{ type: "text", text: "portable" }] }]) });
    expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual([{ type: "text", text: "portable" }]);
    await expect(registry.register({ id: "remote-labels", sourcePluginId: "labels", machineId: "remote", machineSpecific: true, plugin: remote }))
      .rejects.toThrow("remote start failed");

    expect(registry.getSessionLabelItems(sessionLabelContext("remote"))).toEqual([]);
    expect(registry.getSessionLabelItems(sessionLabelContext("local"))).toEqual([{ type: "text", text: "portable" }]);
    expect(registry.getSessionLabelItems(sessionLabelContext("other"))).toEqual([{ type: "text", text: "portable" }]);
    expect(registry.hasPlugin("remote-labels")).toBe(false);
    expect(items).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
  }
});

it.each(["", "Upper", "labels:badge", "badge/name"])("rejects invalid session-label local id %j without publishing earlier labels", async (id) => {
  const registry = new PluginRegistry();
  const items = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "partial" }]);
  const labels: SessionLabelContribution[] = [{ id: "valid", items }, { id, items }];
  try {
    await expect(registry.register({ id: "labels", plugin: sessionLabelPlugin(labels) }))
      .rejects.toThrow(`Invalid contribution id: ${id}`);
    expect(registry.hasPlugin("labels")).toBe(false);
    expect(registry.getSessionLabelItems(sessionLabelContext("local"))).toEqual([]);
    expect(items).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
  }
});

it.each(["sessionLabels", "actions", "workspaceLabels"] as const)("rejects session-label ids duplicated in %s within the plugin namespace", async (surface) => {
  const registry = new PluginRegistry();
  const items = vi.fn<SessionLabelContribution["items"]>(() => [{ type: "text", text: "partial" }]);
  const label: SessionLabelContribution = { id: "duplicate", items };
  const contributions: PluginContributions = {
    sessionLabels: surface === "sessionLabels" ? [label, label] : [label],
    ...(surface === "actions" ? { actions: [{ id: "duplicate", title: "Action", run: () => undefined }] } : {}),
    ...(surface === "workspaceLabels" ? { workspaceLabels: [{ id: "duplicate", items: () => [] }] } : {}),
  };
  const plugin: PiWebPlugin = { apiVersion: 4, name: "Duplicate labels", activate: () => ({ contributions }) };
  try {
    await expect(registry.register({ id: "labels", plugin })).rejects.toThrow("Duplicate contribution id: labels:duplicate");
    expect(registry.hasPlugin("labels")).toBe(false);
    expect(registry.getSessionLabelItems(sessionLabelContext("local"))).toEqual([]);
    expect(items).not.toHaveBeenCalled();
  } finally {
    await registry.dispose();
  }
});

it.each(["visible", "items"] as const)("isolates a throwing %s callback and retries it on a later collection", async (phase) => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  const context = sessionLabelContext("remote");
  const error = new Error(`broken ${phase}`);
  let broken = true;
  const failIfBroken = () => { if (broken) throw error; };
  const visible = vi.fn<NonNullable<SessionLabelContribution["visible"]>>(() => {
    if (phase === "visible") failIfBroken();
    return true;
  });
  const items = vi.fn<SessionLabelContribution["items"]>(() => {
    if (phase === "items") failIfBroken();
    return [{ type: "text", text: "Recovered" }];
  });
  try {
    await registry.register({ id: "labels", plugin: sessionLabelPlugin([
      { id: "broken", order: 1, visible, items },
      { id: "healthy", order: 2, items: () => [{ type: "text", text: "Healthy" }] },
    ]) });
    expect(registry.getSessionLabelItems(context)).toEqual([{ type: "text", text: "Healthy" }]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      `PI WEB plugin session label labels:broken ${phase} failed for session row-session on machine remote`, error,
    );
    if (phase === "visible") expect(items).not.toHaveBeenCalled();
    expect(registry.hasPlugin("labels")).toBe(true);

    broken = false;
    expect(registry.getSessionLabelItems(context)).toEqual([
      { type: "text", text: "Recovered" }, { type: "text", text: "Healthy" },
    ]);
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    await registry.dispose();
    warning.mockRestore();
  }
});

it("omits only a throwing render item and evaluates healthy templates once per collection", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const registry = new PluginRegistry();
  const context = sessionLabelContext("remote");
  const error = new Error("broken render");
  const template = html`<button>Healthy control</button>`;
  const render = vi.fn(() => template);
  try {
    await registry.register({ id: "labels", plugin: sessionLabelPlugin([
      { id: "mixed", items: () => [
        { type: "text", text: "Before" },
        { type: "render", render: () => { throw error; } },
        { type: "render", render },
        { type: "text", text: "After" },
      ] },
    ]) });
    const collected = registry.getSessionLabelItems(context);
    expect(collected).toHaveLength(3);
    expect([collected[0], collected[2]]).toEqual([
      { type: "text", text: "Before" }, { type: "text", text: "After" },
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "PI WEB plugin session label labels:mixed render failed for session row-session on machine remote", error,
    );
    expect(render).toHaveBeenCalledOnce();
    const item = collected[1];
    if (item?.type !== "render") throw new Error("Expected healthy custom item");
    expect(item.render()).toBe(template);
    expect(item.render()).toBe(template);
    expect(render).toHaveBeenCalledOnce();

    registry.getSessionLabelItems(context);
    expect(render).toHaveBeenCalledTimes(2);
  } finally {
    await registry.dispose();
    warning.mockRestore();
  }
});

function sessionLabelPlugin(sessionLabels: SessionLabelContribution[]): PiWebPlugin {
  return { apiVersion: 4, name: "Session labels", activate: () => ({ contributions: { sessionLabels } }) };
}

function sessionLabelContext(machineId: string): SessionLabelContext {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace: { id: "workspace", projectId: "project", path: "/project", label: "main", isMain: true, effectiveConfig: {} },
    state: {
      ...initialAppState(),
      selectedMachine: { id: "local", name: "Local", kind: "local", createdAt: "2026-05-20T00:00:00.000Z", updatedAt: "2026-05-20T00:00:00.000Z" },
    },
    session: { id: "row-session", cwd: "/project", name: "Archived row", archived: true, pending: false, metadata: { labels: { status: "done" } } },
    files: {
      readFile: vi.fn<SessionLabelContext["files"]["readFile"]>(),
      listFiles: vi.fn<SessionLabelContext["files"]["listFiles"]>(),
      writeFile: vi.fn<SessionLabelContext["files"]["writeFile"]>(),
      deleteFile: vi.fn<SessionLabelContext["files"]["deleteFile"]>(),
      moveFile: vi.fn<SessionLabelContext["files"]["moveFile"]>(),
    },
    host: { requestRender: vi.fn<SessionLabelContext["host"]["requestRender"]>() },
    navigate: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
}
