import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import {
  createPairedPluginWorkspaceBackend,
  createPluginWorkspaceBackend,
  type PluginBackendChannelOpener,
  type PluginBackendRequester,
} from "./workspaceBackend";

const providerlessWorkspace: Workspace = {
  id: "workspace one",
  projectId: "project one",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

const workspace: Workspace = {
  ...providerlessWorkspace,
  provider: {
    pluginId: "changes.owner",
    capabilities: { request: true, remove: false },
  },
};

describe("plugin workspace backend", () => {
  it("keeps the legacy helper owner-backed without paired package metadata", async () => {
    const request = vi.fn<PluginBackendRequester>(() => Promise.resolve({ files: [] }));
    const backend = createPluginWorkspaceBackend({
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    }, workspace, "remote one", request);
    if (backend === undefined) throw new Error("Expected an owner-backed workspace backend");

    await expect(backend.request("status", null)).resolves.toEqual({ files: [] });
    expect(Object.keys(backend)).toEqual(["request"]);
    expect(request).toHaveBeenCalledWith({
      pluginId: "changes.owner",
      backendRevision: "remote-r2",
      machineId: "remote one",
      projectId: "project one",
      workspaceId: "workspace one",
    }, "status", null);
  });

  it("omits the owner-backed helper when the contribution cannot service the current workspace", () => {
    const binding = {
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    };

    expect(createPluginWorkspaceBackend(binding, providerlessWorkspace, "remote one", vi.fn())).toBeUndefined();
    expect(createPluginWorkspaceBackend(binding, {
      ...workspace,
      provider: {
        pluginId: "different.owner",
        capabilities: { request: true, remove: false },
      },
    }, "remote one", vi.fn())).toBeUndefined();
    expect(createPluginWorkspaceBackend(binding, {
      ...workspace,
      provider: {
        pluginId: "changes.owner",
        capabilities: { request: false, remove: false },
      },
    }, "remote one", vi.fn())).toBeUndefined();
  });

  it("binds paired capabilities to the contribution source, revision, workspace, and machine", async () => {
    const request = vi.fn<PluginBackendRequester>(() => Promise.resolve({ files: [] }));
    const openChannel = vi.fn<PluginBackendChannelOpener>(() => Promise.resolve({
      closed: Promise.resolve({ code: 1000, reason: "done", wasClean: true }),
      send: vi.fn(),
      close: vi.fn(),
    }));
    const backend = createPairedPluginWorkspaceBackend({
      registrationPluginId: "machine.remote.changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
      pairedRequestVersion: 1,
      pairedChannelVersion: 1,
    }, workspace, "remote one", request, openChannel);
    if (backend === undefined) throw new Error("Expected a paired workspace backend");

    const controller = new AbortController();
    expect(backend).toMatchObject({ version: 1, requestVersion: 1, channelVersion: 1 });
    await expect(backend.request?.("status", null, { signal: controller.signal })).resolves.toEqual({ files: [] });
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

  it("projects paired request and channel capabilities independently", () => {
    const requestOnly = createPairedPluginWorkspaceBackend({
      registrationPluginId: "request-only",
      sourcePluginId: "request-only",
      backendRevision: "request-r1",
      pairedRequestVersion: 1,
    }, workspace, "local", vi.fn(), vi.fn());
    const channelOnly = createPairedPluginWorkspaceBackend({
      registrationPluginId: "channel-only",
      sourcePluginId: "channel-only",
      backendRevision: "channel-r1",
      pairedChannelVersion: 1,
    }, workspace, "local", vi.fn(), vi.fn());

    expect(requestOnly).toMatchObject({ version: 1, requestVersion: 1 });
    expect(requestOnly).toHaveProperty("request");
    expect(requestOnly).not.toHaveProperty("channelVersion");
    expect(requestOnly).not.toHaveProperty("openChannel");
    expect(channelOnly).toMatchObject({ version: 1, channelVersion: 1 });
    expect(channelOnly).toHaveProperty("openChannel");
    expect(channelOnly).not.toHaveProperty("requestVersion");
    expect(channelOnly).not.toHaveProperty("request");
  });

  it("omits pairedBackend when the browser package advertises no paired capability", () => {
    const backend = createPairedPluginWorkspaceBackend({
      registrationPluginId: "changes.owner",
      sourcePluginId: "changes.owner",
      backendRevision: "remote-r2",
    }, workspace, "remote-1", vi.fn(), vi.fn());

    expect(backend).toBeUndefined();
  });
});
