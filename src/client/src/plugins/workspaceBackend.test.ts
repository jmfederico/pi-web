import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { createPluginWorkspaceBackend, type PluginBackendChannelOpener, type PluginBackendRequester } from "./workspaceBackend";

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
    const openChannel = vi.fn<PluginBackendChannelOpener>(() => Promise.resolve({
      closed: Promise.resolve({ code: 1000, reason: "done", wasClean: true }),
      send: vi.fn(),
      close: vi.fn(),
    }));
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
      backendCapabilityVersion: 1,
      channelVersion: 1,
    }, workspace, "remote one", request, openChannel);
    if (backend === undefined) throw new Error("Expected a paired workspace backend");

    const controller = new AbortController();
    expect(backend).toMatchObject({ capabilityVersion: 1, channelVersion: 1 });
    await expect(backend.request("status", null, { signal: controller.signal })).resolves.toEqual({ files: [] });
    const channel = await backend.openChannel?.("watch", { cursor: 1 }, { signal: controller.signal, onData: vi.fn() });
    expect(channel).toHaveProperty("send");
    const target = {
      pluginId: "changes.owner",
      backendRevision: "remote-r2",
      machineId: "remote one",
      projectId: "project one",
      workspaceId: "workspace one",
    };
    expect(request).toHaveBeenCalledWith(target, "status", null, { signal: controller.signal });
    expect(openChannel).toHaveBeenCalledWith(target, "watch", { cursor: 1 }, expect.objectContaining({ signal: controller.signal }));
  });

  it("keeps legacy owner-backed helpers compatible without direct capability metadata", () => {
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    }, workspace, "remote-1", () => Promise.resolve(null));

    expect(backend).toBeDefined();
    expect(backend).not.toHaveProperty("capabilityVersion");
  });

  it("omits the optional backend when the browser module has no paired server revision", () => {
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "changes.owner",
      sourcePluginId: "changes.owner",
    }, workspace, "remote-1");

    expect(backend).toBeUndefined();
  });
});
