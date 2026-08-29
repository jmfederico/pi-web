import { describe, expect, it, vi } from "vitest";
import type { SessionStatus, WorkspaceProviderAuthorityResolution } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { PluginBackgroundSessionRegistry } from "./pluginBackgroundSessionService.js";

const project: Project = { id: "p1", name: "Project", path: "/repo", createdAt: "2026-08-01T00:00:00.000Z" };
const workspace = { id: "w1", projectId: "p1", path: "/repo/worktree", label: "feature", isMain: false };
function status(running = false, cost = 0.25): SessionStatus {
  return {
    sessionId: "s1",
    model: { provider: "anthropic", id: "model", name: "Model" },
    thinkingLevel: "medium",
    isStreaming: running,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
    cost,
  };
}
function authority(current: WorkspaceProviderAuthorityResolution) {
  return { resolve: () => Promise.resolve(current) };
}
function resolution(): WorkspaceProviderAuthorityResolution {
  return { status: "folder", projectId: "p1", workspaces: [workspace], diagnostics: [] };
}

function sessionHost() {
  return {
    backgroundSessionModels: vi.fn(() => [{ provider: "anthropic", id: "model", name: "Model", thinkingLevels: ["medium"] }]),
    startBackgroundSession: vi.fn(() => Promise.resolve({
      session: { id: "s1", path: "/sessions/s1.jsonl", cwd: workspace.path, created: "2026-08-01T00:00:00.000Z", modified: "2026-08-01T00:00:00.000Z", messageCount: 0, firstMessage: "" },
      status: status(),
    })),
    promptBackgroundSession: vi.fn(() => Promise.resolve(status())),
    backgroundSessionStatus: vi.fn(() => Promise.resolve(status(true))),
    abortBackgroundSession: vi.fn(() => Promise.resolve()),
    forceStopBackgroundSession: vi.fn(() => Promise.resolve()),
    releaseBackgroundSession: vi.fn(),
  };
}

describe("PluginBackgroundSessionRegistry", () => {
  it("revalidates authoritative workspace identity and binds plugin ownership", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry(
      { requireProject: (id) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found")) },
      authority(resolution()),
      sessions,
    );
    const service = registry.forPlugin("background-service");

    const lease = await service.create({ projectId: "p1", workspaceId: "w1", model: { provider: "anthropic", id: "model" }, thinkingLevel: "medium" });
    expect(sessions.startBackgroundSession).toHaveBeenCalledWith("background-service", workspace.path, {
      model: { provider: "anthropic", id: "model" },
      thinkingLevel: "medium",
    });
    await expect(lease.snapshot()).resolves.toMatchObject({ sessionId: "s1", status: "running" });
    await expect(lease.prompt("work")).resolves.toEqual({
      status: "completed",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, estimatedCostUsd: 0.25 },
    });
    expect(sessions.releaseBackgroundSession).toHaveBeenCalledWith("background-service", { id: "s1", cwd: workspace.path });
  });

  it("fails closed for stale or degraded workspaces", async () => {
    const sessions = sessionHost();
    const current = resolution();
    const workspaces = authority(current);
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, workspaces, sessions);
    const service = registry.forPlugin("background-service");

    await expect(service.create({ projectId: "p1", workspaceId: "stale" })).rejects.toThrow("Workspace not found");
    workspaces.resolve = () => Promise.resolve({ status: "degraded", projectId: "p1", workspaces: [workspace], diagnostics: [] });
    await expect(service.create({ projectId: "p1", workspaceId: "w1" })).rejects.toThrow("authority is degraded");
    expect(sessions.startBackgroundSession).not.toHaveBeenCalled();
  });

  it("keeps unknown estimated cost absent", async () => {
    const sessions = sessionHost();
    sessions.startBackgroundSession.mockResolvedValue({
      session: { id: "s1", path: "/sessions/s1.jsonl", cwd: workspace.path, created: "2026-08-01T00:00:00.000Z", modified: "2026-08-01T00:00:00.000Z", messageCount: 0, firstMessage: "" },
      status: status(false, Number.NaN),
    });
    sessions.backgroundSessionStatus.mockResolvedValue(status(false, Number.NaN));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const lease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    await expect(lease.snapshot()).resolves.not.toHaveProperty("usage.estimatedCostUsd");
  });

  it("reports cancellation when the prompt settles while the accepted abort is pending", async () => {
    const sessions = sessionHost();
    let settlePrompt: ((value: SessionStatus) => void) | undefined;
    let acceptAbort: (() => void) | undefined;
    sessions.promptBackgroundSession.mockImplementation(() => new Promise((resolvePrompt) => { settlePrompt = resolvePrompt; }));
    sessions.abortBackgroundSession.mockImplementation(() => new Promise<void>((resolveAbort) => { acceptAbort = resolveAbort; }));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const lease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    const prompt = lease.prompt("work");
    const abort = lease.abort();
    settlePrompt?.(status());

    await expect(prompt).resolves.toMatchObject({ status: "aborted" });
    acceptAbort?.();
    await abort;
    expect(sessions.abortBackgroundSession).toHaveBeenCalledOnce();
    expect(sessions.releaseBackgroundSession).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent prompt and defers public release until the active prompt settles", async () => {
    const sessions = sessionHost();
    let settlePrompt: ((value: SessionStatus) => void) | undefined;
    sessions.promptBackgroundSession.mockImplementation(() => new Promise((resolvePrompt) => { settlePrompt = resolvePrompt; }));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const lease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    const firstPrompt = lease.prompt("first");
    await expect(lease.prompt("second")).rejects.toThrow("already has an active prompt");
    const release = lease.release();
    await Promise.resolve();
    expect(sessions.releaseBackgroundSession).not.toHaveBeenCalled();

    settlePrompt?.(status());
    await expect(firstPrompt).resolves.toMatchObject({ status: "completed" });
    await release;
    expect(sessions.promptBackgroundSession).toHaveBeenCalledOnce();
    expect(sessions.releaseBackgroundSession).toHaveBeenCalledOnce();
  });

  it("does not classify a later successful prompt as aborted after an idle or failed abort", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const idleAbortLease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    await idleAbortLease.abort();
    await expect(idleAbortLease.prompt("work")).resolves.toMatchObject({ status: "completed" });

    const failedAbortLease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });
    sessions.abortBackgroundSession.mockRejectedValueOnce(new Error("abort failed"));
    await expect(failedAbortLease.abort()).rejects.toThrow("abort failed");
    await expect(failedAbortLease.prompt("work")).resolves.toMatchObject({ status: "completed" });
  });

  it("returns release immediately after force-stop even when the prompt never settles", async () => {
    const sessions = sessionHost();
    sessions.promptBackgroundSession.mockImplementation(() => new Promise(() => undefined));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const lease = await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    void lease.prompt("work");
    await lease.forceStop();
    await expect(lease.release()).resolves.toBeUndefined();
    expect(sessions.releaseBackgroundSession).not.toHaveBeenCalled();
  });

  it("drains a pending create during quiesce and rejects later creates", async () => {
    const sessions = sessionHost();
    let settleCreate: ((value: Awaited<ReturnType<typeof sessions.startBackgroundSession>>) => void) | undefined;
    sessions.startBackgroundSession.mockImplementation(() => new Promise((resolveCreate) => { settleCreate = resolveCreate; }));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const service = registry.forPlugin("background-service");
    const create = service.create({ projectId: "p1", workspaceId: "w1" });
    await vi.waitFor(() => { expect(sessions.startBackgroundSession).toHaveBeenCalledOnce(); });

    const quiesce = registry.quiesceAll();
    await expect(service.create({ projectId: "p1", workspaceId: "w1" })).rejects.toThrow("quiescing");
    expect(sessions.forceStopBackgroundSession).not.toHaveBeenCalled();
    settleCreate?.({
      session: { id: "s1", path: "/sessions/s1.jsonl", cwd: workspace.path, created: "2026-08-01T00:00:00.000Z", modified: "2026-08-01T00:00:00.000Z", messageCount: 0, firstMessage: "" },
      status: status(),
    });

    await expect(create).rejects.toThrow("quiescing");
    await expect(quiesce).resolves.toBeUndefined();
    expect(sessions.forceStopBackgroundSession).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling create while permanently fencing later creates", async () => {
    vi.useFakeTimers();
    try {
      const sessions = sessionHost();
      sessions.startBackgroundSession.mockImplementation(() => new Promise(() => undefined));
      const registry = new PluginBackgroundSessionRegistry(
        { requireProject: () => Promise.resolve(project) },
        authority(resolution()),
        sessions,
        25,
      );
      const service = registry.forPlugin("background-service");
      void service.create({ projectId: "p1", workspaceId: "w1" });
      await vi.advanceTimersByTimeAsync(0);

      const quiesce = registry.quiesceAll();
      const timedOut = expect(quiesce).rejects.toThrow("Timed out after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      await expect(service.create({ projectId: "p1", workspaceId: "w1" })).rejects.toThrow("quiescing");
      expect(sessions.forceStopBackgroundSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-stops a create that succeeds after the quiesce drain deadline", async () => {
    vi.useFakeTimers();
    try {
      const sessions = sessionHost();
      let settleCreate: ((value: Awaited<ReturnType<typeof sessions.startBackgroundSession>>) => void) | undefined;
      sessions.startBackgroundSession.mockImplementation(() => new Promise((resolveCreate) => { settleCreate = resolveCreate; }));
      const registry = new PluginBackgroundSessionRegistry(
        { requireProject: () => Promise.resolve(project) },
        authority(resolution()),
        sessions,
        25,
      );
      const create = registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });
      const rejectedCreate = expect(create).rejects.toThrow("quiescing");
      await vi.advanceTimersByTimeAsync(0);
      const quiesce = registry.quiesceAll();
      const timedOut = expect(quiesce).rejects.toThrow("Timed out after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;

      settleCreate?.({
        session: { id: "s1", path: "/sessions/s1.jsonl", cwd: workspace.path, created: "2026-08-01T00:00:00.000Z", modified: "2026-08-01T00:00:00.000Z", messageCount: 0, firstMessage: "" },
        status: status(),
      });
      await rejectedCreate;
      expect(sessions.forceStopBackgroundSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed force-stop cleanup for a later quiesce retry", async () => {
    const sessions = sessionHost();
    sessions.forceStopBackgroundSession.mockRejectedValueOnce(new Error("detach failed"));
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });

    await expect(registry.quiesceAll()).rejects.toThrow("Failed to force-stop 1 background session lease");
    await expect(registry.quiesceAll()).resolves.toBeUndefined();
    expect(sessions.forceStopBackgroundSession).toHaveBeenCalledTimes(2);
  });

  it("cleans up only the failed plugin's leases before global quiesce", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    await registry.forPlugin("background-service").create({ projectId: "p1", workspaceId: "w1" });
    await registry.forPlugin("other").create({ projectId: "p1", workspaceId: "w1" });

    await registry.quiescePlugin("background-service");
    expect(sessions.forceStopBackgroundSession).toHaveBeenCalledExactlyOnceWith("background-service", { id: "s1", cwd: workspace.path });
    await registry.quiesceAll();
    expect(sessions.forceStopBackgroundSession).toHaveBeenLastCalledWith("other", { id: "s1", cwd: workspace.path });
  });

  it("force-stops every outstanding lease during quiesce", async () => {
    const sessions = sessionHost();
    const registry = new PluginBackgroundSessionRegistry({ requireProject: () => Promise.resolve(project) }, authority(resolution()), sessions);
    const service = registry.forPlugin("background-service");
    await service.create({ projectId: "p1", workspaceId: "w1" });

    await registry.quiesceAll();
    await registry.quiesceAll();

    expect(sessions.forceStopBackgroundSession).toHaveBeenCalledOnce();
    expect(sessions.releaseBackgroundSession).not.toHaveBeenCalled();
  });
});
