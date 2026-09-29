import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createSubsessionToolDefinitions, type SubsessionSummary, type SubsessionToolDeps } from "./spawnSubsessionTool.js";

const model: Model<Api> = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function extensionContext(): ExtensionContext {
  const sessionManager = {
    getSessionId: () => "parent-1",
    getSessionFile: () => "/sessions/parent-1.jsonl",
  };
  // The wrapped yield definition only reads the two session-manager methods above.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- minimal integration boundary for a Pi tool definition.
  return { sessionManager } as unknown as ExtensionContext;
}

function wrapDefinition(definition: ToolDefinition, ctx: ExtensionContext): AgentTool {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    execute: (toolCallId, params, signal, onUpdate) => definition.execute(toolCallId, params, signal, onUpdate, ctx),
  };
}

function isLlmMessage(agentMessage: AgentMessage): agentMessage is Message {
  return agentMessage.role === "user" || agentMessage.role === "assistant" || agentMessage.role === "toolResult";
}

function message(stopReason: "stop" | "toolUse", content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function streamSequence(messages: AssistantMessage[]): StreamFn {
  let index = 0;
  return vi.fn(() => {
    const next = messages[index];
    index += 1;
    if (next === undefined) throw new Error("unexpected provider invocation");
    if (next.stopReason !== "stop" && next.stopReason !== "toolUse" && next.stopReason !== "length") {
      throw new Error(`unsupported fake stop reason ${next.stopReason}`);
    }
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: next.stopReason, message: next });
    stream.end(next);
    return stream;
  });
}

async function runYieldBatch(subsessions: SubsessionSummary[], includeSentinel = false) {
  const list = vi.fn(() => Promise.resolve(subsessions));
  const deps: SubsessionToolDeps = {
    spawn: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace" })),
    list,
    check: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, finalText: "", messageCount: 0 })),
    read: vi.fn(() => Promise.resolve({ sessionId: "child-1", cwd: "/workspace", status: "idle" as const, entries: [], total: 0, matched: 0, start: 0, hasMore: false })),
  };
  const yieldDefinition = createSubsessionToolDefinitions("/workspace", deps)
    .find(({ name }) => name === "yield_to_subsessions");
  if (yieldDefinition === undefined) throw new Error("missing yield_to_subsessions");

  const sentinel = vi.fn(() => Promise.resolve({ content: [{ type: "text" as const, text: "sentinel complete" }], details: {} }));
  const sentinelTool: AgentTool = {
    name: "sentinel",
    label: "Sentinel",
    description: "Return normally.",
    parameters: Type.Object({}),
    execute: sentinel,
  };
  const firstContent: AssistantMessage["content"] = [
    { type: "toolCall", id: "yield-call", name: "yield_to_subsessions", arguments: {} },
    ...(includeSentinel
      ? [{ type: "toolCall" as const, id: "sentinel-call", name: "sentinel", arguments: {} }]
      : []),
  ];
  const streamFn = streamSequence([
    message("toolUse", firstContent),
    message("stop", [{ type: "text", text: "normal follow-up" }]),
  ]);
  const events: AgentEvent[] = [];

  const messages = await runAgentLoop(
    [{ role: "user", content: "join now", timestamp: 0 }],
    {
      messages: [],
      tools: [wrapDefinition(yieldDefinition, extensionContext()), sentinelTool],
    },
    { model, convertToLlm: (agentMessages) => agentMessages.filter(isLlmMessage) },
    (event) => { events.push(event); },
    undefined,
    streamFn,
  );

  return { events, list, messages, sentinel, streamFn };
}

describe("yield_to_subsessions Pi agent-loop integration", () => {
  it("ends the run after one provider call when invoked alone with a working child", async () => {
    const result = await runYieldBatch([
      { sessionId: "child-1", cwd: "/workspace", status: "working" },
    ]);

    expect(result.streamFn).toHaveBeenCalledTimes(1);
    expect(result.list).toHaveBeenCalledWith("parent-1", "/sessions/parent-1.jsonl");
    expect(result.events.slice(-2).map(({ type }) => type)).toEqual(["turn_end", "agent_end"]);
    expect(result.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "yield_to_subsessions" });
  });

  it("makes a normal follow-up provider call when no child is working", async () => {
    const result = await runYieldBatch([]);

    expect(result.streamFn).toHaveBeenCalledTimes(2);
    expect(result.events.filter(({ type }) => type === "turn_start")).toHaveLength(2);
    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "normal follow-up" }],
    });
  });

  it("does not terminate a mixed batch with a non-terminating sibling tool", async () => {
    const result = await runYieldBatch([
      { sessionId: "child-1", cwd: "/workspace", status: "working" },
    ], true);

    expect(result.sentinel).toHaveBeenCalledTimes(1);
    expect(result.streamFn).toHaveBeenCalledTimes(2);
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant" });
  });
});
