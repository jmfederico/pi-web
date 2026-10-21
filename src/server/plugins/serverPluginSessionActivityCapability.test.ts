import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY, type PluginSessionActivityV1Snapshot } from "../../shared/pluginSessionActivityTypes.js";
import type { PluginSessionSnapshot } from "../../shared/pluginCatalogTypes.js";
import { createServerPluginSessionActivityCapabilityFactory } from "./serverPluginSessionActivityCapability.js";

const cwd = resolve("/repo");
const selection = { projectId: "p", workspaceId: "w", sessionId: "cold" };
const snapshot: PluginSessionActivityV1Snapshot = {
  session: { id: "cold", cwd, archived: true, runtime: "not-hosted" },
  lifecycle: "archived", runtimeLoaded: false, activity: "unknown",
  status: {
    persisted: true, isStreaming: null, isCompacting: null, isBashRunning: null,
    pendingMessageCount: null, messageCount: 4,
    queueState: { available: false, reason: "runtime_not_loaded" },
    telemetry: { available: false, reason: "runtime_not_loaded" },
  },
  relatedExecutions: {
    supportedKinds: ["subsession"], unsupportedKinds: ["background-agent", "terminal", "process"],
    truncated: false, executions: [], workingCount: 0, totalCount: 0,
  },
};

function fixture() {
  const projects = { requireProject: vi.fn((id: string) => Promise.resolve({ id, name: "Project", path: cwd, createdAt: "2026-01-01T00:00:00.000Z" })) };
  const workspaces = { resolve: vi.fn((project: { id: string }) => Promise.resolve({
    projectId: project.id, status: "provider" as const, diagnostics: [],
    workspaces: [{ id: "w", projectId: project.id, path: cwd, label: "Main", isMain: true }],
  })) };
  const sessions = {
    listCatalogSessions: vi.fn((path: string): Promise<readonly PluginSessionSnapshot[]> => Promise.resolve([
      { id: "cold", cwd: path, archived: true, runtime: "not-hosted" },
    ])),
    inspectSessionActivity: vi.fn(() => Promise.resolve(snapshot)),
  };
  const lifetime = new AbortController();
  const instance = createServerPluginSessionActivityCapabilityFactory({ projects, workspaces, sessions }).create({
    pluginId: "consumer", packageRoot: "/plugins/consumer", lifetimeSignal: lifetime.signal,
  });
  const activity = PI_WEB_HOST_PI_SESSION_ACTIVITY_CAPABILITY.parse(instance.value);
  return { projects, workspaces, sessions, lifetime, instance, activity };
}

describe("server plugin session activity capability", () => {
  it("rechecks project, workspace and session scope before observational reads", async () => {
    const f = fixture();
    await expect(f.activity.inspect(selection)).resolves.toMatchObject({ lifecycle: "archived", session: { id: "cold" } });
    expect(f.sessions.inspectSessionActivity).toHaveBeenCalledWith(cwd, "cold", expect.any(AbortSignal));
    await expect(f.activity.inspect({ ...selection, sessionId: "missing" })).rejects.toThrow("stale or unavailable");
    expect(f.sessions.inspectSessionActivity).toHaveBeenCalledTimes(1);
  });

  it("fails closed for duplicate and out-of-workspace session rows", async () => {
    const f = fixture();
    f.sessions.listCatalogSessions.mockResolvedValue([
      { id: "cold", cwd, archived: false, runtime: "not-hosted" },
      { id: "cold", cwd, archived: true, runtime: "not-hosted" },
    ]);
    await expect(f.activity.inspect(selection)).rejects.toThrow("ambiguous");
    f.sessions.listCatalogSessions.mockResolvedValue([{ id: "cold", cwd: "/other", archived: false, runtime: "not-hosted" }]);
    await expect(f.activity.inspect(selection)).rejects.toThrow("outside the authorized workspace");
    expect(f.sessions.inspectSessionActivity).not.toHaveBeenCalled();
  });

  it("honors capability lifetime revocation", async () => {
    const f = fixture();
    f.lifetime.abort();
    await expect(f.activity.inspect(selection)).rejects.toThrow("aborted");
    await f.instance.dispose?.(new AbortController().signal);
  });
});
