import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { ExtensionToolContext } from "../../piSdk.js";
import { describe, expect, it, vi } from "vitest";
import { Check } from "pi-web-typebox/value";
import { KNOWN_THINKING_LEVELS } from "../../shared/thinkingLevels.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";
import { createSubsessionToolDefinitions, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, sessionFile: string | undefined, model?: unknown, thinkingLevel?: string): ExtensionToolContext {
  // The subsession tools only read sessionManager.getSessionId/getSessionFile, model, and thinkingLevel.
  return stubExtensionToolContext({
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
    model,
    thinkingLevel,
  });
}

function tools(deps: Partial<SubsessionToolDeps>) {
  const list = deps.list ?? vi.fn(() => Promise.resolve([]));
  const full: SubsessionToolDeps = {
    spawn: deps.spawn ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a" })),
    archive: deps.archive ?? vi.fn(() => Promise.resolve()),
    stop: deps.stop ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "idle" as const })),
    resume: deps.resume ?? vi.fn(() => Promise.resolve({ sessionId: "x", cwd: "/repos/a", status: "working" as const })),
    list,
    join: deps.join ?? (async (parentId, parentFile) => ({ subsessions: await list(parentId, parentFile), completions: [] })),
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
    manage: find("manage_subsession"),
    yield: find("yield_to_subsessions"),
  };
}

function workingGuidance(sessionId: string): string {
  return `Subsession ${sessionId} is working; partial output is withheld. Continue other work, or call yield_to_subsessions alone and last at the join point. Lifecycle notices wake you; do not poll.`;
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

describe("createSubsessionToolDefinitions", () => {
  it("archives using the live parent identity without accepting a caller-supplied parent", async () => {
    const archive = vi.fn(() => Promise.resolve());
    const result = await tools({ archive }).manage.execute("archive-1", { action: "archive", sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));
    expect(archive).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(result.details).toEqual({ sessionId: "child-1", archived: true });
  });

  it("reports archive failure rather than claiming success", async () => {
    const archive = vi.fn(() => Promise.reject(new Error("Stop current session activity before archiving")));
    await expect(tools({ archive }).manage.execute("archive-1", { action: "archive", sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", undefined))).rejects.toThrow("Stop current session activity before archiving");
  });
  it("keeps run-ending yield model-only while other subsession tools remain callable", () => {
    const definitions = tools({});
    expect(definitions.yield.exposure).toBe("model-only");
    for (const name of ["spawn", "list", "check", "read", "manage"] as const) {
      expect(definitions[name].exposure ?? "direct").toBe("direct");
    }
  });
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

    expect(spawnTool.description).toContain("Automatic notices report only that it became idle or errored");
    expect(spawnTool.description).toContain("check_subsession or read_subsession");
    expect(spawnTool.description).toContain("send_session_message");
    expect(spawnTool.description).not.toMatch(/spawn_session|fully independent/i);

    const result = await spawnTool.execute("call-contract", { prompt: "do it" }, undefined, undefined, ctxFor("parent-1", undefined));
    expect(firstText(result.content)).toBe("Started tracked subsession child-1 in /repos/a. Continue other work, then join with yield_to_subsessions; do not poll.");
  });

  it("distinguishes status inspection from yielding in tool metadata", () => {
    const definitions = tools({});

    expect(definitions.list.description).toBe("List tracked child statuses. Never yields or changes control flow; do not poll.");
    expect(definitions.list.promptSnippet).toBe("list_subsessions: inspect child statuses; never yields");
    expect(definitions.check.description).toContain("Inspecting idle/error output acknowledges its lifecycle notice");
    expect(definitions.check.promptSnippet).toBe("check_subsession: inspect child status and available output; never yields");
    expect(definitions.read.description).toContain("Returning its complete latest final output acknowledges its lifecycle notice; filtered or historical-only reads do not.");
    expect(definitions.read.promptSnippet).toBe("read_subsession: inspect an available child transcript; never yields");
  });

  it("registers the parameterless yield action with terminal-batch guidance", () => {
    const { yield: yieldTool } = tools({});

    expect(yieldTool.parameters).toMatchObject({ type: "object", properties: {} });
    expect(yieldTool.description).toContain("without output or task-completion claims");
    expect(yieldTool.description).toContain("If none are ready but children are working, end this run");
    expect(yieldTool.promptSnippet).toContain("collect lifecycle notices");
    expect(yieldTool.promptGuidelines?.join(" ")).toContain("call yield_to_subsessions alone and last");
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

  it("spawn_subsession restricts model overrides to instructions without priming a concrete model", () => {
    const { spawn: spawnTool } = tools({});

    expect(spawnTool.parameters).toMatchObject({
      properties: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- stringMatching yields `any` against the loosely typed tool schema.
        model: { description: expect.stringMatching(/provider\/model-id.*only when instructed.*specific model.*choose an appropriate one.*omit it to inherit.*unknown value is rejected/si) },
      },
    });
    expect(JSON.stringify(spawnTool.parameters)).not.toContain("anthropic/claude-sonnet-4-5");
  });

  it("serializes optional thinking levels as an explicitly typed string enum for providers", () => {
    const { spawn: tool } = tools({});
    const schema: unknown = JSON.parse(JSON.stringify(tool.parameters));

    expect(schema).toMatchObject({ properties: { thinkingLevel: {
      type: "string",
      enum: [...KNOWN_THINKING_LEVELS],
    } } });
    expect(schema).toHaveProperty("required", ["prompt"]);
  });

  it.each(KNOWN_THINKING_LEVELS)("spawn_subsession overrides inherited thinking with %s without changing the parent", async (thinkingLevel) => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "child", cwd: "/repos/a" }));
    const { spawn: tool } = tools({ spawn });
    const ctx = ctxFor("parent", undefined, dispatchModel, "high");
    const params = { prompt: "work", model: "openai/gpt-5", thinkingLevel };

    expect(Check(tool.parameters, params)).toBe(true);
    await tool.execute("call", params, undefined, undefined, ctx);

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ thinkingLevel, modelSpec: "openai/gpt-5" }));
    expect(ctx.thinkingLevel).toBe("high");
  });

  it("spawn_subsession makes thinking overrides instruction-only and rejects invalid levels in the tool schema", () => {
    const { spawn: tool } = tools({});
    expect(tool.parameters).toMatchObject({ properties: { thinkingLevel: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher against the tool schema.
      description: expect.stringMatching(/only when instructed.*specific thinking level.*choose an appropriate one.*omit it to inherit.*clamped/),
    } } });
    expect(Check(tool.parameters, { prompt: "work" })).toBe(true);
    for (const thinkingLevel of ["unknown", "", null, 1]) {
      expect(Check(tool.parameters, { prompt: "work", thinkingLevel })).toBe(false);
    }
  });

  it("requires a closed action and child target without exposing parent identity", () => {
    const { manage } = tools({});
    expect(manage.parameters).not.toHaveProperty(["properties", "parentSessionId"]);
    expect(manage.parameters).not.toHaveProperty(["properties", "parentSessionFile"]);
    for (const action of ["stop", "resume", "archive"]) {
      expect(Check(manage.parameters, { action, sessionId: "child-1" })).toBe(true);
    }
    for (const params of [{}, { sessionId: "child-1" }, { action: "stop" }, { action: "delete", sessionId: "child-1" }, { action: "resume", sessionId: "child-1", prompt: 1 }]) {
      expect(Check(manage.parameters, params)).toBe(false);
    }
    expect(Check(manage.parameters, { action: "resume", sessionId: "child-1", prompt: "continue" })).toBe(true);
  });

  it.each(["stop", "archive"] as const)("rejects prompt with %s before dispatching any action", async (action) => {
    const stop = vi.fn<SubsessionToolDeps["stop"]>();
    const resume = vi.fn<SubsessionToolDeps["resume"]>();
    const archive = vi.fn<SubsessionToolDeps["archive"]>();
    await expect(tools({ stop, resume, archive }).manage.execute("invalid", { action, sessionId: "child-1", prompt: "must not apply" }, undefined, undefined, ctxFor("parent-1", undefined))).rejects.toThrow("prompt is only supported with the resume action");
    expect(stop).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("manage_subsession stop takes parent identity from each live context and returns the summary without yielding", async () => {
    const summary = { sessionId: "child-1", cwd: "/repos/a", status: "idle" as const };
    const stop = vi.fn<SubsessionToolDeps["stop"]>(() => Promise.resolve(summary));
    const { manage: tool } = tools({ stop });
    const params = { action: "stop" as const, sessionId: "child-1", parentSessionId: "forged", parentSessionFile: "/forged.jsonl" };

    const result = await tool.execute("stop-1", params, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));
    await tool.execute("stop-2", params, undefined, undefined, ctxFor("parent-2", undefined));

    expect(stop).toHaveBeenNthCalledWith(1, "parent-1", "child-1", "/sessions/parent-1.jsonl");
    expect(stop).toHaveBeenNthCalledWith(2, "parent-2", "child-1", undefined);
    expect(result.details).toEqual(summary);
    expect(firstText(result.content)).toContain("child-1 [idle]");
    expect(result.terminate).toBeUndefined();
  });

  it.each([undefined, "Continue with the review"])("manage_subsession resume forwards prompt %s in the existing child scope", async (prompt) => {
    const summary = { sessionId: "child-1", cwd: "/repos/a", status: "working" as const };
    const resume = vi.fn<SubsessionToolDeps["resume"]>(() => Promise.resolve(summary));
    const { manage: tool } = tools({ resume });
    const params = {
      action: "resume" as const,
      sessionId: "child-1",
      ...(prompt === undefined ? {} : { prompt }),
      parentSessionId: "forged",
      parentSessionFile: "/forged.jsonl",
    };

    const result = await tool.execute("resume-1", params, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));
    await tool.execute("resume-2", params, undefined, undefined, ctxFor("parent-2", undefined));

    expect(resume).toHaveBeenNthCalledWith(1, "parent-1", "child-1", prompt, "/sessions/parent-1.jsonl");
    expect(resume).toHaveBeenNthCalledWith(2, "parent-2", "child-1", prompt, undefined);
    expect(result.details).toEqual(summary);
    expect(firstText(result.content)).toContain("child-1 [working]");
    expect(result.terminate).toBeUndefined();
  });

  it.each(["stop", "resume", "archive"] as const)("manage_subsession %s propagates direct-child authorization errors", async (action) => {
    const error = new Error("Session child-9 is not one of your direct subsessions");
    const reject = vi.fn(() => Promise.reject(error));
    const tool = tools({ [action]: reject }).manage;

    await expect(tool.execute("control", { action, sessionId: "child-9" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toBe(error);
  });

  it("manage_subsession resume propagates an already-running rejection without reporting success", async () => {
    const error = new Error("Subsession child-1 is already running");
    const { manage: tool } = tools({ resume: vi.fn(() => Promise.reject(error)) });

    await expect(tool.execute("resume", { action: "resume", sessionId: "child-1", prompt: "continue" }, undefined, undefined, ctxFor("parent-1", undefined)))
      .rejects.toBe(error);
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
    expect(result.details).toEqual({ subsessions: subsessions.map(({ sessionId, status }) => ({ sessionId, status })), completions: [] });
    expect(firstText(result.content)).toBe("Working: child-1, child-3. Ending this run; a new lifecycle notice will wake you.");
    expect(result.terminate).toBe(true);
  });

  it.each(["idle", "error"] as const)("yield_to_subsessions reports only %s lifecycle facts while another child works", async (status) => {
    const completion = { completionId: "run-1", sessionId: "child-1", cwd: "/repos/a", status, finalText: "Ready answer", messageCount: 3, errorDetail: "Private provider detail" };
    const join = vi.fn(() => Promise.resolve({
      subsessions: [{ sessionId: "child-1", cwd: "/repos/a", status }, { sessionId: "child-2", cwd: "/repos/a", status: "working" as const }],
      completions: [completion],
    }));
    const { yield: yieldTool } = tools({ join });
    const result = await yieldTool.execute("ready", {}, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));
    expect(join).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl", "ready");
    expect(firstText(result.content)).toContain(status === "idle" ? "Subsession child-1 is now idle." : "Subsession child-1 stopped with error.");
    expect(JSON.stringify(result)).not.toContain("Ready answer");
    expect(JSON.stringify(result)).not.toContain("Private provider detail");
    expect(firstText(result.content)).toContain("Still working: child-2");
    expect(result.details).toEqual({
      subsessions: [{ sessionId: "child-1", status }, { sessionId: "child-2", status: "working" }],
      completions: [{ completionId: "run-1", sessionId: "child-1", status }],
    });
    expect(result.terminate).toBeUndefined();
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

    expect(result.details).toEqual({ subsessions: subsessions.map(({ sessionId, status }) => ({ sessionId, status })), completions: [] });
    expect(firstText(result.content)).toBe("No unread child lifecycle notices; no tracked subsessions are working. Continuing.");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession scopes by parent and returns the final result", async () => {
    const check = vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/repos/a", status: "idle" as const, finalText: "all done", messageCount: 4 }));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-4", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl", "call-4");
    expect(result.details).toMatchObject({ sessionId: "child-1", status: "idle", finalText: "all done" });
    expect(firstText(result.content)).toBe("Subsession child-1 [idle].\n\n--- SUBSESSION OUTPUT: child-1 ---\nall done");
    expect(result.terminate).toBeUndefined();
  });

  it("check_subsession withholds partial working output without yielding", async () => {
    const partial = { sessionId: "child-1", cwd: "/repos/a", status: "working" as const, finalText: "SECRET PARTIAL OUTPUT", messageCount: 4 };
    const check = vi.fn(() => Promise.resolve(partial));
    const { check: checkTool } = tools({ check });

    const result = await checkTool.execute("call-working-check", { sessionId: "child-1" }, undefined, undefined, ctxFor("parent-1", "/sessions/parent-1.jsonl"));

    expect(check).toHaveBeenCalledWith("parent-1", "child-1", "/sessions/parent-1.jsonl", "call-working-check");
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

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", { roles: ["assistant"], maxChars: 200, limit: 1 }, "/sessions/parent-1.jsonl", "call-6");
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

    expect(read).toHaveBeenCalledWith("parent-1", "child-1", {}, "/sessions/parent-1.jsonl", "call-working-read");
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
