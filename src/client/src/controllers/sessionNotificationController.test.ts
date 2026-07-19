import { describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { selectedNotificationView } from "../sessionNotifications";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import type {
  Machine,
  SessionInfo,
  SessionNotification,
  SessionNotificationCatalogSnapshot,
  SessionNotificationInboxEvent,
  SessionNotificationInboxSnapshot,
} from "../../../shared/apiTypes";
import { SessionNotificationController, type SessionNotificationApi } from "./sessionNotificationController";

const localMachine: Machine = {
  id: "local",
  name: "Local",
  kind: "local",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const session: SessionInfo = {
  id: "session-1",
  cwd: "/repo",
  path: "/tmp/session-1.jsonl",
  created: "2026-07-18T00:00:00.000Z",
  modified: "2026-07-18T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

function entry(order: number, severity: SessionNotification["severity"] = "info"): SessionNotification {
  return {
    id: `daemon-a:${String(order)}`,
    message: `notice ${String(order)}`,
    truncated: false,
    severity,
    receivedAt: `2026-07-18T00:00:${String(order).padStart(2, "0")}.000Z`,
    order,
  };
}

function inboxSnapshot(
  notifications: SessionNotification[] = [entry(1)],
  options: { inboxRevision?: number; catalogRevision?: number; discardedCount?: number; daemonInstanceId?: string } = {},
): SessionNotificationInboxSnapshot {
  const highestSeverity = notifications.some((notification) => notification.severity === "error")
    ? "error"
    : notifications.some((notification) => notification.severity === "warning") ? "warning" : notifications.length > 0 ? "info" : undefined;
  return {
    daemonInstanceId: options.daemonInstanceId ?? "daemon-a",
    catalogRevision: options.catalogRevision ?? options.inboxRevision ?? 1,
    summary: {
      sessionId: session.id,
      cwd: session.cwd,
      inboxRevision: options.inboxRevision ?? 1,
      retainedCount: notifications.length,
      discardedCount: options.discardedCount ?? 0,
      ...(highestSeverity === undefined ? {} : { highestSeverity }),
    },
    notifications,
    dismissThrough: { order: notifications[0]?.order ?? 0, overflowWatermark: options.discardedCount ?? 0 },
  };
}

function catalogSnapshot(catalogRevision = 1): SessionNotificationCatalogSnapshot {
  return {
    daemonInstanceId: "daemon-a",
    catalogRevision,
    sessions: [inboxSnapshot([entry(1)], { inboxRevision: catalogRevision, catalogRevision }).summary],
  };
}

function addedEvent(notification: SessionNotification, inboxRevision: number, retainedCount: number): SessionNotificationInboxEvent {
  return {
    type: "notifications.inbox",
    daemonInstanceId: "daemon-a",
    catalogRevision: inboxRevision,
    summary: {
      sessionId: session.id,
      cwd: session.cwd,
      inboxRevision,
      retainedCount,
      discardedCount: 0,
      highestSeverity: notification.severity,
    },
    dismissThrough: { order: notification.order, overflowWatermark: 0 },
    delta: { kind: "added", notification },
  };
}

function capableState(): AppState {
  return {
    ...initialAppState(),
    machines: [localMachine],
    selectedMachine: localMachine,
    selectedSession: session,
    sessions: [session],
    machineRuntimes: {
      local: {
        machineId: "local",
        ok: true,
        checkedAt: "2026-07-18T00:00:00.000Z",
        capabilities: [PI_WEB_CAPABILITIES.sessionsNotifications],
      },
    },
  };
}

function createHarness(initialState = capableState(), overrides: Partial<SessionNotificationApi> = {}) {
  let state = initialState;
  const api: SessionNotificationApi = {
    notificationCatalog: vi.fn(() => Promise.resolve(catalogSnapshot())),
    notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot())),
    dismissNotification: vi.fn(() => Promise.resolve(inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 }))),
    dismissAllNotifications: vi.fn(() => Promise.resolve(inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 }))),
    workspaces: vi.fn(() => Promise.resolve([])),
    ...overrides,
  };
  const controller = new SessionNotificationController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    { api, onBackgroundError: vi.fn() },
  );
  return {
    controller,
    api,
    get state() { return state; },
    replaceState(next: AppState) { state = next; },
  };
}

describe("SessionNotificationController capability and joins", () => {
  it("makes no notification requests and preserves marked legacy output without effective capability support", async () => {
    const state = { ...capableState(), machineRuntimes: {} };
    const harness = createHarness(state);

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.globalSocketOpened("local");
    await harness.controller.refreshAfterBrowserResume();

    expect(harness.api.notificationInbox).not.toHaveBeenCalled();
    expect(harness.api.notificationCatalog).not.toHaveBeenCalled();
    expect(harness.controller.shouldFilterLegacyNotification("local", "notification-1")).toBe(false);
    expect(harness.state.selectedNotificationInbox).toBeUndefined();
  });

  it("treats a validated authoritative event as support during a rolling capability transition", async () => {
    const state = { ...capableState(), machineRuntimes: {} };
    const harness = createHarness(state);
    harness.controller.prepareSelectedSession(session, "local");

    harness.controller.applySummaryEvent("local", {
      type: "notifications.summary",
      daemonInstanceId: "daemon-a",
      catalogRevision: 1,
      summary: inboxSnapshot().summary,
    });

    await vi.waitFor(() => {
      expect(harness.api.notificationCatalog).toHaveBeenCalledOnce();
      expect(harness.api.notificationInbox).toHaveBeenCalledOnce();
    });
    expect(harness.controller.shouldFilterLegacyNotification("local", "daemon-a:1")).toBe(true);
  });

  it("buffers global events around catalog hydration and applies newer revisions in order", async () => {
    const catalog = deferred<SessionNotificationCatalogSnapshot>();
    const harness = createHarness(capableState(), { notificationCatalog: vi.fn(() => catalog.promise) });

    harness.controller.globalSocketOpened("local");
    harness.controller.applySummaryEvent("local", {
      type: "notifications.summary",
      daemonInstanceId: "daemon-a",
      catalogRevision: 2,
      summary: {
        ...inboxSnapshot([entry(2, "warning"), entry(1)], { inboxRevision: 2, catalogRevision: 2 }).summary,
      },
    });

    expect(harness.state.notificationCatalogsByMachine["local"]).toBeUndefined();
    catalog.resolve(catalogSnapshot(1));
    await vi.waitFor(() => { expect(harness.state.notificationCatalogsByMachine["local"]?.catalogRevision).toBe(2); });

    expect(harness.state.notificationCatalogsByMachine["local"]).toMatchObject({ status: "fresh", daemonInstanceId: "daemon-a" });
    expect(harness.state.notificationCatalogsByMachine["local"]?.summariesBySessionId[session.id]).toMatchObject({ retainedCount: 2, highestSeverity: "warning" });
    expect(harness.controller.shouldFilterLegacyNotification("local", "notification-1")).toBe(true);
  });

  it("lets the selected live event announce before its matching global summary can trigger a snapshot", async () => {
    const first = inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 });
    const state = {
      ...capableState(),
      notificationCatalogsByMachine: {
        local: {
          machineId: "local",
          status: "fresh" as const,
          daemonInstanceId: first.daemonInstanceId,
          catalogRevision: first.catalogRevision,
          summariesBySessionId: { [session.id]: first.summary },
        },
      },
    };
    const notificationInbox = vi.fn(() => Promise.resolve(first));
    const harness = createHarness(state, { notificationInbox });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");

    const event = addedEvent(entry(2, "warning"), 2, 2);
    harness.controller.applySummaryEvent("local", {
      type: "notifications.summary",
      daemonInstanceId: event.daemonInstanceId,
      catalogRevision: event.catalogRevision,
      summary: event.summary,
    });
    await Promise.resolve();
    expect(notificationInbox).toHaveBeenCalledOnce();

    harness.controller.applyInboxEvent("local", event);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.announcements).toMatchObject([
      { severity: "warning", message: "notice 2" },
    ]);
    expect(notificationInbox).toHaveBeenCalledOnce();
  });

  it("refetches the selected inbox when a newly opened global socket finds a newer catalog revision", async () => {
    const first = inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 });
    const second = inboxSnapshot([entry(2, "error"), entry(1)], { inboxRevision: 2, catalogRevision: 2 });
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const notificationCatalog = vi.fn(() => Promise.resolve<SessionNotificationCatalogSnapshot>({
      daemonInstanceId: second.daemonInstanceId,
      catalogRevision: second.catalogRevision,
      sessions: [second.summary],
    }));
    const harness = createHarness(capableState(), { notificationInbox, notificationCatalog });

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    harness.controller.globalSocketOpened("local");

    await vi.waitFor(() => { expect(notificationInbox).toHaveBeenCalledTimes(2); });
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual([
      "daemon-a:2",
      "daemon-a:1",
    ]);
  });

  it("hydrates missing selected-machine project workspaces without changing selection", async () => {
    const project = { id: "project-1", name: "Repo", path: "/repo", createdAt: "now" };
    const next = {
      ...capableState(),
      projects: [project],
      selectedProject: project,
      notificationCatalogsByMachine: {
        local: {
          machineId: "local",
          status: "fresh" as const,
          daemonInstanceId: "daemon-a",
          catalogRevision: 1,
          summariesBySessionId: { [session.id]: inboxSnapshot().summary },
        },
      },
    };
    const workspace = { id: "workspace-1", projectId: project.id, path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false };
    const workspaces = vi.fn(() => Promise.resolve([workspace]));
    const harness = createHarness(next, { workspaces });

    harness.controller.syncEnvironment(initialAppState(), next);

    await vi.waitFor(() => { expect(harness.state.workspacesByProjectId[project.id]).toEqual([workspace]); });
    expect(workspaces).toHaveBeenCalledExactlyOnceWith(project.id, "local");
    expect(harness.state.selectedProject).toBe(project);
  });

  it("ignores an old selected-inbox response after selection changes", async () => {
    const oldInbox = deferred<SessionNotificationInboxSnapshot>();
    const harness = createHarness(capableState(), { notificationInbox: vi.fn(() => oldInbox.promise) });
    const otherSession = { ...session, id: "session-2", path: "/tmp/session-2.jsonl" };

    harness.controller.prepareSelectedSession(session, "local");
    const refresh = harness.controller.refreshSelectedSession(session, "local");
    harness.controller.prepareSelectedSession(otherSession, "local");
    oldInbox.resolve(inboxSnapshot());
    await refresh;

    expect(harness.state.selectedNotificationInbox).toMatchObject({ sessionId: "session-2", status: "loading", notifications: [] });
  });

  it("hides a selected remote inbox when the machine becomes unreachable and ignores an in-flight snapshot", async () => {
    const remoteMachine: Machine = { ...localMachine, id: "remote-a", name: "Remote", kind: "remote", baseUrl: "https://remote.example.test/" };
    const runtime = capableState().machineRuntimes["local"];
    if (runtime === undefined) throw new Error("expected capable runtime fixture");
    const initial = {
      ...capableState(),
      machines: [remoteMachine],
      selectedMachine: remoteMachine,
      machineRuntimes: { [remoteMachine.id]: { ...runtime, machineId: remoteMachine.id } },
    };
    const pendingInbox = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(inboxSnapshot())
      .mockImplementationOnce(() => pendingInbox.promise);
    const harness = createHarness(initial, { notificationInbox });

    harness.controller.prepareSelectedSession(session, remoteMachine.id);
    await harness.controller.refreshSelectedSession(session, remoteMachine.id);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toHaveLength(1);

    const refresh = harness.controller.refreshSelectedSession(session, remoteMachine.id);
    const previous = harness.state;
    const offline: AppState = {
      ...previous,
      machineStatuses: {
        [remoteMachine.id]: {
          machineId: remoteMachine.id,
          ok: false,
          checkedAt: "2026-07-18T00:01:00.000Z",
          status: "offline",
        },
      },
    };
    harness.replaceState(offline);
    harness.controller.syncEnvironment(previous, offline);

    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();

    pendingInbox.resolve(inboxSnapshot([entry(2, "error")], { inboxRevision: 2, catalogRevision: 2 }));
    await refresh;
    expect(harness.state.selectedNotificationInbox?.status).toBe("stale");
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)).toBeUndefined();
  });
});

describe("SessionNotificationController optimistic mutations", () => {
  it("does not let a delayed refresh snapshot roll back a newer dismissal response", async () => {
    const initial = inboxSnapshot([entry(1)], { inboxRevision: 1, catalogRevision: 1 });
    const delayedRefresh = deferred<SessionNotificationInboxSnapshot>();
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => delayedRefresh.promise);
    const dismissed = inboxSnapshot([], { inboxRevision: 2, catalogRevision: 2 });
    const harness = createHarness(capableState(), {
      notificationInbox,
      dismissNotification: vi.fn(() => Promise.resolve(dismissed)),
    });

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const refresh = harness.controller.refreshSelectedSession(session, "local");
    await harness.controller.dismissNotification("daemon-a:1");

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
    delayedRefresh.resolve(initial);
    await refresh;

    expect(harness.state.selectedNotificationInbox?.summary?.inboxRevision).toBe(2);
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
  });

  it("optimistically dismisses one card, reconciles the response, and rolls back/refetches on failure", async () => {
    const dismiss = deferred<SessionNotificationInboxSnapshot>();
    const refreshAfterFailure = deferred<SessionNotificationInboxSnapshot>();
    const initialInbox = inboxSnapshot([entry(2, "warning"), entry(1)]);
    const notificationInbox = vi.fn()
      .mockResolvedValueOnce(initialInbox)
      .mockImplementationOnce(() => refreshAfterFailure.promise);
    const dismissNotification = vi.fn()
      .mockImplementationOnce(() => dismiss.promise)
      .mockRejectedValueOnce(new Error("offline"));
    const notificationCatalog = vi.fn(() => Promise.resolve<SessionNotificationCatalogSnapshot>({
      daemonInstanceId: initialInbox.daemonInstanceId,
      catalogRevision: initialInbox.catalogRevision,
      sessions: [initialInbox.summary],
    }));
    const harness = createHarness(capableState(), { notificationInbox, dismissNotification, notificationCatalog });

    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");
    const firstDismissal = harness.controller.dismissNotification("daemon-a:2");

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);

    dismiss.resolve(inboxSnapshot([entry(1)], { inboxRevision: 2, catalogRevision: 2 }));
    await firstDismissal;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);

    const failedDismissal = harness.controller.dismissNotification("daemon-a:1");
    await vi.waitFor(() => { expect(harness.state.error).toContain("offline"); });
    refreshAfterFailure.resolve(inboxSnapshot([entry(1)], { inboxRevision: 2, catalogRevision: 2 }));
    await failedDismissal;

    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:1"]);
    expect(notificationInbox).toHaveBeenCalledTimes(2);
  });

  it("uses the server cutoff for dismiss-all and leaves a concurrently arriving newer card visible", async () => {
    const dismissAll = deferred<SessionNotificationInboxSnapshot>();
    const dismissAllNotifications = vi.fn(() => dismissAll.promise);
    const harness = createHarness(capableState(), {
      notificationInbox: vi.fn(() => Promise.resolve(inboxSnapshot([entry(2), entry(1)]))),
      dismissAllNotifications,
    });
    harness.controller.prepareSelectedSession(session, "local");
    await harness.controller.refreshSelectedSession(session, "local");

    const dismissal = harness.controller.dismissAll();
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications).toEqual([]);
    expect(dismissAllNotifications).toHaveBeenCalledWith({ id: session.id, cwd: session.cwd }, "daemon-a", { order: 2, overflowWatermark: 0 }, "local");

    harness.controller.applyInboxEvent("local", addedEvent(entry(3), 2, 3));
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:3"]);

    dismissAll.resolve(inboxSnapshot([entry(3)], { inboxRevision: 3, catalogRevision: 3 }));
    await dismissal;
    expect(selectedNotificationView(harness.state.selectedNotificationInbox)?.notifications.map((notification) => notification.id)).toEqual(["daemon-a:3"]);
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolveDeferred = resolve; });
  if (resolveDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred };
}
