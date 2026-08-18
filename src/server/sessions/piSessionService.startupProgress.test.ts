import { describe, expect, it } from "vitest";
import { PiSessionService, type PiSessionRuntime } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";
import { isSessionActive } from "../../shared/activity.js";
import type { SessionActivity, SessionStartupProgressEvent } from "../../shared/apiTypes.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function startupEvents(hub: CapturingSessionEventHub): SessionStartupProgressEvent[] {
  return hub.globalEvents.filter((event): event is SessionStartupProgressEvent => event.type === "session.startup");
}

function startupText(hub: CapturingSessionEventHub): string[] {
  return startupEvents(hub).map(({ activity }) => activity.detail === undefined ? activity.label : `${activity.label}: ${activity.detail}`);
}

function activityUpdates(hub: CapturingSessionEventHub): SessionActivity[] {
  return hub.globalEvents.flatMap((event) => event.type === "activity.update" ? [event.activity] : []);
}

/** Records whether the startup channel wrote any per-workspace activity state. */
function recordingWorkspaceActivity() {
  const calls: string[] = [];
  return {
    calls,
    workspaceActivity: {
      applySessionStatus: () => { calls.push("applySessionStatus"); },
      applySessionActivity: () => { calls.push("applySessionActivity"); },
      removeSession: () => { calls.push("removeSession"); },
      reconcileSessionActivity: () => { calls.push("reconcileSessionActivity"); },
    },
  };
}

interface StartupServiceOptions {
  createAgentRuntime?: () => Promise<PiSessionRuntime>;
  catalogRefreshInFlight?: boolean;
  sessionRecords?: ReturnType<typeof sessionRecord>[];
  workspaceActivity?: ReturnType<typeof recordingWorkspaceActivity>["workspaceActivity"];
}

function startupService(options: StartupServiceOptions = {}) {
  const hub = new CapturingSessionEventHub();
  const fake = fakeRuntime();
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: options.createAgentRuntime ?? (() => Promise.resolve(fake.runtime)),
    sessionManager: sessionGateway(options.sessionRecords ?? []),
    heartbeatIntervalMs: 60_000,
    ...(options.workspaceActivity === undefined ? {} : { workspaceActivity: options.workspaceActivity }),
    ...(options.catalogRefreshInFlight === undefined ? {} : {
      catalogRefreshStatus: { isRefreshInFlight: () => options.catalogRefreshInFlight === true },
    }),
  });
  return { hub, fake, service };
}

describe("PiSessionService session startup progress", () => {
  it("reports the runtime construction phase while that construction is still pending", async () => {
    const runtimeResult = deferred<PiSessionRuntime>();
    const { hub, fake, service } = startupService({ createAgentRuntime: () => runtimeResult.promise });

    const started = service.start("/workspace");
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The proof that matters: the user is told what is being waited on before
    // the wait ends, not after it.
    expect(startupText(hub)).toEqual(["Creating session: Starting the Pi session"]);
    expect(startupEvents(hub).at(0)).toMatchObject({ activity: { sessionId: "session-1", phase: "active" } });

    runtimeResult.resolve(fake.runtime);
    await started;
    await service.dispose();
  });

  it("reports the extension loading phase while extension binding is still pending", async () => {
    const bindResult = deferred<undefined>();
    const { hub, fake, service } = startupService();
    fake.session.bindExtensions = () => bindResult.promise;

    const started = service.start("/workspace");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(startupText(hub)).toEqual([
      "Creating session: Starting the Pi session",
      "Creating session: Loading session extensions",
    ]);

    bindResult.resolve(undefined);
    await started;
    await service.dispose();
  });

  it("notes a concurrent provider model list refresh without claiming it is the cause", async () => {
    const runtimeResult = deferred<PiSessionRuntime>();
    const { hub, fake, service } = startupService({
      createAgentRuntime: () => runtimeResult.promise,
      catalogRefreshInFlight: true,
    });

    const started = service.start("/workspace");
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtimeResult.resolve(fake.runtime);
    await started;

    expect(startupText(hub)).toEqual([
      "Creating session: Starting the Pi session · provider model lists are refreshing",
      "Creating session: Loading session extensions · provider model lists are refreshing",
      "idle",
    ]);
    await service.dispose();
  });

  it("states the phase alone when no refresh is running, and when nothing reports refresh state", async () => {
    const withStatus = startupService({ catalogRefreshInFlight: false });
    await withStatus.service.start("/workspace");
    const withoutStatus = startupService();
    await withoutStatus.service.start("/workspace");

    for (const hub of [withStatus.hub, withoutStatus.hub]) {
      expect(startupText(hub)).toEqual([
        "Creating session: Starting the Pi session",
        "Creating session: Loading session extensions",
        "idle",
      ]);
    }
    await withStatus.service.dispose();
    await withoutStatus.service.dispose();
  });

  it("says opening rather than creating when an existing session is opened", async () => {
    const { service, hub } = startupService({ sessionRecords: [sessionRecord("session-1")] });

    await service.status(sessionRef("session-1"));

    expect(startupText(hub)).toEqual([
      "Opening session: Starting the Pi session",
      "Opening session: Loading session extensions",
      "idle",
    ]);
    await service.dispose();
  });

  it("ends the startup window with an idle report when creation succeeds", async () => {
    const { hub, service } = startupService();

    await service.start("/workspace");

    expect(startupEvents(hub).at(-1)).toMatchObject({ activity: { sessionId: "session-1", phase: "idle", label: "idle" } });
    expect(startupEvents(hub).at(-1)?.activity.detail).toBeUndefined();
    await service.dispose();
  });

  it("echoes a create's correlation token on every startup report of that construction", async () => {
    const { hub, service } = startupService();

    await service.start("/workspace", { startupToken: "pending-session-3-k2x9" });

    // The token labels the browser row that is waiting, so it must ride every
    // report of this construction, the closing idle one included.
    expect(startupEvents(hub).map((event) => event.startupToken)).toEqual([
      "pending-session-3-k2x9",
      "pending-session-3-k2x9",
      "pending-session-3-k2x9",
    ]);
    // The token is an opaque throwaway label, never the session's identity.
    expect(startupEvents(hub).map((event) => event.activity.sessionId)).toEqual(["session-1", "session-1", "session-1"]);
    await service.dispose();
  });

  it("publishes no correlation token when a create supplies none, and none for an open", async () => {
    const created = startupService();
    await created.service.start("/workspace");
    const opened = startupService({ sessionRecords: [sessionRecord("session-1")] });
    await opened.service.status(sessionRef("session-1"));

    for (const hub of [created.hub, opened.hub]) {
      expect(startupEvents(hub).length).toBeGreaterThan(0);
      expect(startupEvents(hub).every((event) => event.startupToken === undefined)).toBe(true);
    }
    await created.service.dispose();
    await opened.service.dispose();
  });

  it("ends the startup window when the runtime construction itself fails", async () => {
    const failure = new Error("runtime unavailable");
    const { hub, service } = startupService({ createAgentRuntime: () => Promise.reject(failure) });

    await expect(service.start("/workspace")).rejects.toBe(failure);

    expect(startupText(hub)).toEqual(["Creating session: Starting the Pi session", "idle"]);
    await service.dispose();
  });

  it("keeps a real activity published during startup instead of clearing it", async () => {
    const { hub, fake, service } = startupService();
    fake.session.bindExtensions = (bindings) => {
      bindings.onError?.({ extensionPath: "/ext/broken.js", event: "session_start", error: "boom" });
      return Promise.resolve();
    };

    await service.start("/workspace");

    expect(activityUpdates(hub).some((activity) => activity.label === "extension error")).toBe(true);
    // No idle startup report, so the extension error a user needs to see stays.
    expect(startupEvents(hub).some((event) => event.activity.phase === "idle")).toBe(false);
    await service.dispose();
  });

  it("ends the startup window when extension binding fails, leaving no stale phase label", async () => {
    const failure = new Error("extension refused to load");
    const { hub, fake, service } = startupService();
    fake.session.bindExtensions = () => Promise.reject(failure);

    await expect(service.start("/workspace")).rejects.toBe(failure);

    // The last word on this startup must not be an "active" phase the service is
    // no longer inside; otherwise a waiting row keeps a label that is now false.
    expect(startupText(hub)).toEqual([
      "Creating session: Starting the Pi session",
      "Creating session: Loading session extensions",
      "idle",
    ]);
    await service.dispose();
  });

  it("reports startup progress as starting rather than as work in progress", async () => {
    const { hub, service } = startupService();

    await service.start("/workspace");

    // Startup phases are published with an "active" phase so the waiting user
    // sees them, but opening a session is not work: nothing that decides whether
    // work is in progress may count them.
    const phases = startupEvents(hub).filter((event) => event.activity.phase === "active");
    expect(phases).toHaveLength(2);
    expect(phases.map((event) => isSessionActive(undefined, event.activity))).toEqual([false, false]);
    await service.dispose();
  });

  it("still reports a real activity published during startup as work", async () => {
    const { hub, fake, service } = startupService();

    await service.start("/workspace");
    fake.emit({ type: "tool_execution_start", toolName: "bash" });

    // The marker belongs to the startup channel alone; an ordinary activity for
    // the same session still counts, or the fix would hide real work.
    const running = activityUpdates(hub).filter((activity) => activity.phase === "active");
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((activity) => isSessionActive(undefined, activity))).toBe(true);
    await service.dispose();
  });

  it("keeps startup reporting event-only, writing no session or workspace activity state", async () => {
    const recorder = recordingWorkspaceActivity();
    const failure = new Error("runtime unavailable");
    const { hub, service } = startupService({
      createAgentRuntime: () => Promise.reject(failure),
      workspaceActivity: recorder.workspaceActivity,
    });

    await expect(service.start("/workspace")).rejects.toBe(failure);

    expect(startupEvents(hub)).toHaveLength(2);
    expect(activityUpdates(hub)).toEqual([]);
    expect(recorder.calls).toEqual([]);
    // Startup progress is global-only: it must never reach a per-session socket,
    // because no session exists to have subscribers yet.
    expect(hub.sessionEvents).toEqual([]);
    await service.dispose();
  });
});
