import { describe, expect, it } from "vitest";
import { fuzzyScore, fuzzySearch } from "./fuzzySearch";

describe("fuzzyScore", () => {
  it("returns 0 for empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("returns 0 when query cannot be matched", () => {
    expect(fuzzyScore("xyz", "abc")).toBe(0);
    expect(fuzzyScore("zz", "abc")).toBe(0);
  });

  it("returns positive score for exact match", () => {
    expect(fuzzyScore("claude", "claude")).toBeGreaterThan(0);
  });

  it("returns positive score for substring match", () => {
    expect(fuzzyScore("son", "claude-sonnet")).toBeGreaterThan(0);
  });

  it("returns positive score for fuzzy (non-contiguous) match", () => {
    // "clson" → c l a u d e - s o n n e t: all chars match in order
    expect(fuzzyScore("clson", "claude-sonnet")).toBeGreaterThan(0);
  });

  it("returns 0 when fuzzy order is wrong", () => {
    expect(fuzzyScore("soncl", "claude-sonnet")).toBe(0);
  });

  it("is case-insensitive", () => {
    const lower = fuzzyScore("claude", "Claude-Sonnet");
    const upper = fuzzyScore("CLAUDE", "claude-sonnet");
    expect(lower).toBe(upper);
    expect(lower).toBeGreaterThan(0);
  });

  it("strips spaces from query", () => {
    // "cl son" → "clson" → matches "claude-sonnet"
    expect(fuzzyScore("cl son", "claude-sonnet")).toBeGreaterThan(0);
    // "gpt 4o" → "gpt4o" → matches "gpt-4o"
    expect(fuzzyScore("gpt 4o", "gpt-4o")).toBeGreaterThan(0);
  });

  it("scores consecutive matches higher than scattered matches", () => {
    // "clau" is a consecutive prefix of "claude" → high score
    const consecutiveScore = fuzzyScore("clau", "claude-sonnet");
    // "cl s" matches c(0)l(1)+gap, then s(7) → lower score
    const scatteredScore = fuzzyScore("cl s", "claude-sonnet");
    expect(consecutiveScore).toBeGreaterThan(scatteredScore);
  });
});

describe("fuzzySearch", () => {
  it("returns all targets when query is empty", () => {
    const results = fuzzySearch("", [
      { text: "a", item: 1 },
      { text: "b", item: 2 },
    ]);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.item)).toEqual([1, 2]);
  });

  it("returns only matching targets", () => {
    const results = fuzzySearch("son", [
      { text: "claude-sonnet", item: "sonnet" },
      { text: "gpt-4o", item: "gpt" },
    ]);
    expect(results.map((r) => r.item)).toEqual(["sonnet"]);
  });

  it("sorts by score descending", () => {
    const results = fuzzySearch("clau", [
      { text: "gpt-4 claude", item: "gpt-with-claude" }, // "clau" is scattered
      { text: "claude-sonnet", item: "claude-sonnet" },  // "clau" is consecutive prefix
    ]);
    // Higher score first: consecutive prefix match wins
    expect(results.map((r) => r.item)).toEqual(["claude-sonnet", "gpt-with-claude"]);
  });

  it("handles model-name scenarios realistically", () => {
    const models = [
      "claude-sonnet-4-20250514",
      "claude-opus-4",
      "gpt-4o",
      "gpt-4.1",
      "gemini-2.5-pro",
    ];
    const targets = models.map((m) => ({ text: m, item: m }));

    // "cl" should match all claude models
    expect(fuzzySearch("cl", targets).map((r) => r.item)).toEqual([
      "claude-sonnet-4-20250514",
      "claude-opus-4",
    ]);

    // "son" should match sonnet
    expect(fuzzySearch("son", targets).map((r) => r.item)).toEqual([
      "claude-sonnet-4-20250514",
    ]);

    // "4" (with space) should match all 4 models
    expect(fuzzySearch("4", targets).map((r) => r.item).sort()).toEqual([
      "claude-opus-4",
      "claude-sonnet-4-20250514",
      "gpt-4.1",
      "gpt-4o",
    ].sort());

    // "gpt" matches both gpt models, gpt-4o first because 4o follows consecutively
    const gptResults = fuzzySearch("gpt", targets).map((r) => r.item);
    expect(gptResults).toContain("gpt-4o");
    expect(gptResults).toContain("gpt-4.1");
  });

  it("matches with description included in target text", () => {
    const results = fuzzySearch("anthropic", [
      { text: "claude-sonnet Anthropic", item: "a" },
      { text: "gpt-4o OpenAI", item: "b" },
    ]);
    expect(results.map((r) => r.item)).toEqual(["a"]);
  });
});
