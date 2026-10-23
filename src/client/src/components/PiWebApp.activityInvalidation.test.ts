// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo, SessionStatus, Workspace } from "../api";
import type { GlobalSessionEvent } from "../sessionSocket";
import { SessionController } from "../controllers/sessionController";
import { PluginRegistry } from "../plugins/registry";
import { PiWebApp } from "./PiWebApp";

const workspace: Workspace = { id: "workspace", projectId: "project", path: "/repo", label: "main", isMain: true, effectiveConfig: {} };
const session: SessionInfo = { id: "session", path: "/repo/session.jsonl", cwd: "/repo", created: "now", modified: "now", messageCount: 1, firstMessage: "" };
const apps = new Set<PiWebApp>();

function status(sessionId = session.id, active = false): SessionStatus {
  return { sessionId, isStreaming: active, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
}

async function fixture() {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const app = new PiWebApp();
  apps.add(app);
  const ready: unknown = Reflect.get(app, "builtInPluginsReady");
  if (!(ready instanceof Promise)) throw new Error("Expected built-in plugins");
  await ready;
  Reflect.set(app, "state", { ...initialAppState(), selectedWorkspace: workspace, selectedSession: session, sessions: [session], status: status(session.id, true) });
  const invalidate = vi.fn().mockResolvedValue(undefined);
  Reflect.set(app, "invalidateWorkspaceResources", invalidate);
  const sessions: unknown = Reflect.get(app, "sessions");
  if (!(sessions instanceof SessionController)) throw new Error("Expected session controller");
  const event = (value: GlobalSessionEvent, machineId = "local") => invoke(app, "handleRealtimeEvent", machineId, value);
  const readActiveSnapshot = () => {
    Reflect.set(sessions, "socket", { connect: () => undefined, close: () => undefined, setHandler: () => undefined });
    Reflect.set(sessions, "notifications", undefined);
    Reflect.set(sessions, "api", {
      transcriptSnapshot: () => Promise.resolve({ page: { messages: [], start: 0, total: 0 }, status: status(session.id, true), seq: 0, partial: null }),
      thinkingLevels: () => Promise.resolve({ levels: [] }),
    });
    return sessions.selectSession(session, { updateUrl: false });
  };
  return { app, sessions, invalidate, event, readActiveSnapshot };
}

function invoke(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`Expected ${name}`);
  return Reflect.apply(method, app, args);
}

afterEach(async () => {
  for (const app of apps) {
    app.disconnectedCallback();
    const plugins: unknown = Reflect.get(app, "plugins");
    if (plugins instanceof PluginRegistry) await plugins.dispose();
  }
  apps.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("PiWebApp runtime-driven file invalidation", () => {
  it("does not interpret deselection as completion, but still observes the agent becoming idle afterward", async () => {
    const test = await fixture();
    test.event({ type: "status.update", status: status(session.id, true) });
    test.sessions.clearActiveSession();
    expect(test.invalidate).not.toHaveBeenCalled();

    test.event({ type: "status.update", status: status() });
    await Promise.resolve();
    expect(test.invalidate).toHaveBeenCalledExactlyOnceWith(workspace, expect.objectContaining({ id: "local" }), {
      reason: "agent-activity", resources: ["workspace.files"],
    });
  });

  it("refreshes files when another agent in the workspace stops, without requiring that conversation to be selected", async () => {
    const test = await fixture();
    const other = { ...session, id: "other" };
    invoke(test.app, "setState", { sessions: [session, other] } satisfies Partial<AppState>);
    test.event({ type: "status.update", status: status(other.id, true) });
    test.event({ type: "status.update", status: status(other.id) });
    await Promise.resolve();
    expect(test.invalidate).toHaveBeenCalledOnce();
  });

  it("synchronizes files when joining ongoing work and again when it finishes before an active heartbeat", async () => {
    const test = await fixture();
    await test.readActiveSnapshot();
    expect(test.invalidate).toHaveBeenCalledOnce();
    test.invalidate.mockClear();
    test.event({ type: "status.update", status: status() });
    await Promise.resolve();
    expect(test.invalidate).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"] as const)("does not turn an independent file-refresh failure into a transcript failure: %s", async (failureMode) => {
    const test = await fixture();
    const failure = new Error("Files unavailable");
    if (failureMode === "throw") test.invalidate.mockImplementationOnce(() => { throw failure; });
    else test.invalidate.mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await test.readActiveSnapshot();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("Workspace file refresh after session activity failed", failure);
    expect(Reflect.get(test.app, "state")).toMatchObject({ browserErrors: {}, status: { isStreaming: true } });
  });

  it("does not refresh a newly selected workspace because work stopped in the previous one", async () => {
    const test = await fixture();
    test.event({ type: "status.update", status: status(session.id, true) });
    // Isolate the selected-workspace tool's own explicit navigation refresh.
    Reflect.set(test.app, "refreshSelectedWorkspaceTool", () => undefined);
    Reflect.set(test.app, "refreshWorkspaceDeletionRuns", () => Promise.resolve());
    invoke(test.app, "setState", { selectedWorkspace: { ...workspace, id: "other", path: "/other" }, selectedSession: undefined, sessions: [], status: undefined } satisfies Partial<AppState>);
    test.event({ type: "status.update", status: status() });
    expect(test.invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate the current machine's files for another machine's work", async () => {
    const test = await fixture();
    test.event({ type: "status.update", status: status(session.id, true) }, "remote");
    test.event({ type: "status.update", status: status() }, "remote");
    expect(test.invalidate).not.toHaveBeenCalled();
  });
});
