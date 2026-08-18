import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { createPluginWorkspaceBackend, type PluginBackendRequester } from "./workspaceBackend";

const workspace: Workspace = {
  id: "workspace one",
  projectId: "project one",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
  provider: {
    pluginId: "changes.owner",
    capabilities: { request: true, remove: false },
  },
};

describe("plugin workspace backend", () => {
  it("binds the contribution source and revision to its workspace and machine", async () => {
    const request = vi.fn<PluginBackendRequester>(() => Promise.resolve({ files: [] }));
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    }, workspace, "remote one", request);
    if (backend === undefined) throw new Error("Expected a paired workspace backend");

    await expect(backend.request("status", null)).resolves.toEqual({ files: [] });
    expect(request).toHaveBeenCalledWith({
      pluginId: "changes.owner",
      backendRevision: "remote-r2",
      machineId: "remote one",
      projectId: "project one",
      workspaceId: "workspace one",
    }, "status", null);
  });

  it("omits the optional backend when the browser module has no paired server revision", () => {
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "changes.owner",
      sourcePluginId: "changes.owner",
    }, workspace, "remote-1");

    expect(backend).toBeUndefined();
  });
});
