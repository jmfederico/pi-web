import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, sessionFile: string | undefined, model?: unknown): ExtensionContext {
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => sessionFile };
  // The subsession tools only read sessionManager.getSessionId/getSessionFile and model.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tools use.
  return { sessionManager, ...(model === undefined ? {} : { model }) } as unknown as ExtensionContext;
}

function tools(deps: Partial<SubsessionToolDeps>) {
  const full: SubsessionToolDeps = {
    spawn: deps.spawn ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a" })),
    list: deps.list ?? vi.fn(() => Promise.resolve([])),
    check: deps.check ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: deps.read ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  const definitions = createSubsessionToolDefinitions("/repos/a", full);
  const find = (name: string) => {
    const tool = definitions.find((definition) => definition.name === name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    return tool;
  };
  return { spawn: find("spawn_subsession"), list: find("list_subsessions"), check: find("check_subsession"), read: find("read_subsession") };
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

describe("createSubsessionToolDefinitions", () => {
  it("spawn_subsession forwards parent identity and params from the live context", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a-feature" }));
    const { spawn: spawnTool } = tools({ spawn });

    const result = await spawnTool.execute("call-1", { prompt: "do it", cwd: "/repos/a-feature" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl", dispatchModel));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "do it",
      cwd: "/repos/a-feature",
      model: dispatchModel,
    });
    expect(result.details).toEqual({ sessionId: "child-1", cwd: "/repos/a-feature" });
    expect(firstText(result.content)).toContain("Started tracked subsession child-1");
  });

  it("guides the parent to join all required subsessions without polling", async () => {
    const { spawn: spawnTool } = tools({
      spawn: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a-feature" })),
    });

    expect(spawnTool.description).toBe("Start a tracked child and return after dispatch. Track required children as pending: continue independent work, then yield at a join point until all have notified completion. Notifications queue while the parent is busy; do not poll for completion.");
    expect(spawnTool.promptSnippet).toBe("spawn_subsession: delegate parallel work; yield at a join point until all required children complete.");

    const result = await spawnTool.execute("call-contract", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));
    expect(firstText(result.content)).toBe("Started tracked subsession child-1 in /repos/a-feature. Track it as pending and, before finalizing dependent work, yield until all required children have notified completion.");
  });

  it("keeps subsession inspection tool descriptions capability-oriented", () => {
    const definitions = tools({});

    expect(definitions.list.description).toBe("List tracked child sessions owned by the calling session, with each child's current status (working, idle, error, or unknown).");
    expect(definitions.check.description).toBe("Return a tracked subsession's current status, message count, and most recent assistant output.");
    expect(definitions.read.description).toBe("Return a filtered, paginated transcript of a tracked subsession. Filters select message roles and content kinds, search full message content, optionally include raw tool arguments, and cap or page the returned entries.");
    for (const definition of [definitions.list, definitions.check, definitions.read]) {
      expect(definition.description).not.toMatch(/use this|do not poll|continue working|start narrow|for just the final|relay/i);
    }
  });

  it("spawn_subsession omits the inherited model when the dispatching session has no current model", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-2", cwd: "/repos/a" }));
    const { spawn: spawnTool } = tools({ spawn });

    await spawnTool.execute("call-modeless", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: undefined,
      prompt: "do it",
      cwd: undefined,
    });
  });

  it("list_subsessions reports the caller's subsessions and their status", async () => {
    const list = vi.fn(() => Promise.resolve([
      { sessionId: "child-1", cwd: "/repos/a", status: "working" as const },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" as const },
    ]));
    const { list: listTool } = tools({ list });

    const result = await listTool.execute("call-2", {}, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(list).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl");
    expect(result.details).toEqual({ subsessions: [
      { sessionId: "child-1", cwd: "/repos/a", status: "working" },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" },
    ] });
    expect(firstText(result.content)).toContain("child-1 [working]");
  });

  it("list_subsessions reports an empty state", async () => {
    const { list: listTool } = tools({ list: vi.fn(() => Promise.resolve([])) });
    const result = await listTool.execute("call-3", {}, undefined, undefined, ctxFor("parent-1", undefined));
    expect(result.content[0]).toMatchObject({ type: "text", text: "No tracked subsessions." });
  });

  it("check_subsession scopes by parent and returns the final result", async () => {
    const check = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "idle" as const, finalText: "all done", messageCount: 4 }));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-4", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", status: "idle", finalText: "all done" });
    expect(firstText(result.content)).toContain("all done");
  });

  it("check_subsession propagates scope errors so the agent loop reports them", async () => {
    const check = vi.fn(() => Promise.reject(new Error("Session child-9 is not one of your subsessions")));
    const { check: checkTool } = tools({ check });

    await expect(checkTool.execute("call-5", { sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toThrow("not one of your subsessions");
  });

  it("read_subsession forwards filter params and renders the transcript", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [{ index: 2, role: "assistant" as const, parts: [{ kind: "text" as const, text: "the answer" }] }],
      total: 5, matched: 1, start: 2, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-6", { sessionId: "child-1", roles: ["assistant"], maxChars: 200 }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", { roles: ["assistant"], maxChars: 200 }, "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", matched: 1 });
    expect(firstText(result.content)).toContain("the answer");
  });

  it("read_subsession renders raw tool-call args and the truncation marker in the model-facing text", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [{
        index: 1, role: "assistant" as const, parts: [
          { kind: "tool_call" as const, toolName: "bash", summary: "ls", args: { command: "ls -la" } },
          { kind: "text" as const, text: "clipped", truncated: { shown: 7, full: 50 } },
        ],
      }],
      total: 3, matched: 1, start: 1, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-7", { sessionId: "child-1", includeToolArgs: true }, undefined, undefined, ctxFor("parent-1", undefined));
    const text = firstText(result.content);
    expect(text).toContain("command"); // raw args surfaced in text, not only details
    expect(text).toContain("ls -la");
    expect(text).toContain("[+43 chars truncated"); // 50 - 7
  });

  it("read_subsession distinguishes an empty page-window from a zero-match result", async () => {
    const read = vi.fn(() => Promise.resolve({
      sessionId: "child-1", cwd: "/repos/a", status: "idle" as const,
      entries: [], total: 5, matched: 4, start: 0, hasMore: false,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-8", { sessionId: "child-1", before: 0 }, undefined, undefined, ctxFor("parent-1", undefined));
    const text = firstText(result.content);
    expect(text).toContain("4 matched"); // not "nothing matched"
    expect(text).not.toContain("nothing matched");
  });

  it("read_subsession propagates scope errors so the agent loop reports them", async () => {
    const read = vi.fn(() => Promise.reject(new Error("Session child-9 is not one of your subsessions")));
    const { read: readTool } = tools({ read });

    await expect(readTool.execute("call-9", { sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toThrow("not one of your subsessions");
  });
});
