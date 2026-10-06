import { expect, it, vi } from "vitest";
import type { PluginSelectionService, PluginSelectionSnapshot } from "../../../plugin-api";
import { PluginRegistry } from "./registry";

it("isolates synchronous and asynchronous subscriber failures with plugin attribution", async () => {
  let snapshot: PluginSelectionSnapshot = {};
  const registry = new PluginRegistry({ getSelection: () => snapshot });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const syncError = new Error("sync failure");
  const asyncError = new Error("async failure");
  const received = vi.fn();
  try {
    await registry.register({ id: "observer", plugin: {
      apiVersion: 4, name: "Observer", activate: ({ selection }) => {
        if (selection === undefined) throw new Error("Missing selection service");
        selection.subscribe(() => { throw syncError; });
        selection.subscribe(() => Promise.reject(asyncError));
        selection.subscribe(received);
        return { contributions: {} };
      },
    } });
    snapshot = { selectedProject: { id: "project", name: "Project", path: "/repo" } };
    registry.notifySelectionChanged();
    await Promise.resolve();
    expect(received).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(warning).toHaveBeenCalledWith("PI WEB plugin observer selection subscriber failed", syncError);
    expect(warning).toHaveBeenCalledWith("PI WEB plugin observer selection subscriber failed", asyncError);
  } finally {
    await registry.dispose();
    warning.mockRestore();
  }
});

it.each(["activate", "start"] as const)("stops subscriptions before %s failure rollback, including retained service subscriptions", async (phase) => {
  let snapshot: PluginSelectionSnapshot = {};
  const registry = new PluginRegistry({ getSelection: () => snapshot });
  let service: PluginSelectionService | undefined;
  const received = vi.fn();
  const late = vi.fn();
  const result = await registry.registerBatch([{ id: "failed-observer", plugin: {
    apiVersion: 4, name: "Failed observer", activate: ({ selection }) => {
      if (selection === undefined) throw new Error("Missing selection service");
      service = selection;
      selection.subscribe(received);
      if (phase === "activate") throw new Error("Activation failed");
      return {
        contributions: {}, start: () => { throw new Error("Start failed"); },
        dispose: () => {
          snapshot = { selectedProject: { id: "rollback", name: "Rollback", path: "/rollback" } };
          registry.notifySelectionChanged();
        },
      };
    },
  } }]);
  expect(result.failures[0]?.phase).toBe(phase);
  service?.subscribe(late);
  snapshot = { selectedProject: { id: "next", name: "Next", path: "/next" } };
  registry.notifySelectionChanged();
  expect(received).not.toHaveBeenCalled();
  expect(late).not.toHaveBeenCalled();
  await registry.dispose();
});

it("detaches snapshots and each notification from host state and other subscribers", async () => {
  const workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true,
    provider: { pluginId: "provider", capabilities: { remove: true }, metadata: { branch: "main" } } };
  let snapshot: PluginSelectionSnapshot = {};
  const registry = new PluginRegistry({ getSelection: () => snapshot });
  let service: PluginSelectionService | undefined;
  const received = vi.fn();
  await registry.register({ id: "mutator", plugin: {
    apiVersion: 4, name: "Mutator", activate: ({ selection }) => {
      if (selection === undefined) throw new Error("Missing selection service");
      service = selection;
      selection.subscribe((next) => {
        if (next.selectedWorkspace?.provider?.metadata !== undefined) {
          Reflect.set(next.selectedWorkspace.provider.metadata, "branch", "plugin mutation");
        }
      });
      selection.subscribe(received);
      return { contributions: {} };
    },
  } });
  snapshot = { selectedWorkspace: workspace };
  const read = service?.getSnapshot();
  if (read?.selectedWorkspace?.provider?.metadata === undefined) throw new Error("Missing workspace metadata");
  Reflect.set(read.selectedWorkspace.provider.metadata, "branch", "snapshot mutation");
  registry.notifySelectionChanged();
  expect(workspace.provider.metadata.branch).toBe("main");
  expect(received).toHaveBeenCalledExactlyOnceWith(snapshot);
  registry.notifySelectionChanged();
  expect(received).toHaveBeenCalledOnce();
  await registry.dispose();
});
