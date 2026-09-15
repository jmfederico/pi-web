import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY } from "../../server-plugin-api.js";
import type { WorkspaceListing } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { PendingExtensionDialogStore } from "../sessions/pendingExtensionDialogStore.js";
import { PiSessionService } from "../sessions/piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  runtimeCreator,
  sessionGateway,
  sessionRecord,
  testModelRuntime,
} from "../sessions/piSessionService.testSupport.js";
import { createServerPluginPiSessionsCapabilityFactory } from "./serverPluginPiSessionsCapability.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: resolve("/repo"),
  createdAt: "2026-09-10T00:00:00.000Z",
};

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function workspace(path = resolve("/repo/worktree")): WorkspaceListing {
  return {
    id: "workspace-1",
    projectId: project.id,
    path,
    label: "Worktree",
    isMain: false,
  };
}

function harness(options: {
  maxConcurrentRunsPerPlugin?: number;
  createHostedSession?: (cwd: string, signal: AbortSignal) => Promise<{ id: string }>;
  runCompletion?: (cwd: string, prompt: string, signal: AbortSignal) => Promise<void>;
  startOneShotRun?: (
    cwd: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<{ id: string; completion: Promise<void> }>;
} = {}) {
  let currentWorkspace = workspace();
  let sessionSequence = 0;
  const projects = {
    requireProject: vi.fn((projectId: string) => projectId === project.id
      ? Promise.resolve({ ...project })
      : Promise.reject(new Error("Project not found"))),
  };
  const workspaces = {
    resolve: vi.fn((selectedProject: Project, signal?: AbortSignal) => {
      void selectedProject;
      void signal;
      return Promise.resolve({
        status: "folder" as const,
        projectId: project.id,
        workspaces: [currentWorkspace],
        diagnostics: [],
      });
    }),
  };
  const runCompletion = vi.fn(options.runCompletion ?? (() => Promise.resolve()));
  const sessions = {
    createHostedSession: vi.fn(options.createHostedSession ?? (() => Promise.resolve({ id: `created-${String(++sessionSequence)}` }))),
    startOneShotRun: vi.fn(options.startOneShotRun ?? ((cwd: string, prompt: string, signal: AbortSignal) => {
      sessionSequence += 1;
      return Promise.resolve({
        id: `session-${String(sessionSequence)}`,
        completion: runCompletion(cwd, prompt, signal),
      });
    })),
    abort: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
  };
  const lifetime = new AbortController();
  const factory = createServerPluginPiSessionsCapabilityFactory({
    projects,
    workspaces,
    sessions,
    ...(options.maxConcurrentRunsPerPlugin === undefined
      ? {}
      : { maxConcurrentRunsPerPlugin: options.maxConcurrentRunsPerPlugin }),
  });
  const instance = factory.create({
    pluginId: "run-consumer",
    packageRoot: "/plugins/run-consumer",
    lifetimeSignal: lifetime.signal,
  });
  const capability = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(instance.value);
  const input = { projectId: project.id, workspaceId: currentWorkspace.id, prompt: "Do the work" };
  return {
    capability,
    factory,
    input,
    instance,
    lifetime,
    projects,
    runCompletion,
    sessions,
    workspaces,
    setWorkspace(next: WorkspaceListing) { currentWorkspace = next; },
  };
}

describe("server plugin PI sessions capability", () => {
  it("creates without prompting in current workspace authority and releases admission on publication", async () => {
    const fixture = harness({ maxConcurrentRunsPerPlugin: 1 });
    const selection = { projectId: fixture.input.projectId, workspaceId: fixture.input.workspaceId };
    const first = await fixture.capability.create(selection);
    fixture.setWorkspace(workspace(resolve("/repo/moved")));
    const second = await fixture.capability.create(selection);
    expect(first).toEqual({ sessionId: "created-1" });
    expect(second).toEqual({ sessionId: "created-2" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(fixture.sessions.createHostedSession).toHaveBeenNthCalledWith(1, resolve("/repo/worktree"), expect.any(AbortSignal));
    expect(fixture.sessions.createHostedSession).toHaveBeenNthCalledWith(2, resolve("/repo/moved"), expect.any(AbortSignal));
    expect(fixture.sessions.startOneShotRun).not.toHaveBeenCalled();
    fixture.setWorkspace({ ...workspace(), id: "stale" });
    await expect(fixture.capability.create(selection)).rejects.toThrow("stale or unavailable");
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
    await expect(fixture.capability.create(selection)).rejects.toThrow("no longer active");
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
  });

  it("shares pending creation admission with run, releases failures, and does not reclaim late publication", async () => {
    const pending = deferred<{ id: string }>();
    const fixture = harness({ maxConcurrentRunsPerPlugin: 1, createHostedSession: () => pending.promise });
    const selection = { projectId: fixture.input.projectId, workspaceId: fixture.input.workspaceId };
    const creation = fixture.capability.create(selection);
    const rejected = expect(creation).rejects.toThrow("could not create a PI session");
    await vi.waitFor(() => { expect(fixture.sessions.createHostedSession).toHaveBeenCalledOnce(); });
    await expect(fixture.capability.run(fixture.input)).rejects.toThrow("limit of 1");
    await expect(fixture.capability.create(selection)).rejects.toThrow("limit of 1");
    pending.reject(new Error("startup failed"));
    await rejected;
    await expect((await fixture.capability.run(fixture.input)).completion).resolves.toEqual({ status: "completed" });
    const late = deferred<{ id: string }>();
    fixture.sessions.createHostedSession.mockImplementation(() => late.promise);
    const lateCreation = fixture.capability.create(selection);
    const lateRejected = expect(lateCreation).rejects.toThrow("no longer active");
    await vi.waitFor(() => { expect(fixture.sessions.createHostedSession).toHaveBeenCalledTimes(2); });
    fixture.lifetime.abort();
    late.resolve({ id: "published" });
    await lateRejected;
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
  });

  it("re-resolves live workspace authority for each run and preserves transcripts while releasing admission", async () => {
    const fixture = harness({ maxConcurrentRunsPerPlugin: 1 });

    const first = await fixture.capability.run(fixture.input);
    await expect(first.completion).resolves.toEqual({ status: "completed" });
    fixture.setWorkspace(workspace(resolve("/repo/moved-worktree")));
    const second = await fixture.capability.run(fixture.input);
    await expect(second.completion).resolves.toEqual({ status: "completed" });

    expect(first.sessionId).toBe("session-1");
    expect(second.sessionId).toBe("session-2");
    expect(fixture.projects.requireProject).toHaveBeenCalledTimes(2);
    expect(fixture.workspaces.resolve).toHaveBeenCalledTimes(2);
    expect(fixture.workspaces.resolve.mock.calls.every(([, signal]) => signal === fixture.lifetime.signal)).toBe(true);
    expect(fixture.sessions.startOneShotRun).toHaveBeenNthCalledWith(
      1,
      resolve("/repo/worktree"),
      fixture.input.prompt,
      expect.any(AbortSignal),
    );
    expect(fixture.sessions.startOneShotRun).toHaveBeenNthCalledWith(
      2,
      resolve("/repo/moved-worktree"),
      fixture.input.prompt,
      expect.any(AbortSignal),
    );
    expect(fixture.runCompletion).toHaveBeenCalledTimes(2);
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(await first.completion)).toBe(true);
    expect(Object.isFrozen(fixture.factory)).toBe(true);
    expect(Object.isFrozen(fixture.instance)).toBe(true);
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
  });

  it("bounds concurrent admissions and releases the quota after completion and failure", async () => {
    const firstPrompt = deferred();
    let promptCall = 0;
    const fixture = harness({
      maxConcurrentRunsPerPlugin: 1,
      runCompletion: () => {
        promptCall += 1;
        if (promptCall === 1) return firstPrompt.promise;
        if (promptCall === 2) return Promise.reject(new Error("model unavailable"));
        return Promise.resolve();
      },
    });

    const first = await fixture.capability.run(fixture.input);
    await expect(fixture.capability.run(fixture.input))
      .rejects.toThrow("run-consumer reached its limit of 1 concurrent runs");

    firstPrompt.resolve();
    await expect(first.completion).resolves.toEqual({ status: "completed" });
    const failed = await fixture.capability.run(fixture.input);
    await expect(failed.completion).resolves.toEqual({ status: "failed", error: "model unavailable" });
    const afterFailure = await fixture.capability.run(fixture.input);
    await expect(afterFailure.completion).resolves.toEqual({ status: "completed" });

    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
  });

  it("isolates stale authority and session-start failures without consuming later admission", async () => {
    let failStart = true;
    const fixture = harness({
      maxConcurrentRunsPerPlugin: 1,
      startOneShotRun: () => failStart
        ? Promise.reject(new Error("runtime construction failed"))
        : Promise.resolve({ id: "session-recovered", completion: Promise.resolve() }),
    });

    await expect(fixture.capability.run(fixture.input))
      .rejects.toThrow("run-consumer could not start a PI session");
    failStart = false;
    fixture.setWorkspace({ ...workspace(), id: "workspace-replaced" });
    await expect(fixture.capability.run(fixture.input))
      .rejects.toThrow("run-consumer selected workspace is stale or unavailable");
    fixture.setWorkspace(workspace());
    const recovered = await fixture.capability.run(fixture.input);
    await expect(recovered.completion).resolves.toEqual({ status: "completed" });

    expect(fixture.sessions.startOneShotRun).toHaveBeenCalledTimes(2);
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
  });

  it.each(["run", "create"] as const)("settles %s cleanup when lifetime cancellation interrupts a real startup dialog", async (method) => {
    const store = new PendingExtensionDialogStore({ createDialogId: () => "startup-dialog" });
    const fake = fakeRuntime("session-1");
    const confirmAnswers: (boolean | string | undefined)[] = [];
    fake.session.bindExtensions = (bindings) => {
      fake.calls.bindExtensions.push(bindings);
      if (bindings.uiContext === undefined) return Promise.resolve();
      return bindings.uiContext.confirm("Proceed at startup?", "Really?").then((answer) => {
        confirmAnswers.push(answer);
      });
    };
    const events = new CapturingSessionEventHub();
    const sessions = new PiSessionService(events, {
      agentDir: "/tmp/pi-web-test-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime),
      pendingExtensionDialogStore: store,
      extensionDialogsTimeoutMs: 0,
      heartbeatIntervalMs: 60_000,
    });
    const lifetime = new AbortController();
    const factory = createServerPluginPiSessionsCapabilityFactory({
      projects: { requireProject: () => Promise.resolve(project) },
      workspaces: {
        resolve: () => Promise.resolve({
          status: "folder" as const,
          projectId: project.id,
          workspaces: [workspace()],
          diagnostics: [],
        }),
      },
      sessions,
    });
    const instance = factory.create({
      pluginId: "run-consumer",
      packageRoot: "/plugins/run-consumer",
      lifetimeSignal: lifetime.signal,
    });
    const capability = PI_WEB_HOST_PI_SESSIONS_CAPABILITY.parse(instance.value);
    const selection = { projectId: project.id, workspaceId: "workspace-1" };
    const running = method === "run" ? capability.run({ ...selection, prompt: "Must not start" }) : capability.create(selection);
    const rejected = expect(running).rejects.toThrow("is no longer active");
    await vi.waitFor(() => { expect(store.pendingDialogs("session-1")).toHaveLength(1); });

    lifetime.abort(new DOMException("Plugin stopped", "AbortError"));
    if (instance.dispose === undefined) throw new Error("Expected PI session capability cleanup");
    await expect(instance.dispose(AbortSignal.timeout(1_000))).resolves.toBeUndefined();
    await rejected;

    expect(store.pendingDialogs("session-1")).toEqual([]);
    expect(confirmAnswers).toEqual([false]);
    expect(fake.calls.prompt).toEqual([]);
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
    expect(sessions.activeCount()).toBe(0);
    expect(events.globalEvents.some((event) => event.type === "session.created")).toBe(false);
    await sessions.dispose();
    expect(fake.calls.abort).toBe(1);
    expect(fake.calls.dispose).toBe(1);
  });

  it("does not reclaim a published session when cancellation wins the final startup await", async () => {
    const started = deferred<{ id: string; completion: Promise<void> }>();
    const fixture = harness({ startOneShotRun: () => started.promise });

    const running = fixture.capability.run(fixture.input);
    await vi.waitFor(() => { expect(fixture.sessions.startOneShotRun).toHaveBeenCalledOnce(); });
    fixture.lifetime.abort(new DOMException("Plugin stopped", "AbortError"));
    started.resolve({ id: "session-late", completion: Promise.resolve() });

    await expect(running).rejects.toThrow("is no longer active");
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
  });

  it("reports a user-aborted initial submission as cancelled without stopping its conversation", async () => {
    const fixture = harness({ runCompletion: () => Promise.reject(new DOMException("User stopped", "AbortError")) });
    const run = await fixture.capability.run(fixture.input);
    await expect(run.completion).resolves.toEqual({ status: "cancelled" });
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
  });

  it("leaves later user work running when initial completion settles and the plugin is disposed", async () => {
    const initial = deferred();
    const later = deferred();
    const laterStarted = deferred();
    const dialogs = new PendingExtensionDialogStore({ createDialogId: () => "later-dialog" });
    const fake = fakeRuntime("session-1", {
      prompt: (text) => {
        if (text === "initial") return initial.promise;
        laterStarted.resolve();
        return later.promise;
      },
    });
    const sessions = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([]), archiveStore: emptyArchiveStore(),
      createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
      pendingExtensionDialogStore: dialogs, extensionDialogsTimeoutMs: 0,
    });
    const lifetime = new AbortController();
    const instance = createServerPluginPiSessionsCapabilityFactory({
      projects: { requireProject: () => Promise.resolve(project) },
      workspaces: { resolve: () => Promise.resolve({ status: "folder", projectId: project.id, workspaces: [workspace("/workspace")], diagnostics: [] }) },
      sessions,
    }).create({ pluginId: "run-consumer", packageRoot: "/plugins/run-consumer", lifetimeSignal: lifetime.signal });
    try {
      const run = await instance.value.run({ projectId: project.id, workspaceId: "workspace-1", prompt: "initial" });
      fake.emit({ type: "agent_settled" });
      await sessions.prompt({ id: run.sessionId, cwd: "/workspace" }, "later user work");
      await laterStarted.promise;
      initial.resolve();
      await expect(run.completion).resolves.toEqual({ status: "completed" });
      lifetime.abort();
      await instance.dispose?.(AbortSignal.timeout(1_000));
      expect(sessions.activeCount()).toBe(1);
      expect(fake.calls.abort).toBe(0);
      expect(fake.calls.dispose).toBe(0);
      expect(fake.calls.clearQueue).toBe(0);
      const ui = fake.calls.bindExtensions[0]?.uiContext;
      if (ui === undefined) throw new Error("Expected bound extension UI");
      // Startup's UI context must not retain the revoked plugin signal.
      const answer = ui.confirm("Later user work", "Continue?");
      expect(dialogs.pendingDialogs(run.sessionId)).toHaveLength(1);
      await sessions.dispose();
      await expect(answer).resolves.toBe(false);
    } finally {
      initial.resolve();
      later.resolve();
      await sessions.dispose();
    }
  });

  it("revokes new admissions without aborting or waiting for published work", async () => {
    const prompt = deferred();
    const fixture = harness({ runCompletion: () => prompt.promise });
    const run = await fixture.capability.run(fixture.input);
    fixture.lifetime.abort(new DOMException("Plugin lifetime ended", "AbortError"));

    await fixture.instance.dispose?.(AbortSignal.timeout(1_000));
    await expect(fixture.capability.run(fixture.input))
      .rejects.toThrow("run-consumer is no longer active");
    expect(fixture.sessions.abort).not.toHaveBeenCalled();
    expect(fixture.sessions.stop).not.toHaveBeenCalled();
    prompt.resolve();
    await expect(run.completion).resolves.toEqual({ status: "completed" });
  });
});
