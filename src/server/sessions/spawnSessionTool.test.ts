import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSpawnSessionToolDefinition } from "./spawnSessionTool.js";

const dispatchModel = { provider: "anthropic", id: "claude-sonnet" };

function ctxFor(sessionId: string, model?: unknown, thinkingLevel?: string): ExtensionContext {
  const sessionManager = { getSessionId: () => sessionId };
  // The spawn tool only reads sessionManager.getSessionId, model, and thinkingLevel.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tool reads.
  return { sessionManager, ...(model === undefined ? {} : { model }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }) } as unknown as ExtensionContext;
}

describe("createSpawnSessionToolDefinition", () => {
  it("passes the spawning identity, explicit cwd, dispatching model, thinking level, and prompt to spawn callback", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "new-1", cwd: "/repos/a-feature" }));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    const result = await tool.execute("call-1", { prompt: "do the thing", cwd: "/repos/a-feature" }, undefined, undefined, ctxFor("spawner-1", dispatchModel, "high"));

    expect(spawn).toHaveBeenCalledWith({ spawningCwd: "/repos/a", spawningSessionId: "spawner-1", prompt: "do the thing", cwd: "/repos/a-feature", model: dispatchModel, thinkingLevel: "high" });
    expect(result.details).toEqual({ sessionId: "new-1", cwd: "/repos/a-feature" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "Started independent session new-1 in /repos/a-feature." });
  });

  it("describes a fully independent session and restricts it to explicit requests", () => {
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn: vi.fn() });

    expect(tool.description).toBe("Start a fully independent session; its transcript and results are unavailable here. Use only when the user or active workflow explicitly requests a separate session.");
    expect(tool.promptSnippet).toBe("spawn_session: independent session; results unavailable here; explicit requests only");
    expect(tool.description).not.toMatch(/subsession|child|parent/i);
  });

  it("forwards omitted cwd as undefined and omits a missing dispatching model and thinking level", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "new-2", cwd: "/repos/a" }));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    await tool.execute("call-2", { prompt: "continue" }, undefined, undefined, ctxFor("spawner-1"));

    expect(spawn).toHaveBeenCalledWith({ spawningCwd: "/repos/a", spawningSessionId: "spawner-1", prompt: "continue", cwd: undefined });
  });

  it("forwards an explicit model as a model spec alongside the inherited model", async () => {
    const spawn = vi.fn(() => Promise.resolve({ sessionId: "new-3", cwd: "/repos/a", model: "openai/gpt-5" }));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    const result = await tool.execute("call-3", { prompt: "continue", model: "openai/gpt-5" }, undefined, undefined, ctxFor("spawner-1", dispatchModel));

    expect(spawn).toHaveBeenCalledWith({
      spawningCwd: "/repos/a",
      spawningSessionId: "spawner-1",
      prompt: "continue",
      cwd: undefined,
      model: dispatchModel,
      modelSpec: "openai/gpt-5",
    });
    expect(result.details).toEqual({ sessionId: "new-3", cwd: "/repos/a", model: "openai/gpt-5" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "Started independent session new-3 in /repos/a using model openai/gpt-5." });
  });

  it("teaches the model parameter format and the #provider/model-id reference convention", () => {
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn: vi.fn() });

    expect(tool.parameters).toMatchObject({
      properties: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- stringMatching yields `any` against the loosely typed tool schema.
        model: { description: expect.stringMatching(/provider\/model-id.*#provider\/model-id.*Omit to inherit/s) },
      },
    });
  });

  it("propagates the spawn callback error so the agent loop reports it", async () => {
    const spawn = vi.fn(() => Promise.reject(new Error("cwd must be a workspace of this project. Allowed: /repos/a")));
    const tool = createSpawnSessionToolDefinition("/repos/a", { spawn });

    await expect(tool.execute("call-4", { prompt: "x", cwd: "/elsewhere" }, undefined, undefined, ctxFor("spawner-1")))
      .rejects.toThrow("cwd must be a workspace of this project. Allowed: /repos/a");
  });
});
