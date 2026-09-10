import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceActivityService } from "../../activity/workspaceActivityService.js";
import { SessionArchiveStore } from "../sessionArchiveStore.js";
import { SessionUnreadStore } from "../sessionUnreadStore.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  type FakeOmpRpcClient,
  FakeOmpSessionStore,
  getStatePayload,
  NEW_SESSION_ACCEPTED,
  ompRef,
  ompSessionId,
  sessionInfo,
  sessionStatsPayload,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  TEST_NATIVE_ID_B,
} from "./ompSessionService.testSupport.js";

const WORKSPACE_CWD = resolve("/workspace");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempArchiveStore(): Promise<SessionArchiveStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-omp-activity-"));
  tempRoots.push(root);
  return new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archive"));
}

function completeUnreadWork(store: SessionUnreadStore, sessionId: string, cwd = WORKSPACE_CWD): void {
  store.observeActivityState(sessionId, cwd, true);
  store.observeActivityState(sessionId, cwd, false);
}

async function startedActivitySession(configureClient?: (client: FakeOmpRpcClient) => void) {
  const factory = fakeRpcClientFactory((client) => {
    client.onSuccess("new_session", NEW_SESSION_ACCEPTED);
    client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A));
    client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    configureClient?.(client);
  });
  const hub = new CapturingSessionEventHub();
  const unreadStore = new SessionUnreadStore({ createCatalogId: () => "omp-activity-test" });
  const workspaceActivity = new WorkspaceActivityService();
  const onUnreadChanged = vi.fn();
  const service = new OmpSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    createRpcClient: factory,
    store: new FakeOmpSessionStore(),
    unreadStore,
    workspaceActivity,
    onUnreadChanged,
  });
  const session = await service.start(WORKSPACE_CWD);
  const client = factory.clients[0];
  if (client === undefined) throw new Error("expected start to create an OMP client");
  return { service, hub, client, unreadStore, workspaceActivity, onUnreadChanged, ref: { id: session.id, cwd: session.cwd } };
}

describe("OmpSessionService: shared unread and workspace activity lifecycle", () => {
  it("marks background agent work active, then records its completion as unread and idle", async () => {
    const { service, hub, client, workspaceActivity, onUnreadChanged, ref } = await startedActivitySession();

    client.emit({ type: "agent_start" });

    expect(workspaceActivity.snapshot().workspaces).toMatchObject([
      { cwd: WORKSPACE_CWD, hasSessionActivity: true, hasTerminalActivity: false },
    ]);
    expect(hub.eventsFor(ref.id).some((event) => event.type === "activity.update" && event.activity.sessionId === ref.id && event.activity.phase === "active")).toBe(true);
    expect(hub.globalEvents.some((event) => event.type === "activity.update" && event.activity.sessionId === ref.id && event.activity.phase === "active")).toBe(true);
    expect((await service.unreadCatalog()).sessions).toEqual([]);

    client.emit({ type: "agent_end", messages: [], isTerminal: true });

    expect(workspaceActivity.snapshot().workspaces).toEqual([]);
    expect((await service.unreadCatalog()).sessions).toMatchObject([
      { sessionId: ref.id, cwd: WORKSPACE_CWD, completionOrder: 1 },
    ]);
    expect(onUnreadChanged).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(hub.globalEvents.some((event) => event.type === "sessions.unread" && event.sessionId === ref.id && event.unread?.completionOrder === 1)).toBe(true);
    });
  });

  it("publishes deferred bash activity and records successful completion as unread", async () => {
    let finishBash!: (result: { output: string; exitCode: number; cancelled: boolean; truncated: boolean }) => void;
    const bashResult = new Promise<{ output: string; exitCode: number; cancelled: boolean; truncated: boolean }>((resolveResult) => {
      finishBash = resolveResult;
    });
    const { service, hub, workspaceActivity, ref } = await startedActivitySession((client) => {
      client.on("bash", () => bashResult);
    });

    await service.shell(ref, "!printf done");

    await expect(service.status(ref)).resolves.toMatchObject({ isBashRunning: true });
    expect(workspaceActivity.snapshot().workspaces).toMatchObject([
      { cwd: WORKSPACE_CWD, hasSessionActivity: true, hasTerminalActivity: false },
    ]);
    expect(hub.eventsFor(ref.id).some((event) => event.type === "status.update" && event.status.sessionId === ref.id && event.status.isBashRunning)).toBe(true);
    expect((await service.unreadCatalog()).sessions).toEqual([]);

    finishBash({ output: "done", exitCode: 0, cancelled: false, truncated: false });

    await vi.waitFor(async () => {
      await expect(service.status(ref)).resolves.toMatchObject({ isBashRunning: false });
      expect(workspaceActivity.snapshot().workspaces).toEqual([]);
      expect((await service.unreadCatalog()).sessions).toMatchObject([
        { sessionId: ref.id, cwd: WORKSPACE_CWD, completionOrder: 1 },
      ]);
    });
    expect(hub.eventsFor(ref.id).filter((event) => event.type === "status.update").at(-1)).toMatchObject({
      status: { sessionId: ref.id, isBashRunning: false },
    });
  });

  it("clears bash status and workspace activity after both native failure and cancellation", async () => {
    for (const outcome of ["failure", "cancelled"] as const) {
      let settleBash!: (value: { output: string; exitCode: number; cancelled: boolean; truncated: boolean }) => void;
      let failBash!: (error: Error) => void;
      const bashResult = new Promise<{ output: string; exitCode: number; cancelled: boolean; truncated: boolean }>((resolveResult, rejectResult) => {
        settleBash = resolveResult;
        failBash = rejectResult;
      });
      const { service, client, workspaceActivity, ref } = await startedActivitySession((configured) => {
        configured.on("bash", () => bashResult);
        configured.onSuccess("abort_bash", {});
      });
      await service.shell(ref, "!long-running");
      expect(workspaceActivity.snapshot().workspaces).toHaveLength(1);

      if (outcome === "failure") {
        failBash(new Error("native failure"));
      } else {
        await service.abort(ref);
        expect(client.requested).toContainEqual({ type: "abort_bash" });
        settleBash({ output: "", exitCode: 130, cancelled: true, truncated: false });
      }

      await vi.waitFor(async () => {
        await expect(service.status(ref)).resolves.toMatchObject({ isBashRunning: false });
        expect(workspaceActivity.snapshot().workspaces).toEqual([]);
      });
      await service.dispose();
    }
  });

  it("stopping active work removes workspace activity without recording a false completion", async () => {
    const { service, client, workspaceActivity, ref } = await startedActivitySession();
    client.emit({ type: "agent_start" });
    expect(workspaceActivity.snapshot().workspaces).toHaveLength(1);

    await service.stop(ref);

    expect(workspaceActivity.snapshot().workspaces).toEqual([]);
    expect((await service.unreadCatalog()).sessions).toEqual([]);
  });

  it("list reconciliation removes stale OMP state while preserving Pi state in both shared stores", async () => {
    const retainedOmpId = ompSessionId(TEST_NATIVE_ID_A);
    const staleOmpId = ompSessionId(TEST_NATIVE_ID_B);
    const piId = "pi-session";
    const store = new FakeOmpSessionStore().seed({
      nativeId: TEST_NATIVE_ID_A,
      cwd: WORKSPACE_CWD,
      path: "/workspace/a.jsonl",
      info: sessionInfo(TEST_NATIVE_ID_A, WORKSPACE_CWD),
    });
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "omp-reconcile-test" });
    completeUnreadWork(unreadStore, piId);
    completeUnreadWork(unreadStore, staleOmpId);
    completeUnreadWork(unreadStore, retainedOmpId);
    const workspaceActivity = new WorkspaceActivityService();
    for (const sessionId of [piId, staleOmpId, retainedOmpId]) {
      workspaceActivity.applySessionActivity(WORKSPACE_CWD, { sessionId, phase: "active", label: "working", at: "now" });
    }
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: fakeRpcClientFactory(),
      store,
      unreadStore,
      workspaceActivity,
      archiveStore: await tempArchiveStore(),
    });

    await service.list(WORKSPACE_CWD);

    expect((await service.unreadCatalog()).sessions.map((entry) => entry.sessionId)).toEqual([retainedOmpId, piId]);
    workspaceActivity.removeSession(retainedOmpId, WORKSPACE_CWD);
    expect(workspaceActivity.snapshot().workspaces).toHaveLength(1);
    workspaceActivity.removeSession(piId, WORKSPACE_CWD);
    expect(workspaceActivity.snapshot().workspaces).toEqual([]);
  });

  it("archiving an OMP session removes its active and durable unread state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-omp-archive-activity-"));
    tempRoots.push(root);
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session"}\n', "utf8");
    const store = new FakeOmpSessionStore().seed({
      nativeId: TEST_NATIVE_ID_A,
      cwd: root,
      path: sessionFile,
      info: sessionInfo(TEST_NATIVE_ID_A, root, { path: sessionFile }),
    });
    const factory = fakeRpcClientFactory((client) => {
      client.onSuccess("get_session_stats", sessionStatsPayload(TEST_NATIVE_ID_A, { sessionFile }));
      client.onSuccess("get_state", getStatePayload(TEST_NATIVE_ID_A));
    });
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "omp-archive-test" });
    const workspaceActivity = new WorkspaceActivityService();
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: factory,
      store,
      unreadStore,
      workspaceActivity,
      archiveStore: new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archive")),
    });
    const ref = ompRef(TEST_NATIVE_ID_A, root);
    await service.status(ref);
    const client = factory.clients[0];
    if (client === undefined) throw new Error("expected resume to create an OMP client");
    client.emit({ type: "agent_start" });
    client.emit({ type: "agent_end", messages: [], isTerminal: true });
    client.emit({ type: "agent_start" });
    expect((await service.unreadCatalog()).sessions).toHaveLength(1);
    expect(workspaceActivity.snapshot().workspaces).toHaveLength(1);

    await service.archive(ref);

    expect((await service.unreadCatalog()).sessions).toEqual([]);
    expect(workspaceActivity.snapshot().workspaces).toEqual([]);
  });

  it("deleting an archived OMP session forgets stale durable unread state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-omp-delete-unread-"));
    tempRoots.push(root);
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, '{"type":"session"}\n', "utf8");
    const archiveStore = new SessionArchiveStore(join(root, "archived-sessions.json"), join(root, "archive"));
    const sessionId = ompSessionId(TEST_NATIVE_ID_A);
    await archiveStore.archive({
      sessionId,
      cwd: root,
      path: sessionFile,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
    });
    const unreadStore = new SessionUnreadStore({ createCatalogId: () => "omp-delete-test" });
    completeUnreadWork(unreadStore, sessionId, root);
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: fakeRpcClientFactory(),
      store: new FakeOmpSessionStore(),
      unreadStore,
      archiveStore,
    });

    await expect(service.deleteArchivedMany([{ id: sessionId, cwd: root }])).resolves.toMatchObject({
      deletedSessionIds: [sessionId],
      failures: [],
    });
    expect((await service.unreadCatalog()).sessions).toEqual([]);
  });
});
