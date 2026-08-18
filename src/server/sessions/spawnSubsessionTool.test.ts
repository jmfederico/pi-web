import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, sessionFile: string | undefined, model?: unknown, thinkingLevel?: string): ExtensionContext {
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => sessionFile };
  // The subsession tools only read sessionManager.getSessionId/getSessionFile, model, and thinkingLevel.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tools use.
  return { sessionManager, ...(model === undefined ? {} : { model }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } as unknown as ExtensionContext;
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
  return {
    spawn: find("spawn_subsession"),
    list: find("list_subsessions"),
    check: find("check_subsession"),
    read: find("read_subsession"),
    yield: find("yield_to_subsessions"),
  };
}

function workingGuidance(sessionId: string): string {
  return `Subsession ${sessionId} is working; partial output is withheld. Continue other work, or call yield_to_subsessions alone and last at the join point. Completion notices wake you; do not poll.`;
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

describe("createSubsessionToolDefinitions", () => {
  it("spawn_subsession forwards parent identity and params from the live context", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a" }));
    const { spawn: spawnTool } = tools({ spawn });

    const result = await spawnTool.execute("call-1", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl", dispatchModel, "max"));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "do it",
      model: dispatchModel,
      thinkingLevel: "max",
    });
    expect(result.details).toEqual({ sessionId: "child-1", cwd: "/repos/a" });
    expect(firstText(result.content)).toContain("Started tracked subsession child-1");
  });

  it("spawn_subsession offers no way to target another workspace", () => {
    const { spawn: spawnTool } = tools({});

    expect(spawnTool.parameters).toMatchObject({ type: "object", properties: { prompt: {}, model: {} } });
    expect(spawnTool.parameters).not.toHaveProperty(["properties", "cwd"]);
    expect(spawnTool.description).toContain("in this session's working directory");
  });

  it("describes tracked child work whose result remains available to the parent", async () => {
    const { spawn: spawnTool } = tools({
      spawn: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a" })),
    });

    expect(spawnTool.description).toBe("Start a tracked child session in this session's working directory to carry out part of the current task and return immediately. Its transcript and result are available here after it finishes.");
    expect(spawnTool.promptSnippet).toBe("spawn_subsession: tracked child work in this workspace; result available after completion");
    expect(spawnTool.description).not.toMatch(/spawn_session|fully independent/i);

    const result = await spawnTool.execute("call-contract", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));
    expect(firstText(result.content)).toBe("Started tracked subsession child-1 in /repos/a. Continue other work, then join with yield_to_subsessions; do not poll.");
  });

  it("distinguishes status inspection from yielding in tool metadata", () => {
    const definitions = tools({});

    expect(definitions.list.description).toBe("List tracked child statuses. Never yields or changes control flow; do not poll.");
    expect(definitions.list.promptSnippet).toBe("list_subsessions: inspect child statuses; never yields");
    expect(definitions.check.description).toBe("Get a tracked child's status and latest output. Working output is withheld. Never yields; do not poll.");
    expect(definitions.check.promptSnippet).toBe("check_subsession: inspect child status and available output; never yields");
    expect(definitions.read.description).toBe("Read a tracked child's filtered transcript. Working transcripts are withheld. Never yields; do not poll.");
    expect(definitions.read.promptSnippet).toBe("read_subsession: inspect an available child transcript; never yields");
  });

  it("registers the parameterless yield action with terminal-batch guidance", () => {
    const { yield: yieldTool } = tools({});

    expect(yieldTool.parameters).toMatchObject({ type: "object", properties: {} });
    expect(yieldTool.description).toBe("At a join point, end this run while tracked children work; completion notices wake you. If none work, continue. Call alone and last; do not poll.");
    expect(yieldTool.promptSnippet).toBe("yield_to_subsessions: end the run at a join point; call alone and last");
    expect(yieldTool.promptGuidelines).toEqual([
      "After calling spawn_subsession, you can continue with other work. At the join point, call yield_to_subsessions alone and last; completion notices wake you, so do not poll.",
    ]);
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
    });
  });

  it("spawn_subsession forwards an explicit model as a model spec and names the model used", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child-3", cwd: "/repos/a", model: "openai/gpt-5" }));
    const { spawn: spawnTool } = tools({ spawn });

    const result = await spawnTool.execute("call-model", { prompt: "do it", model: "openai/gpt-5" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl", dispatchModel));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      parentSessionId: "parent-1",
      parentSessionFile: "/sessions/parent-1.jsonl",
      prompt: "do it",
      model: dispatchModel,
      modelSpec: "openai/gpt-5",
    });
    expect(result.details).toEqual({ sessionId: "child-3", cwd: "/repos/a", model: "openai/gpt-5" });
    expect(firstText(result.content)).toBe("Started tracked subsession child-3 in /repos/a using model openai/gpt-5. Continue other work, then join with yield_to_subsessions; do not poll.");
  });

  it("spawn_subsession teaches the model parameter format and the #provider/model-id reference convention", () => {
    const { spawn: spawnTool } = tools({});

    expect(spawnTool.parameters).toMatchObject({
      properties: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- stringMatching yields `any` against the loosely typed tool schema.
        model: { description: expect.stringMatching(/provider\/model-id.*#provider\/model-id.*Omit to inherit/s) },
      },
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
    expect(result.terminate).toBeUndefined();
  });

  it("list_subsessions reports an empty state", async () => {
    const { list: listTool } = tools({ list: vi.fn(() => Promise.resolve([])) });
    const result = await listTool.execute("call-3", {}, undefined, undefined, ctxFor("parent-1", undefined));
    expect(result.content[0]).toMatchObject({ type: "text", text: "No tracked subsessions." });
    expect(result.terminate).toBeUndefined();
  });

  it("yield_to_subsessions terminates when tracked children are working", async () => {
    const subsessions = [
      { sessionId: "child-1", cwd: "/repos/a", status: "working" as const },
      { sessionId: "child-2", cwd: "/repos/a", status: "idle" as const },
      { sessionId: "child-3", cwd: "/repos/a", status: "working" as const },
    ];
    const list = vi.fn(() => Promise.resolve(subsessions));
    const { yield: yieldTool } = tools({ list });

    const result = await yieldTool.execute("call-yield", {}, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(list).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl");
    expect(result.details).toEqual({ subsessions });
    expect(firstText(result.content)).toBe("Working: child-1, child-3. Ending this run; completion notices will wake you.");
    expect(result.terminate).toBe(true);
  });

  it.each([
    { label: "an empty list", subsessions: [] },
    {
      label: "only non-working children",
      subsessions: [
        { sessionId: "child-idle", cwd: "/repos/a", status: "idle" as const },
        { sessionId: "child-error", cwd: "/repos/a", status: "error" as const },
        { sessionId: "child-unknown", cwd: "/repos/a", status: "unknown" as const },
      ],
    },
  ])("yield_to_subsessions remains active with $label", async ({ subsessions }) => {
    const { yield: yieldTool } = tools({ list: vi.fn(() => Promise.resolve(subsessions)) });

    const result = await yieldTool.execute("call-no-yield", {}, undefined, undefined, ctxFor("parent-1", undefined));

    expect(result.details).toEqual({ subsessions });
    expect(firstText(result.content)).toBe("No tracked subsessions are working; continuing.");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession scopes by parent and returns the final result", async () => {
    const check = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "idle" as const, finalText: "all done", messageCount: 4 }));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-4", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", status: "idle", finalText: "all done" });
    expect(firstText(result.content)).toBe("Subsession child-1 [idle].\n\n--- SUBSESSION OUTPUT: child-1 ---\nall done");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession withholds partial working output without yielding", async () => {
    const partial = { sessionId: "child-1", cwd: "/repos/a", status: "working" as const, finalText: "SECRET PARTIAL OUTPUT", messageCount: 4 };
    const check = vi.fn(() => Promise.resolve(partial));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-working-check", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(firstText(result.content)).toBe(workingGuidance("child-1"));
    expect(firstText(result.content)).not.toContain("SECRET PARTIAL OUTPUT");
    expect(result.details).toEqual(partial);
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession preserves non-working error output without yielding", async () => {
    const { check: checkTool } = tools({
      check: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "error" as const, finalText: "child failed", messageCount: 3 })),
    });

    const result = await checkTool.execute("call-error-check", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", undefined));

    expect(firstText(result.content)).toBe("Subsession child-1 [error].\n\n--- SUBSESSION OUTPUT: child-1 ---\nchild failed");
    expect(result.terminate).toBeUndefined();
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
      total: 5, matched: 2, start: 2, hasMore: true,
    }));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-6", { sessionId: "child-1", roles: ["assistant"], maxChars: 200, limit: 1 }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", { roles: ["assistant"], maxChars: 200, limit: 1 }, "/sessions/parent-1.jsonl");
    expect(result.details).toMatchObject({ sessionId: "child-1", matched: 2 });
    expect(firstText(result.content)).toBe("Subsession child-1 [idle] — messages 2–2 of 5 (2 matched). Earlier matching messages exist before index 2.\n\n--- SUBSESSION TRANSCRIPT: child-1 ---\n#2 assistant\nthe answer");
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession withholds partial working transcripts without yielding", async () => {
    const partial = {
      sessionId: "child-1", cwd: "/repos/a", status: "working" as const,
      entries: [{ index: 2, role: "assistant" as const, parts: [{ kind: "text" as const, text: "SECRET TRANSCRIPT ENTRY" }] }],
      total: 3, matched: 1, start: 2, hasMore: false,
    };
    const read = vi.fn(() => Promise.resolve(partial));
    const { read: readTool } = tools({ read });

    const result = await readTool.execute("call-working-read", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", {}, "/sessions/parent-1.jsonl");
    expect(firstText(result.content)).toBe(workingGuidance("child-1"));
    expect(firstText(result.content)).not.toContain("SECRET TRANSCRIPT ENTRY");
    expect(result.details).toEqual(partial);
    expect(result.terminate).toBeUndefined();
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
    expect(result.terminate).toBeUndefined();
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
    expect(result.terminate).toBeUndefined();
  });

  it("read_subsession propagates scope errors so the agent loop reports them", async () => {
    const read = vi.fn(() => Promise.reject(new Error("Session child-9 is not one of your subsessions")));
    const { read: readTool } = tools({ read });

    await expect(readTool.execute("call-9", { sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toThrow("not one of your subsessions");
  });
});
