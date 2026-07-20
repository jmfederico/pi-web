import { describe, expect, it, vi } from "vitest";
import type { SessionUiEvent } from "../../shared/apiTypes.js";
import { SessionCommandService, type CommandActiveSession, type CommandSession } from "./sessionCommandService.js";

interface TestCommandSession extends CommandSession {
  sessionName: string | undefined;
}

function activeSession(overrides: Partial<TestCommandSession> = {}): CommandActiveSession<TestCommandSession> {
  const session: TestCommandSession = {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    sessionName: undefined,
    messages: [{}, {}],
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    pendingMessageCount: 0,
    promptTemplates: [{ name: "template" }],
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: "ext" }] },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "skill-a" }] }) },
    sessionManager: { getLeafId: () => "leaf-1" },
    setSessionName: vi.fn((name: string) => { session.sessionName = name; }),
    compact: vi.fn(async () => {
      await Promise.resolve();
      return { summary: "short summary", tokensBefore: 123 };
    }),
    getSessionStats: vi.fn(() => ({
      sessionId: "s1",
      totalMessages: 2,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 3,
      tokens: { input: 10, output: 5, total: 15 },
      cost: 0.12345,
    })),
    getUserMessagesForForking: vi.fn(() => [{ entryId: "m1", text: "hello ".repeat(40) }]),
    ...overrides,
  };
  return { runtime: { cwd: "/work", session, fork: vi.fn(() => Promise.resolve({ cancelled: false })) } };
}

async function getActive(active: CommandActiveSession<TestCommandSession>): Promise<CommandActiveSession> {
  await Promise.resolve();
  return active;
}

async function promptAccepted(): Promise<void> {
  await Promise.resolve();
}

function eventPublisher() {
  return { publish: vi.fn<(sessionId: string, event: SessionUiEvent) => void>() };
}

describe("SessionCommandService", () => {
  it("rejects unknown commands and forwards runtime commands as prompts", async () => {
    const active = activeSession();
    const prompt = vi.fn(promptAccepted);
    const service = new SessionCommandService(() => getActive(active), prompt, eventPublisher());

    await expect(service.run("s1", "/missing")).resolves.toEqual({ type: "unsupported", message: "Unknown command: /missing" });
    // Forwarded runtime commands return a bare done result: the agent streams
    // back the canonical expanded message, so no synthetic "Accepted" line.
    await expect(service.run("s1", "/ext arg")).resolves.toEqual({ type: "done" });
    await expect(service.run("s1", "/template arg")).resolves.toMatchObject({ type: "done" });
    await expect(service.run("s1", "/skill:skill-a arg")).resolves.toMatchObject({ type: "done" });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(prompt).toHaveBeenNthCalledWith(1, "s1", "/ext arg");
    expect(prompt).toHaveBeenNthCalledWith(2, "s1", "/template arg");
    expect(prompt).toHaveBeenNthCalledWith(3, "s1", "/skill:skill-a arg");
  });

  it("renames sessions, publishes the name update, and returns updated client session metadata", async () => {
    const active = activeSession();
    const events = eventPublisher();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), events);

    await expect(service.run("s1", "/name Useful name")).resolves.toMatchObject({
      type: "done",
      message: "Session named: Useful name",
      session: { id: "s1", cwd: "/work", name: "Useful name", messageCount: 2 },
    });
    expect(active.runtime.session.setSessionName).toHaveBeenCalledWith("Useful name");
    expect(events.publish).toHaveBeenCalledWith("s1", { type: "session.name", sessionId: "s1", name: "Useful name" });
  });

  it("formats session stats", async () => {
    const active = activeSession();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    await expect(service.run("s1", "/session")).resolves.toEqual({
      type: "done",
      message: "Session: s1\nMessages: 2 (1 user, 1 assistant)\nTool calls: 3\nTokens: ↑10 ↓5 total 15\nCost: $0.1235",
    });
  });

  it("starts compaction, updates lifecycle hooks, and publishes completion", async () => {
    const active = activeSession();
    const events = eventPublisher();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), events, { onCompactionStart, onCompactionEnd });

    await expect(service.run("s1", "/compact focus on tests")).resolves.toEqual({ type: "done", message: "Compaction started…" });
    expect(onCompactionStart).toHaveBeenCalledWith(active.runtime.session);
    await vi.waitFor(() => {
      expect(events.publish).toHaveBeenCalledWith("s1", {
        type: "command.output",
        level: "success",
        message: "Compaction complete.\nTokens before: 123\n\nshort summary",
      });
      expect(onCompactionEnd).toHaveBeenCalledWith(active.runtime.session, "success");
    });
    expect(active.runtime.session.compact).toHaveBeenCalledWith("focus on tests");
  });

  it("reloads runtime resources through the injected lifecycle callback", async () => {
    const active = activeSession();
    const reloadSession = vi.fn(async () => { await Promise.resolve(); });
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), { reloadSession });

    await expect(service.run("s1", "/reload")).resolves.toEqual({
      type: "done",
      message: "Session runtime resources reloaded. Extensions, skills, prompt templates, themes, and context/system prompt files are refreshed for this session. Reload the browser page separately for PI WEB browser plugin changes.",
    });
    expect(reloadSession).toHaveBeenCalledWith(active.runtime.session);
  });

  it("rejects runtime reload while the session has active work", async () => {
    const active = activeSession({ isBashRunning: true });
    const reloadSession = vi.fn(async () => { await Promise.resolve(); });
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), { reloadSession });

    await expect(service.run("s1", "/reload")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot reload while the session is active. Stop current activity before reloading.",
    });
    expect(reloadSession).not.toHaveBeenCalled();
  });

  it("returns an injected full tree snapshot for /tree without creating a select request", async () => {
    const active = activeSession();
    const tree = {
      nodes: [{ id: "root", parentId: null, kind: "user" as const, summary: "hello" }],
      activeLeafId: "root",
      activePathIds: ["root"],
    };
    const getSessionTree = vi.fn(() => tree);
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), { getSessionTree });

    await expect(service.run("s1", "/tree")).resolves.toEqual({ type: "tree", tree });
    expect(getSessionTree).toHaveBeenCalledWith(active.runtime.session);
    expect(active.runtime.fork).not.toHaveBeenCalled();
  });

  it("rejects /tree for active, empty, and unavailable runtimes", async () => {
    const active = activeSession();
    let externallyActive = true;
    const getSessionTree = vi.fn(() => ({ nodes: [], activeLeafId: null, activePathIds: [] }));
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), {
      getSessionTree,
      hasActiveWork: () => externallyActive,
    });

    await expect(service.run("s1", "/tree")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot open the session tree while the session is active. Stop current activity and try /tree again.",
    });
    expect(getSessionTree).not.toHaveBeenCalled();

    externallyActive = false;
    await expect(service.run("s1", "/tree")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot navigate an empty session tree.",
    });

    const unavailable = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());
    await expect(unavailable.run("s1", "/tree")).resolves.toEqual({
      type: "unsupported",
      message: "Session tree navigation is not available with this Pi runtime.",
    });
  });

  it("blocks commands and pending command responses while a tree navigation owns the session gate", async () => {
    const active = activeSession();
    let navigationActive = false;
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), {
      isTreeNavigationActive: () => navigationActive,
    });
    const pendingFork = await service.run("s1", "/fork");
    if (pendingFork.type !== "select") throw new Error("Expected select result");
    navigationActive = true;

    await expect(service.run("s1", "/name changed")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot run commands while session tree navigation is active. Stop or finish the navigation first.",
    });
    await expect(service.respond("s1", pendingFork.requestId, "m1")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot run commands while session tree navigation is active. Stop or finish the navigation first.",
    });
    expect(active.runtime.session.setSessionName).not.toHaveBeenCalled();
    expect(active.runtime.fork).not.toHaveBeenCalled();
  });

  it("creates fork selection requests from newest message to oldest and responds with selected entry", async () => {
    const active = activeSession({
      getUserMessagesForForking: vi.fn(() => [
        { entryId: "oldest", text: "oldest message" },
        { entryId: "middle", text: "middle message" },
        { entryId: "newest", text: "newest message" },
      ]),
    });
    vi.mocked(active.runtime.fork).mockResolvedValueOnce({ cancelled: false, selectedText: "newest message" });
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    const result = await service.run("s1", "/fork");

    expect(result).toMatchObject({ type: "select", title: "Fork from message", options: [{ value: "newest" }, { value: "middle" }, { value: "oldest" }] });
    if (result.type !== "select") throw new Error("Expected select result");
    await expect(service.respond("s1", result.requestId, "newest")).resolves.toMatchObject({ type: "done", message: "Session forked", session: { id: "s1" }, promptDraft: "newest message" });
    expect(active.runtime.fork).toHaveBeenCalledWith("newest");
    await expect(service.respond("s1", result.requestId, "newest")).resolves.toEqual({ type: "unsupported", message: "Command request expired" });
  });

  it("names forked sessions from the source title with the next available counter", async () => {
    const active = activeSession({ sessionName: "Build auth" });
    const forked = activeSession({ sessionId: "forked", sessionName: undefined }).runtime.session;
    vi.mocked(active.runtime.fork).mockImplementationOnce(() => {
      active.runtime.session = forked;
      return Promise.resolve({ cancelled: false, selectedText: "newest message" });
    });
    const events = eventPublisher();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), events, {}, {
      listSessionNames: () => Promise.resolve(["Build auth", "Build auth — Fork 1"]),
    });

    const result = await service.run("s1", "/fork");
    if (result.type !== "select") throw new Error("Expected select result");
    await expect(service.respond("s1", result.requestId, "newest")).resolves.toMatchObject({
      type: "done",
      message: "Session forked",
      session: { id: "forked", name: "Build auth — Fork 2" },
    });
    expect(forked.setSessionName).toHaveBeenCalledWith("Build auth — Fork 2");
    expect(events.publish).toHaveBeenCalledWith("forked", { type: "session.name", sessionId: "forked", name: "Build auth — Fork 2" });
  });

  it("names cloned sessions as copies of the source title", async () => {
    const active = activeSession({ sessionName: "Build auth — Fork 1" });
    const cloned = activeSession({ sessionId: "copy", sessionName: undefined }).runtime.session;
    vi.mocked(active.runtime.fork).mockImplementationOnce(() => {
      active.runtime.session = cloned;
      return Promise.resolve({ cancelled: false });
    });
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), {}, {
      listSessionNames: () => Promise.resolve(["Build auth", "Build auth — Copy 1"]),
    });

    await expect(service.run("s1", "/clone")).resolves.toMatchObject({
      type: "done",
      message: "Session cloned",
      session: { id: "copy", name: "Build auth — Copy 2" },
    });
    expect(active.runtime.fork).toHaveBeenCalledWith("leaf-1", { position: "at" });
    expect(cloned.setSessionName).toHaveBeenCalledWith("Build auth — Copy 2");
  });

  it("does not start a clone if tree navigation takes the gate during async name lookup", async () => {
    const active = activeSession();
    const names = deferred<readonly string[]>();
    const listSessionNames = vi.fn(() => names.promise);
    let navigationActive = false;
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), {
      isTreeNavigationActive: () => navigationActive,
    }, { listSessionNames });

    const clone = service.run("s1", "/clone");
    await vi.waitFor(() => { expect(listSessionNames).toHaveBeenCalledOnce(); });
    navigationActive = true;
    names.resolve([]);

    await expect(clone).resolves.toEqual({
      type: "unsupported",
      message: "Cannot run commands while session tree navigation is active. Stop or finish the navigation first.",
    });
    expect(active.runtime.fork).not.toHaveBeenCalled();
  });

  it("clones the leaf that is current after asynchronous name lookup", async () => {
    let leafId = "leaf-before-navigation";
    const active = activeSession({ sessionManager: { getLeafId: () => leafId } });
    const names = deferred<readonly string[]>();
    const listSessionNames = vi.fn(() => names.promise);
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher(), {}, { listSessionNames });

    const clone = service.run("s1", "/clone");
    await vi.waitFor(() => { expect(listSessionNames).toHaveBeenCalledOnce(); });
    leafId = "leaf-after-navigation";
    names.resolve([]);

    await expect(clone).resolves.toMatchObject({ type: "done", message: "Session cloned" });
    expect(active.runtime.fork).toHaveBeenCalledWith("leaf-after-navigation", { position: "at" });
  });

  it("rejects fork and clone while the session has active work", async () => {
    const active = activeSession({ isStreaming: true });
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    await expect(service.run("s1", "/fork")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot fork while the session is active. Stop current activity before forking.",
    });
    await expect(service.run("s1", "/clone")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot clone while the session is active. Stop current activity before cloning.",
    });
    expect(active.runtime.fork).not.toHaveBeenCalled();
  });

  it("rejects fork responses if the session becomes active after choosing fork", async () => {
    const active = activeSession();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    const result = await service.run("s1", "/fork");
    if (result.type !== "select") throw new Error("Expected select result");
    active.runtime.session.isStreaming = true;

    await expect(service.respond("s1", result.requestId, "m1")).resolves.toEqual({
      type: "unsupported",
      message: "Cannot fork while the session is active. Stop current activity before forking.",
    });
    expect(active.runtime.fork).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
