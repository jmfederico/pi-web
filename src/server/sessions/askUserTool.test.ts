import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { AskUserValidationError } from "./askUserDomain.js";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

function testTool() {
  let next = 0;
  const createAskId = vi.fn(() => `ask-${(++next).toString()}`);
  const tool = createAskUserToolDefinition({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createAskId,
  });
  return { tool, createAskId };
}

const twoQuestions = {
  questions: [
    { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] },
    { id: "why", question: "Why?", options: [] },
  ],
};

const ctx = stubExtensionToolContext();

describe("createAskUserToolDefinition", () => {
  it("registers ask_user as model-only", () => {
    const { tool } = testTool();
    expect(tool.name).toBe("ask_user");
    expect(tool.exposure).toBe("model-only");
  });

  it("bounds the question set in its parameter schema", () => {
    const { tool } = testTool();
    expect(tool.parameters).toMatchObject({
      type: "object", required: ["questions"],
      properties: { questions: { type: "array", minItems: 1, maxItems: 20 } },
    });
  });

  it("returns the complete durable request and terminates without registering a session", async () => {
    const { tool } = testTool();
    const getSessionId = vi.fn(() => { throw new Error("The tool must not register runtime state"); });
    const result = await tool.execute("call-1", twoQuestions, undefined, undefined, stubExtensionToolContext({
      sessionManager: { getSessionId, getSessionFile: () => undefined },
    }));

    expect(getSessionId).not.toHaveBeenCalled();
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ interventionRequired: true, ask: {
      askId: "ask-1", askedAt: "2026-02-01T10:00:00.000Z", questions: twoQuestions.questions,
    } });
    expect(firstText(result.content)).toBe("Posted 2 questions to the user as ask ask-1. Ending this run; the answers arrive as a follow-up message that wakes you, naming every question the user left unanswered. Do not repost these questions.");
  });

  it("defaults omitted options to an empty list for free-text questions", async () => {
    const { tool } = testTool();
    const result = await tool.execute("call-free", { questions: [{ id: "note", question: "Anything else?" }] }, undefined, undefined, ctx);
    expect(result.details.ask.questions).toEqual([{ id: "note", question: "Anything else?", options: [] }]);
  });

  it("preserves question and option detail and multi-select", async () => {
    const { tool } = testTool();
    const rich = [{
      id: "targets", question: "Which targets?", detail: "Pick every platform we should build for.",
      options: [{ value: "web", label: "Web", detail: "Chromium and Firefox" }, { value: "cli", label: "CLI" }], multiple: true,
    }];
    const result = await tool.execute("call-rich", { questions: rich }, undefined, undefined, ctx);
    expect(result.details.ask.questions).toEqual(rich);
  });

  it("builds independent results without superseding prior questions", async () => {
    const { tool } = testTool();
    const first = await tool.execute("call-first", twoQuestions, undefined, undefined, ctx);
    const second = await tool.execute("call-second", { questions: [{ id: "again", question: "Still there?" }] }, undefined, undefined, ctx);
    expect(second.details).toEqual({ interventionRequired: true, ask: {
      askId: "ask-2", askedAt: "2026-02-01T10:00:00.000Z", questions: [{ id: "again", question: "Still there?", options: [] }],
    } });
    expect(first.details).toMatchObject({ ask: { askId: "ask-1" } });
    expect(firstText(second.content)).not.toContain("replaced");
  });

  it("validates before allocating a successful request or terminating", async () => {
    const { tool, createAskId } = testTool();
    await expect(tool.execute("call-dup", {
      questions: [{ id: "same", question: "First?" }, { id: "same", question: "Second?" }],
    }, undefined, undefined, ctx)).rejects.toThrow(AskUserValidationError);
    expect(createAskId).not.toHaveBeenCalled();
  });
});
