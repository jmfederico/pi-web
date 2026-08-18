import { describe, expect, it } from "vitest";
import type { SessionModel } from "../../shared/apiTypes";
import { detectPromptCompletionTrigger, fileCompletionInsertText, modelCompletionChoices } from "./promptCompletions";

describe("detectPromptCompletionTrigger", () => {
  it("keeps all-file suggestions active when an @ space query contains spaces", () => {
    expect(detectPromptCompletionTrigger("open @ A FILE")).toEqual({
      kind: "file",
      query: "A FILE",
      from: 5,
      to: 13,
      fileScope: "all",
      allPrefix: "@ ",
    });
  });

  it("keeps !@ all-file suggestions active when the query contains spaces", () => {
    expect(detectPromptCompletionTrigger("open !@A FILE")).toEqual({
      kind: "file",
      query: "A FILE",
      from: 5,
      to: 13,
      fileScope: "all",
      allPrefix: "!@",
    });
  });

  it("detects quoted all-file and tracked-file queries", () => {
    expect(detectPromptCompletionTrigger("open @ \"A F")).toEqual({
      kind: "file",
      query: "A F",
      from: 5,
      to: 11,
      fileScope: "all",
      allPrefix: "@ ",
      quoted: true,
    });
    expect(detectPromptCompletionTrigger("open @\"src/main")).toEqual({
      kind: "file",
      query: "src/main",
      from: 5,
      to: 15,
      fileScope: "tracked",
      quoted: true,
    });
  });

  it("detects normal tracked file and leading slash command queries", () => {
    expect(detectPromptCompletionTrigger("open @src/main")).toEqual({
      kind: "file",
      query: "src/main",
      from: 5,
      to: 14,
      fileScope: "tracked",
    });
    expect(detectPromptCompletionTrigger("/model")).toEqual({ kind: "command", query: "model", from: 0, to: 6 });
  });

  it("detects model queries for tokens starting with #", () => {
    expect(detectPromptCompletionTrigger("#")).toEqual({ kind: "model", query: "", from: 0, to: 1 });
    expect(detectPromptCompletionTrigger("use #anthropic/claude-opus")).toEqual({ kind: "model", query: "anthropic/claude-opus", from: 4, to: 26 });
  });

  it("detects model queries at any cursor position but not inside other tokens or quotes", () => {
    expect(detectPromptCompletionTrigger("use #claude now", 10)).toEqual({ kind: "model", query: "claud", from: 4, to: 10 });
    expect(detectPromptCompletionTrigger("say hello#world")).toBeUndefined();
    expect(detectPromptCompletionTrigger('say "#claude')).toBeUndefined();
  });

  it("shows model completion for a markdown header only on the bare # keystroke", () => {
    expect(detectPromptCompletionTrigger("#")).toEqual({ kind: "model", query: "", from: 0, to: 1 });
    expect(detectPromptCompletionTrigger("# ")).toBeUndefined();
    expect(detectPromptCompletionTrigger("# Title")).toBeUndefined();
  });
});

describe("modelCompletionChoices", () => {
  const models: SessionModel[] = [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
    { provider: "google", id: "gemini-3-pro" },
  ];

  it("lists all models for an empty query, mapped to #provider/id insert texts", () => {
    expect(modelCompletionChoices(models, "")).toEqual([
      { insertText: "#anthropic/claude-opus-4-5", detail: "anthropic", description: "Claude Opus 4.5" },
      { insertText: "#anthropic/claude-sonnet-4-5", detail: "anthropic", description: "Claude Sonnet 4.5" },
      { insertText: "#openai/gpt-5.2", detail: "openai", description: "GPT-5.2" },
      { insertText: "#google/gemini-3-pro", detail: "google" },
    ]);
  });

  it("filters case-insensitively across provider/id, id, and display name", () => {
    expect(modelCompletionChoices(models, "OPUS-4")).toEqual([
      { insertText: "#anthropic/claude-opus-4-5", detail: "anthropic", description: "Claude Opus 4.5" },
    ]);
    expect(modelCompletionChoices(models, "openai")).toEqual([
      { insertText: "#openai/gpt-5.2", detail: "openai", description: "GPT-5.2" },
    ]);
    expect(modelCompletionChoices(models, "sonnet 4.5")).toEqual([
      { insertText: "#anthropic/claude-sonnet-4-5", detail: "anthropic", description: "Claude Sonnet 4.5" },
    ]);
  });

  it("omits the description when the display name matches the id", () => {
    expect(modelCompletionChoices([{ provider: "ollama", id: "qwen3", name: "qwen3" }], "")).toEqual([
      { insertText: "#ollama/qwen3", detail: "ollama" },
    ]);
  });

  it("skips models without a provider or id since they cannot form a #provider/id reference", () => {
    expect(modelCompletionChoices([{ id: "orphan" }, { provider: "ghost" }, { provider: "openai", id: "gpt-5.2" }], "")).toEqual([
      { insertText: "#openai/gpt-5.2", detail: "openai" },
    ]);
  });

  it("caps the list at 12 models, preserving server order", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ provider: "p", id: `m${String(index)}` }));
    const choices = modelCompletionChoices(many, "");
    expect(choices).toHaveLength(12);
    expect(choices[0]?.insertText).toBe("#p/m0");
    expect(choices[11]?.insertText).toBe("#p/m11");
  });
});

describe("fileCompletionInsertText", () => {
  it("quotes completed file paths that contain spaces", () => {
    expect(fileCompletionInsertText("A FILE", false)).toBe('@"A FILE"');
  });

  it("preserves all-file prefixes for directories so completion can continue in that scope", () => {
    expect(fileCompletionInsertText("dir with space/", false, "@ ")).toBe('@ "dir with space/"');
    expect(fileCompletionInsertText("vendor/", false, "!@")).toBe("!@vendor/");
  });
});
