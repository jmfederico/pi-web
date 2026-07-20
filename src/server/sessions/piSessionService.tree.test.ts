import { describe, expect, it, vi } from "vitest";
import type { SessionTreeNavigateRequest, SessionTreeSummaryChoice } from "../../shared/apiTypes.js";
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
    sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
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
