import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY } from "../../server-plugin-api.js";
import { createServerPluginPiSessionsCapabilityFactory } from "../plugins/serverPluginPiSessionsCapability.js";
import { runSessionDaemonShutdown } from "./sessionDaemonShutdown.js";

describe("session daemon shutdown", () => {
  it("quiesces ingress, disposes consumers before providers, and continues after failures", async () => {
    const events: string[] = [];
    const failure = new Error("plugin stop failed");
    const logger = { error: vi.fn() };
    const onFailure = vi.fn();

    await runSessionDaemonShutdown({
      logger,
      onFailure,
      dependencies: {
        quiesceServer: () => { events.push("quiesce"); },
        serverPlugins: {
          beginShutdown: () => { events.push("plugin-lifetimes"); },
          stop: () => { events.push("plugins"); throw failure; },
        },
        catalogRefresher: { dispose: () => { events.push("catalog"); } },
        auth: { dispose: () => { events.push("auth"); } },
        sessions: { dispose: () => { events.push("sessions"); } },
        unreadStore: { flush: () => { events.push("unread"); } },
        pluginBackends: { closeAll: () => { events.push("backends"); } },
        workspaceProviders: { closeAll: () => { events.push("providers"); } },
        workspaceRemovals: { closeAll: () => { events.push("removals"); } },
        closeServer: () => { events.push("server"); },
      },
    });

    expect(events).toEqual(["quiesce", "plugin-lifetimes", "catalog", "removals", "backends", "providers", "plugins", "sessions", "server", "auth", "unread"]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, operation: "stop server plugins" },
      "session daemon shutdown operation failed",
    );
  });

  it("revokes PI session admission before waiting for contribution drains", async () => {
    const drainStarted = deferred();
    const releaseDrain = deferred();
    const lifetime = new AbortController();
    const project = {
      id: "project-1",
      name: "Project",
      path: resolve("/repo"),
      createdAt: "2026-09-10T00:00:00.000Z",
    };
    const workspace = {
      id: "workspace-1",
      projectId: project.id,
      path: resolve("/repo/worktree"),
      label: "Worktree",
      isMain: false,
    };
    const sessions = {
      createHostedSession: vi.fn(() => Promise.resolve({ id: "unexpected" })),
      startOneShotRun: vi.fn(() => Promise.resolve({ id: "unexpected", completion: Promise.resolve() })),
      abort: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    };
    const instance = createServerPluginPiSessionsCapabilityFactory({
      projects: { requireProject: () => Promise.resolve(project) },
      workspaces: {
        resolve: () => Promise.resolve({
          status: "folder" as const,
          projectId: project.id,
          workspaces: [workspace],
          diagnostics: [],
        }),
      },
      sessions,
    }).create({
      pluginId: "run-consumer",
      packageRoot: "/plugins/run-consumer",
      lifetimeSignal: lifetime.signal,
    });
    const capability = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(instance.value);

    const shutdown = runSessionDaemonShutdown({
      logger: { error: vi.fn() },
      dependencies: {
        quiesceServer: () => undefined,
        serverPlugins: {
          beginShutdown: () => {
            lifetime.abort(new DOMException("Server plugin host is shutting down", "AbortError"));
          },
          stop: async () => { await instance.dispose?.(AbortSignal.timeout(1_000)); },
        },
        catalogRefresher: { dispose: () => undefined },
        auth: { dispose: () => undefined },
        sessions: { dispose: () => undefined },
        unreadStore: { flush: () => undefined },
        pluginBackends: {
          closeAll: () => {
            drainStarted.resolve();
            return releaseDrain.promise;
          },
        },
        workspaceProviders: { closeAll: () => undefined },
        workspaceRemovals: { closeAll: () => undefined },
        closeServer: () => undefined,
      },
    });
    await drainStarted.promise;

    expect(lifetime.signal.aborted).toBe(true);
    await expect(capability.run({
      projectId: project.id,
      workspaceId: workspace.id,
      prompt: "Must not start",
    })).rejects.toThrow("run-consumer is no longer active");
    expect(sessions.startOneShotRun).not.toHaveBeenCalled();

    releaseDrain.resolve();
    await shutdown;
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolveDeferred = resolvePromise; });
  return { promise, resolve: resolveDeferred };
}
