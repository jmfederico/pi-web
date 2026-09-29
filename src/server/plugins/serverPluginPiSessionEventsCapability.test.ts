import { resolve } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY } from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import { PiSessionEventConnections } from "../sessions/piSessionEventConnections.js";
import { createServerPluginPiSessionEventsCapabilityFactory } from "./serverPluginPiSessionEventsCapability.js";

function harness() {
  const project: Project = { id: "project", name: "Project", path: resolve("/repo"), createdAt: "2026-09-10T00:00:00.000Z" };
  const workspace = { id: "workspace", projectId: project.id, path: resolve("/repo/worktree"), label: "Worktree", isMain: false };
  const projects = { requireProject: vi.fn((id: string) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found"))) };
  const workspaces = { resolve: vi.fn(() => Promise.resolve({ status: "folder" as const, projectId: project.id, workspaces: [workspace], diagnostics: [] })) };
  const registry = new PiSessionEventConnections();
  const session = {}, bus = createEventBus();
  registry.register(session, bus);
  const sessions = { connectSessionEvents: vi.fn((_ref: { id: string; cwd: string }, lifetime: AbortSignal) => registry.connect(session, lifetime)) };
  const factory = createServerPluginPiSessionEventsCapabilityFactory({ projects, workspaces, sessions });
  const lifetime = new AbortController();
  const instance = factory.create({ pluginId: "companion", packageRoot: "/plugins/companion", lifetimeSignal: lifetime.signal });
  const capability = PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY.parse(instance.value);
  const selection = { projectId: project.id, workspaceId: workspace.id, sessionId: "exact-session-id" };
  return { factory, lifetime, instance, capability, selection, projects, workspaces, sessions, workspace, bus };
}

describe("selected-machine hosted session event capability", () => {
  it("resolves each selection on its daemon and revokes listeners without session control", async () => {
    const fixture = harness();
    const remote = harness();
    const connection = await fixture.capability.connect(fixture.selection);
    const received = vi.fn();
    connection.on("reply", received);
    fixture.bus.on("request", (data) => { fixture.bus.emit("reply", data); });
    connection.emit("request", { id: 1 });
    expect(received).toHaveBeenCalledWith({ id: 1 });
    expect(remote.sessions.connectSessionEvents).not.toHaveBeenCalled();
    expect(fixture.sessions.connectSessionEvents).toHaveBeenCalledWith({ id: "exact-session-id", cwd: fixture.workspace.path }, expect.any(AbortSignal));
    await fixture.capability.connect(fixture.selection);
    expect(fixture.workspaces.resolve).toHaveBeenCalledTimes(2);
    await fixture.instance.dispose?.(new AbortController().signal);
    expect(connection.signal.aborted).toBe(true);
    fixture.bus.emit("reply", "late");
    expect(received).toHaveBeenCalledTimes(1);
    await expect(fixture.capability.connect(fixture.selection)).rejects.toThrow("lifetime ended");
    await remote.instance.dispose?.(new AbortController().signal);
  });

  it("rejects stale/mismatched authority and invalid ids before selecting a runtime", async () => {
    const fixture = harness();
    await expect(fixture.capability.connect({ ...fixture.selection, projectId: "other" })).rejects.toThrow();
    await expect(fixture.capability.connect({ ...fixture.selection, workspaceId: "missing" })).rejects.toThrow();
    await expect(fixture.capability.connect({ ...fixture.selection, sessionId: "" })).rejects.toThrow("session id");
    expect(fixture.sessions.connectSessionEvents).not.toHaveBeenCalled();
    await fixture.instance.dispose?.(new AbortController().signal);
  });

  it("does not admit a connection when plugin lifetime ends during workspace resolution", async () => {
    const fixture = harness();
    const original = fixture.workspaces.resolve.getMockImplementation();
    fixture.workspaces.resolve.mockImplementation(() => {
      fixture.lifetime.abort();
      if (original === undefined) throw new Error("Missing workspace fixture");
      return original();
    });
    await expect(fixture.capability.connect(fixture.selection)).rejects.toThrow();
    expect(fixture.sessions.connectSessionEvents).not.toHaveBeenCalled();
  });
});
