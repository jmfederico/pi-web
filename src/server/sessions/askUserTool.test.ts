import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createAskUserToolDefinition, type AskUserInvocation } from "./askUserTool.js";
import { PendingAskStore, PendingAskValidationError } from "./pendingAskStore.js";

function ctxFor(sessionId: string): ExtensionContext {
  const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => undefined };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test stub with the minimal surface the tool uses.
  return { sessionManager } as unknown as ExtensionContext;
}

function firstText(content: readonly (TextContent | ImageContent)[]): string {
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

/** The tool over a real store, so the schema and the store's contract stay aligned. */
function toolOverStore(askIds: string[] = ["ask-1", "ask-2"]) {
  const remaining = [...askIds];
  const store = new PendingAskStore({
    now: () => new Date("2026-02-01T10:00:00.000Z"),
    createAskId: () => remaining.shift() ?? "ask-exhausted",
  });
  const open = vi.fn((input: AskUserInvocation) => Promise.resolve(store.open(input)));
  return { store, open, tool: createAskUserToolDefinition({ open }) };
}

const twoQuestions = {
  questions: [
    { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] },
    { id: "why", question: "Why?", options: [] },
  ],
};

describe("createAskUserToolDefinition", () => {
  it("advertises a non-blocking question set whose answers arrive as a follow-up", () => {
    const { tool } = toolOverStore();

    expect(tool.name).toBe("ask_user");
    expect(tool.description).toBe("Post a set of questions to the user as a browser form and end this run. Answers arrive later as a follow-up message; the user may leave any question unanswered.");
    expect(tool.promptSnippet).toBe("ask_user: post a question set to the user; ends the run, answers return as a follow-up");
    expect(tool.promptGuidelines).toEqual([
      "When you need decisions from the user, post them together with ask_user instead of asking in prose one at a time. It ends the run and the answers, including the questions the user left unanswered, come back as a follow-up message that wakes you. Call it alone and last, and do not repost the same questions or poll for answers.",
    ]);
  });

  it("bounds the question set in its parameter schema", () => {
    const { tool } = toolOverStore();

    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["questions"],
      properties: { questions: { type: "array", minItems: 1, maxItems: 20 } },
    });
    expect(tool.parameters).not.toHaveProperty("properties.questions.items.properties.allowOther");
  });

  it("opens the ask for the calling session and terminates the run instead of awaiting the user", async () => {
    const { open, tool } = toolOverStore();

    const result = await tool.execute("call-1", twoQuestions, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      questions: [
        { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "sqlite", label: "SQLite" }] },
        { id: "why", question: "Why?", options: [] },
      ],
    });
    expect(result.terminate).toBe(true);
    expect(result.details).toMatchObject({ ask: { askId: "ask-1", questions: [{ id: "db" }, { id: "why" }] } });
    expect(firstText(result.content)).toBe("Posted 2 questions to the user as ask ask-1. Ending this run; the answers arrive as a follow-up message that wakes you, naming every question the user left unanswered. Do not repost these questions.");
  });

  it("defaults a question without options to an empty option list so free text alone is expressible", async () => {
    const { open, tool } = toolOverStore();

    await tool.execute("call-free", { questions: [{ id: "note", question: "Anything else?" }] }, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      questions: [{ id: "note", question: "Anything else?", options: [] }],
    });
  });

  it("adds custom answers while preserving detail, option detail, and multi-select", async () => {
    const { open, tool } = toolOverStore();

    await tool.execute("call-rich", {
      questions: [{
        id: "targets",
        question: "Which targets?",
        detail: "Pick every platform we should build for.",
        options: [{ value: "web", label: "Web", detail: "Chromium and Firefox" }, { value: "cli", label: "CLI" }],
        multiple: true,
      }],
    }, undefined, undefined, ctxFor("session-1"));

    expect(open).toHaveBeenCalledWith({
      sessionId: "session-1",
      questions: [{
        id: "targets",
        question: "Which targets?",
        detail: "Pick every platform we should build for.",
        options: [{ value: "web", label: "Web", detail: "Chromium and Firefox" }, { value: "cli", label: "CLI" }],
        multiple: true,
      }],
    });
  });

  it("tells the model which questions the superseded ask left unanswered", async () => {
    const { tool } = toolOverStore();
    await tool.execute("call-first", twoQuestions, undefined, undefined, ctxFor("session-1"));

    const result = await tool.execute("call-second", { questions: [{ id: "again", question: "Still there?", options: [{ value: "yes", label: "Yes" }] }] }, undefined, undefined, ctxFor("session-1"));

    expect(result.terminate).toBe(true);
    expect(firstText(result.content)).toContain("Posted 1 question to the user as ask ask-2.");
    expect(firstText(result.content)).toContain("This replaced an earlier question set (ask-1) that the user never submitted.");
    expect(firstText(result.content)).toContain("Left unanswered: db, why.");
    expect(result.details).toMatchObject({ superseded: { askId: "ask-1", reason: "superseded", unansweredIds: ["db", "why"] } });
  });

  it("says nothing about superseding when no earlier ask was open", async () => {
    const { tool } = toolOverStore();

    const result = await tool.execute("call-only", twoQuestions, undefined, undefined, ctxFor("session-1"));

    expect(firstText(result.content)).not.toContain("replaced an earlier question set");
    expect(result.details).not.toHaveProperty("superseded");
  });

  it("propagates a rejected question set so the agent loop reports it to the model", async () => {
    const { tool } = toolOverStore();

    await expect(tool.execute("call-dup", {
      questions: [
        { id: "same", question: "First?", options: [{ value: "a", label: "A" }] },
        { id: "same", question: "Second?", options: [{ value: "b", label: "B" }] },
      ],
    }, undefined, undefined, ctxFor("session-1"))).rejects.toThrow(PendingAskValidationError);
  });
});
