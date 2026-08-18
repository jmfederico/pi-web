import { describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateRequest, SessionTreeSummaryChoice } from "../../shared/apiTypes.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { PiSessionService, type PiAgentSession, type PiSessionManager, type PiSessionServiceDependencies } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModel, testModelRuntime, type TestSession } from "./piSessionService.testSupport.js";
import type { ProjectableSessionTreeNode } from "./sessionTreeProjection.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const SESSION_ID = "tree-session";

type NavigateTree = NonNullable<PiAgentSession["navigateTree"]>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function treeNode(entry: Record<string, unknown>, children: ProjectableSessionTreeNode[] = []): ProjectableSessionTreeNode {
  return { entry, children };
}

function navigationRequest(
  summary: SessionTreeSummaryChoice = { mode: "none" },
  expectedLeafId: string | null = "leaf-1",
): SessionTreeNavigateRequest {
  return { targetId: "target-1", expectedLeafId, summary };
}

function treeHarness(
  managerPatch: Partial<PiSessionManager> = {},
  sessionPatch: Partial<TestSession> = {},
  dependenciesPatch: Partial<PiSessionServiceDependencies> = {},
) {
  const hub = new CapturingSessionEventHub();
  const manager = fakeSessionManager("/workspace", {
    getSessionId: () => SESSION_ID,
    getLeafId: () => "leaf-1",
    ...managerPatch,
  });
  const fake = fakeRuntime(SESSION_ID, { sessionManager: manager, ...sessionPatch });
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    archiveStore: emptyArchiveStore(),
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord(SESSION_ID)]),
    heartbeatIntervalMs: 60_000,
    ...dependenciesPatch,
  });
  return { service, fake, hub };
}

describe("PiSessionService session-tree behavior", () => {
  it("opens /tree from the live manager through the safe projection boundary", async () => {
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const roots = [treeNode({
      type: "message",
      id: "leaf-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "safe answer" },
          { type: "thinking", thinking: "private reasoning", thinkingSignature: "private signature" },
        ],
        usage: { private: true },
      },
    })];
    const { service } = treeHarness({ getTree: () => roots }, { navigateTree });

    await expect(service.runCommand(sessionRef(SESSION_ID), "/tree")).resolves.toEqual({
      type: "tree",
      tree: {
        nodes: [{
          id: "leaf-1",
          parentId: null,
          kind: "assistant",
          summary: "safe answer",
          timestamp: "2026-01-01T00:00:00.000Z",
        }],
        activeLeafId: "leaf-1",
        activePathIds: ["leaf-1"],
      },
    });

    await service.dispose();
  });

  it("maps none, default, and trimmed custom summary choices exactly and returns only editor text", async () => {
    const navigateTree = vi.fn<NavigateTree>();
    navigateTree
      .mockResolvedValueOnce({ cancelled: false })
      .mockResolvedValueOnce({ cancelled: false })
      .mockResolvedValueOnce({ cancelled: false, editorText: "exact user text", summaryEntry: { details: "must not escape" } });
    const { service, fake } = treeHarness({}, { navigateTree });

    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "none" }))).resolves.toEqual({ cancelled: false });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "default" }))).resolves.toEqual({ cancelled: false });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "custom", instructions: "  focus on tests\nwithout losing context  " }))).resolves.toEqual({
      cancelled: false,
      editorText: "exact user text",
    });

    expect(navigateTree).toHaveBeenNthCalledWith(1, "target-1", { summarize: false });
    expect(navigateTree).toHaveBeenNthCalledWith(2, "target-1", { summarize: true });
    expect(navigateTree).toHaveBeenNthCalledWith(3, "target-1", { summarize: true, customInstructions: "focus on tests\nwithout losing context" });
    expect(service.activeCount()).toBe(1);
    expect(fake.calls.dispose).toBe(0);

    await service.dispose();
  });

  it("validates stale leaves, active work, unavailable runtimes, and custom instruction bounds", async () => {
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({ getLeafId: () => "new-leaf" }, { navigateTree });

    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "none" }, "old-leaf"))).rejects.toThrow(
      "The session changed since /tree was opened. Reopen /tree and try again.",
    );
    expect(navigateTree).not.toHaveBeenCalled();

    fake.session.isStreaming = true;
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "none" }, "new-leaf"))).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );
    fake.session.isStreaming = false;

    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "custom", instructions: "   " }, "new-leaf"))).rejects.toThrow(
      "Custom branch-summary instructions are required",
    );
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "custom", instructions: "x".repeat(10_001) }, "new-leaf"))).rejects.toThrow(
      "Custom branch-summary instructions must be at most 10000 characters",
    );
    expect(navigateTree).not.toHaveBeenCalled();
    await service.dispose();

    const unavailable = treeHarness();
    await expect(unavailable.service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Session tree navigation is not supported by this Pi runtime",
    );
    await unavailable.service.dispose();
  });

  it("holds a per-runtime gate that rejects concurrent navigation and leaf-producing work", async () => {
    const navigation = deferred<Awaited<ReturnType<NavigateTree>>>();
    const navigateTree = vi.fn<NavigateTree>(() => navigation.promise);
    const { service, fake } = treeHarness({}, { navigateTree });

    const firstNavigation = service.navigateTree(sessionRef(SESSION_ID), navigationRequest());
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });

    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );
    await expect(service.prompt(sessionRef(SESSION_ID), "do not append yet")).rejects.toThrow(
      "Cannot send a prompt while session tree navigation is active",
    );
    await expect(service.shell(sessionRef(SESSION_ID), "!pwd")).rejects.toThrow(
      "Cannot run a shell command while session tree navigation is active",
    );
    await expect(service.setThinkingLevel(sessionRef(SESSION_ID), "off")).rejects.toThrow(
      "Cannot change the thinking level while session tree navigation is active",
    );
    const model = testModel();
    await expect(service.setModel(sessionRef(SESSION_ID), model.provider, model.id)).rejects.toThrow(
      "Cannot change models while session tree navigation is active",
    );
    await expect(service.cycleModel(sessionRef(SESSION_ID), "forward")).rejects.toThrow(
      "Cannot change models while session tree navigation is active",
    );
    await expect(service.runCommand(sessionRef(SESSION_ID), "/name blocked")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot run commands while session tree navigation is active. Stop or finish the navigation first.",
    });
    await expect(service.archive(sessionRef(SESSION_ID))).rejects.toThrow("Stop current session activity before archiving");
    expect(fake.calls.prompt).toEqual([]);

    navigation.resolve({ cancelled: false });
    await expect(firstNavigation).resolves.toEqual({ cancelled: false });
    await service.prompt(sessionRef(SESSION_ID), "now append");
    expect(fake.calls.prompt).toEqual([{ text: "now append", options: undefined }]);

    await service.dispose();
  });

  it("blocks navigation while prompt preflight can await before Pi reports streaming", async () => {
    const promptOperation = deferred<undefined>();
    const prompt = vi.fn(() => promptOperation.promise);
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service } = treeHarness({}, { prompt, navigateTree });

    await service.prompt(sessionRef(SESSION_ID), "preflight is still running");
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce(); });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    promptOperation.resolve(undefined);
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).resolves.toEqual({ cancelled: false });
    await service.dispose();
  });

  it("blocks navigation while an asynchronous model change can still append an entry", async () => {
    const modelChange = deferred<undefined>();
    const setModel = vi.fn(() => modelChange.promise);
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service } = treeHarness({}, { setModel, navigateTree });
    const model = testModel();

    const changingModel = service.setModel(sessionRef(SESSION_ID), model.provider, model.id);
    await vi.waitFor(() => { expect(setModel).toHaveBeenCalledOnce(); });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    modelChange.resolve(undefined);
    await changingModel;
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).resolves.toEqual({ cancelled: false });
    await service.dispose();
  });

  it("blocks tree navigation while clone replaces and rebinds the runtime", async () => {
    const replacement = deferred<{ cancelled: boolean; selectedText?: string }>();
    const rebound = deferred<undefined>();
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({}, { navigateTree });
    const replacementSessionId = "tree-session-replacement";
    const replacementFake = fakeRuntime(replacementSessionId, {
      sessionManager: fakeSessionManager("/workspace", {
        getSessionId: () => replacementSessionId,
        getLeafId: () => "replacement-leaf",
      }),
      navigateTree,
    });
    let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
    fake.runtime.setRebindSession = (callback) => { rebindSession = callback; };
    const fork = vi.fn(async () => {
      if (!Reflect.set(fake.runtime, "session", replacementFake.session)) throw new Error("Could not replace fake runtime session");
      await rebindSession?.(replacementFake.session);
      rebound.resolve(undefined);
      return replacement.promise;
    });
    fake.runtime.fork = fork;

    const cloning = service.runCommand(sessionRef(SESSION_ID), "/clone");
    await rebound.promise;
    await expect(service.navigateTree(sessionRef(replacementSessionId), navigationRequest({ mode: "none" }, "replacement-leaf"))).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    replacement.resolve({ cancelled: false });
    await expect(cloning).resolves.toMatchObject({ type: "done", message: "Session cloned" });
    await expect(service.navigateTree(sessionRef(replacementSessionId), navigationRequest({ mode: "none" }, "replacement-leaf"))).resolves.toEqual({ cancelled: false });
    expect(fork).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("blocks tree navigation while session resources reload", async () => {
    const reloadOperation = deferred<undefined>();
    const reload = vi.fn(() => reloadOperation.promise);
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service } = treeHarness({}, { navigateTree, reload });

    const reloading = service.runCommand(sessionRef(SESSION_ID), "/reload");
    await vi.waitFor(() => { expect(reload).toHaveBeenCalledOnce(); });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    reloadOperation.resolve(undefined);
    await expect(reloading).resolves.toMatchObject({ type: "done" });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).resolves.toEqual({ cancelled: false });
    await service.dispose();
  });

  it("blocks tree navigation while the route-level runtime reload disposes and reopens the session", async () => {
    const disposal = deferred<undefined>();
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({}, { navigateTree });
    const dispose = vi.fn(() => disposal.promise);
    fake.runtime.dispose = dispose;

    const reloading = service.reload(sessionRef(SESSION_ID));
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce(); });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    disposal.resolve(undefined);
    await reloading;
    await service.dispose();
  });

  it("blocks tree navigation throughout an asynchronous archive operation", async () => {
    const archiveOperation = deferred<{ sessionId: string; cwd: string; archivedAt: string }>();
    const archive = vi.fn(() => archiveOperation.promise);
    const archiveStore = { ...emptyArchiveStore(), archive };
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const { service } = treeHarness({}, { navigateTree }, { archiveStore });

    const archiving = service.archive(sessionRef(SESSION_ID));
    await vi.waitFor(() => { expect(archive).toHaveBeenCalledOnce(); });
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest())).rejects.toThrow(
      "Stop current session activity before navigating the session tree",
    );

    archiveOperation.resolve({ sessionId: SESSION_ID, cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z" });
    await archiving;
    await service.dispose();
  });

  it("aborts branch summarization through the existing abort path and reports cancellation", async () => {
    const navigation = deferred<Awaited<ReturnType<NavigateTree>>>();
    const navigateTree = vi.fn<NavigateTree>(() => navigation.promise);
    const abortBranchSummary = vi.fn(() => { navigation.resolve({ cancelled: true, aborted: true }); });
    const abort = vi.fn(() => Promise.resolve());
    const { service, hub } = treeHarness({}, { navigateTree, abortBranchSummary, abort });

    const navigationResult = service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "default" }));
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
    await service.abort(sessionRef(SESSION_ID));

    await expect(navigationResult).resolves.toEqual({ cancelled: true, aborted: true });
    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(abortBranchSummary.mock.invocationCallOrder[0]).toBeLessThan(abort.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(hub.sessionEvents.some(({ event }) => event.type === "activity.update" && event.activity.label === "branch summary aborted")).toBe(true);

    await service.dispose();
  });

  it("does not republish stale navigation state after stopping and disposing its runtime", async () => {
    const navigation = deferred<Awaited<ReturnType<NavigateTree>>>();
    const navigateTree = vi.fn<NavigateTree>(() => navigation.promise);
    const abortBranchSummary = vi.fn(() => { navigation.resolve({ cancelled: true, aborted: true }); });
    const { service, hub, fake } = treeHarness({}, { navigateTree, abortBranchSummary });

    const navigationResult = service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "default" }));
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
    hub.sessionEvents.length = 0;
    await service.stop(sessionRef(SESSION_ID));
    await expect(navigationResult).resolves.toEqual({ cancelled: true, aborted: true });

    expect(service.activeCount()).toBe(0);
    expect(fake.calls.dispose).toBe(1);
    expect(hub.sessionEvents).toEqual([]);
    await service.dispose();
  });

  it("still runs the normal abort and releases the gate when the branch-summary abort hook fails", async () => {
    const navigation = deferred<Awaited<ReturnType<NavigateTree>>>();
    const navigateTree = vi.fn<NavigateTree>(() => navigation.promise);
    const branchAbortFailure = new Error("branch abort hook failed");
    const abortBranchSummary = vi.fn<NonNullable<PiAgentSession["abortBranchSummary"]>>(() => { throw branchAbortFailure; });
    const abort = vi.fn(() => {
      navigation.resolve({ cancelled: true, aborted: true });
      return Promise.resolve();
    });
    const { service } = treeHarness({}, { navigateTree, abortBranchSummary, abort });

    const navigationResult = service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "default" }));
    await vi.waitFor(() => { expect(navigateTree).toHaveBeenCalledOnce(); });
    await expect(service.abort(sessionRef(SESSION_ID))).rejects.toBe(branchAbortFailure);
    await expect(navigationResult).resolves.toEqual({ cancelled: true, aborted: true });

    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    await expect(service.prompt(sessionRef(SESSION_ID), "gate released after abort failure")).resolves.toBeUndefined();
    abortBranchSummary.mockImplementation(() => undefined);
    await service.dispose();
  });

  it("releases the gate and publishes final status after navigation failure", async () => {
    const failure = new Error("summary provider failed");
    const navigateTree = vi.fn<NavigateTree>();
    navigateTree.mockRejectedValueOnce(failure).mockResolvedValueOnce({ cancelled: false });
    const { service, hub } = treeHarness({}, { navigateTree });

    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "default" }))).rejects.toBe(failure);
    await expect(service.navigateTree(sessionRef(SESSION_ID), navigationRequest({ mode: "none" }))).resolves.toEqual({ cancelled: false });

    expect(navigateTree).toHaveBeenCalledTimes(2);
    expect(hub.sessionEvents.some(({ event }) => event.type === "activity.update"
      && event.activity.phase === "error"
      && event.activity.detail === "summary provider failed")).toBe(true);
    expect(hub.sessionEvents.filter(({ event }) => event.type === "status.update").length).toBeGreaterThanOrEqual(4);

    await service.dispose();
  });
});

describe("PiSessionService session-tree fork-from-entry", () => {
  function forkRequest(entryId = "entry-1", expectedLeafId: string | null = "leaf-1") {
    return { entryId, expectedLeafId };
  }

  it("forks user entries from before and maps the forked session with its prompt draft", async () => {
    const fork = vi.fn(() => Promise.resolve({ cancelled: false, selectedText: "draft text" }));
    const { service, fake, hub } = treeHarness({}, {
      getUserMessagesForForking: () => [{ entryId: "entry-1", text: "draft text" }],
    });
    fake.runtime.fork = fork;

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).resolves.toMatchObject({
      cancelled: false,
      session: { id: SESSION_ID, cwd: "/workspace" },
      promptDraft: "draft text",
    });
    expect(fork).toHaveBeenCalledWith("entry-1", { position: "before" });
    expect(hub.sessionEvents.some(({ sessionId, event }) => sessionId === SESSION_ID
      && event.type === "activity.update"
      && event.activity.label === "forking session from entry"
      && event.activity.phase === "active")).toBe(true);
    expect(hub.sessionEvents.some(({ sessionId, event }) => sessionId === SESSION_ID
      && event.type === "activity.update"
      && event.activity.label === "session forked"
      && event.activity.phase === "idle")).toBe(true);

    await service.dispose();
  });

  it("clears superseded session and workspace activity when a changed-id fork spans a heartbeat", async () => {
    vi.useFakeTimers();
    const completeFork = deferred<undefined>();
    let service: PiSessionService | undefined;
    let forkOperation: ReturnType<PiSessionService["forkFromTree"]> | undefined;
    try {
      const workspaceActivity = new WorkspaceActivityService();
      const harness = treeHarness({}, {}, { heartbeatIntervalMs: 1_000, workspaceActivity });
      service = harness.service;
      const replacementSessionId = "tree-session-fork";
      const replacement = fakeRuntime(replacementSessionId, {
        sessionManager: fakeSessionManager("/workspace", {
          getSessionId: () => replacementSessionId,
          getLeafId: () => "fork-leaf",
        }),
      });
      const forkStarted = deferred<undefined>();
      let rebindSession: ((session: PiAgentSession) => Promise<void>) | undefined;
      harness.fake.runtime.setRebindSession = (callback) => { rebindSession = callback; };
      harness.fake.runtime.fork = vi.fn(async () => {
        forkStarted.resolve(undefined);
        await completeFork.promise;
        if (!Reflect.set(harness.fake.runtime, "session", replacement.session)) {
          throw new Error("Could not replace fake runtime session");
        }
        if (rebindSession === undefined) throw new Error("Expected runtime rebind callback");
        await rebindSession(replacement.session);
        return { cancelled: false };
      });

      forkOperation = service.forkFromTree(sessionRef(SESSION_ID), forkRequest());
      await forkStarted.promise;
      expect(workspaceActivity.snapshot().workspaces).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);

      const originalGlobalActivities = () => harness.hub.globalEvents.filter((event) => event.type === "activity.update"
        && event.activity.sessionId === SESSION_ID);
      expect(originalGlobalActivities().at(-1)).toMatchObject({
        activity: { sessionId: SESSION_ID, phase: "active" },
      });
      expect(workspaceActivity.snapshot().workspaces).toMatchObject([
        { cwd: "/workspace", hasSessionActivity: true },
      ]);

      completeFork.resolve(undefined);
      await expect(forkOperation).resolves.toMatchObject({
        cancelled: false,
        session: { id: replacementSessionId },
      });

      expect(originalGlobalActivities().at(-1)).toMatchObject({
        activity: { sessionId: SESSION_ID, phase: "idle", label: "idle" },
      });
      expect(harness.hub.sessionEvents.filter(({ sessionId, event }) => sessionId === SESSION_ID
        && event.type === "activity.update").at(-1)).toMatchObject({
        event: { activity: { sessionId: SESSION_ID, phase: "idle", label: "idle" } },
      });
      expect(workspaceActivity.snapshot().workspaces).toEqual([]);
    } finally {
      completeFork.resolve(undefined);
      await forkOperation?.catch(() => undefined);
      await service?.dispose();
      vi.useRealTimers();
    }
  });

  it("forks attachment-only user entries from before using the projected tree kind", async () => {
    const entryId = "attachment-only-user";
    const roots = [treeNode({
      type: "message",
      id: entryId,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      },
    })];
    const navigateTree = vi.fn<NavigateTree>(() => Promise.resolve({ cancelled: false }));
    const fork = vi.fn(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({
      getLeafId: () => entryId,
      getTree: () => roots,
    }, {
      navigateTree,
      getUserMessagesForForking: () => [],
    });
    fake.runtime.fork = fork;

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest(entryId, entryId))).resolves.toMatchObject({
      cancelled: false,
      session: { id: SESSION_ID },
    });
    expect(fork).toHaveBeenCalledWith(entryId, { position: "before" });

    await service.dispose();
  });

  it("forks non-user entries at the entry and omits the prompt draft", async () => {
    const fork = vi.fn(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({}, {
      getUserMessagesForForking: () => [{ entryId: "entry-1", text: "draft text" }],
    });
    fake.runtime.fork = fork;

    const result = await service.forkFromTree(sessionRef(SESSION_ID), forkRequest("entry-9"));
    expect(result).toMatchObject({ cancelled: false, session: { id: SESSION_ID } });
    expect(result).not.toHaveProperty("promptDraft");
    expect(fork).toHaveBeenCalledWith("entry-9", { position: "at" });

    await service.dispose();
  });

  it("reports cancellation without forked session metadata", async () => {
    const fork = vi.fn(() => Promise.resolve({ cancelled: true }));
    const { service, fake, hub } = treeHarness();
    fake.runtime.fork = fork;

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).resolves.toEqual({ cancelled: true });
    expect(hub.sessionEvents.some(({ sessionId, event }) => sessionId === SESSION_ID
      && event.type === "activity.update"
      && event.activity.label === "fork cancelled"
      && event.activity.phase === "idle")).toBe(true);

    await service.dispose();
  });

  it("rejects blank entries, stale leaves, active work, and archived sessions before forking", async () => {
    const fork = vi.fn(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({ getLeafId: () => "new-leaf" });
    fake.runtime.fork = fork;

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest("   ", "new-leaf"))).rejects.toThrow(
      "Session tree entry is required",
    );
    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest("entry-1", "old-leaf"))).rejects.toThrow(
      "The session changed since /tree was opened. Reopen /tree and try again.",
    );

    fake.session.isStreaming = true;
    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest("entry-1", "new-leaf"))).rejects.toThrow(
      "Stop current session activity before forking the session tree",
    );
    fake.session.isStreaming = false;

    expect(fork).not.toHaveBeenCalled();
    await service.dispose();

    const archived = treeHarness({}, {}, {
      archiveStore: {
        ...emptyArchiveStore(),
        get: () => Promise.resolve({ sessionId: SESSION_ID, cwd: "/workspace", archivedAt: "2026-01-01T00:00:00.000Z", archivePath: `/archive/${SESSION_ID}.jsonl` }),
      },
    });
    await expect(archived.service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).rejects.toThrow(
      "Archived sessions are read-only. Restore the session to continue.",
    );
    await archived.service.dispose();
  });

  it("revalidates the expected leaf after asynchronous naming and an intervening entry mutation", async () => {
    let leafId = "leaf-1";
    let promptSettled = false;
    const records = [sessionRecord(SESSION_ID)];
    const names = deferred<typeof records>();
    const gateway = sessionGateway(records);
    const list = vi.fn(() => names.promise);
    const prompt = vi.fn(async () => {
      leafId = "leaf-2";
      await Promise.resolve();
      promptSettled = true;
    });
    const fork = vi.fn(() => Promise.resolve({ cancelled: false }));
    const { service, fake } = treeHarness({ getLeafId: () => leafId }, {
      sessionName: "Named session",
      prompt,
    }, {
      sessionManager: { ...gateway, list },
    });
    fake.runtime.fork = fork;

    const forking = service.forkFromTree(sessionRef(SESSION_ID), forkRequest("entry-1", "leaf-1"));
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce(); });
    await service.prompt(sessionRef(SESSION_ID), "append while fork names are loading");
    await vi.waitFor(() => { expect(promptSettled).toBe(true); });
    await Promise.resolve();
    names.resolve(records);

    await expect(forking).rejects.toThrow("The session changed since /tree was opened. Reopen /tree and try again.");
    expect(fork).not.toHaveBeenCalled();

    await service.dispose();
  });

  it("rejects fork-from-tree while a clone replacement owns the session identity", async () => {
    const replacement = deferred<{ cancelled: boolean; selectedText?: string }>();
    const { service, fake } = treeHarness();
    const fork = vi.fn(() => replacement.promise);
    fake.runtime.fork = fork;

    const cloning = service.runCommand(sessionRef(SESSION_ID), "/clone");
    await vi.waitFor(() => { expect(fork).toHaveBeenCalledOnce(); });
    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).rejects.toThrow(
      "Stop current session activity before forking the session tree",
    );

    replacement.resolve({ cancelled: false });
    await expect(cloning).resolves.toMatchObject({ type: "done", message: "Session cloned" });
    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).resolves.toMatchObject({ cancelled: false });
    expect(fork).toHaveBeenCalledTimes(2);

    await service.dispose();
  });

  it("publishes session.error after a fork failure and allows the fork to be retried", async () => {
    const fork = vi.fn<() => Promise<{ cancelled: boolean; selectedText?: string }>>();
    fork.mockRejectedValueOnce(new Error("fork provider failed")).mockResolvedValueOnce({ cancelled: false });
    const { service, fake, hub } = treeHarness();
    fake.runtime.fork = fork;

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).rejects.toThrow("fork provider failed");
    expect(hub.sessionEvents.some(({ sessionId, event }) => sessionId === SESSION_ID
      && event.type === "session.error"
      && event.message === "fork provider failed")).toBe(true);
    expect(hub.sessionEvents.some(({ sessionId, event }) => sessionId === SESSION_ID
      && event.type === "activity.update"
      && event.activity.label === "fork failed"
      && event.activity.phase === "error")).toBe(true);

    await expect(service.forkFromTree(sessionRef(SESSION_ID), forkRequest())).resolves.toMatchObject({ cancelled: false });
    expect(fork).toHaveBeenCalledTimes(2);

    await service.dispose();
  });
});
