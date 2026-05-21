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
    await expect(service.run("s1", "/ext arg")).resolves.toEqual({ type: "done", message: "Accepted /ext arg" });
    await expect(service.run("s1", "/template arg")).resolves.toMatchObject({ type: "done" });
    await expect(service.run("s1", "/skill:skill-a arg")).resolves.toMatchObject({ type: "done" });
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("renames sessions and returns updated client session metadata", async () => {
    const active = activeSession();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    await expect(service.run("s1", "/name Useful name")).resolves.toMatchObject({
      type: "done",
      message: "Session named: Useful name",
      session: { id: "s1", cwd: "/work", name: "Useful name", messageCount: 2 },
    });
    expect(active.runtime.session.setSessionName).toHaveBeenCalledWith("Useful name");
  });

  it("formats session stats", async () => {
    const active = activeSession();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), eventPublisher());

    await expect(service.run("s1", "/session")).resolves.toEqual({
      type: "done",
      message: "Session: s1\nMessages: 2 (1 user, 1 assistant)\nTool calls: 3\nTokens: ↑10 ↓5 total 15\nCost: $0.1235",
    });
  });

  it("starts compaction and publishes completion", async () => {
    const active = activeSession();
    const events = eventPublisher();
    const service = new SessionCommandService(() => getActive(active), vi.fn(), events);

    await expect(service.run("s1", "/compact focus on tests")).resolves.toEqual({ type: "done", message: "Compaction started…" });
    await vi.waitFor(() => {
      expect(events.publish).toHaveBeenCalledWith("s1", {
        type: "command.output",
        level: "success",
        message: "Compaction complete.\nTokens before: 123\n\nshort summary",
      });
    });
    expect(active.runtime.session.compact).toHaveBeenCalledWith("focus on tests");
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
