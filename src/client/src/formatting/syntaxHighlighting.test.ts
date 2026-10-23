import { describe, expect, it, vi } from "vitest";
import type { SyntaxHighlighterContribution } from "../../../plugin-api";
import { createSyntaxHighlightingCapability, MAX_SYNTAX_HIGHLIGHT_LENGTH, runSyntaxHighlighter, snapshotSyntaxHighlighter, validateSyntaxHighlightTokens } from "./syntaxHighlighting";

const contribution = (highlight: SyntaxHighlighterContribution["highlight"]): SyntaxHighlighterContribution => ({ id: "test", languages: ["TEST"], highlight });

describe("syntax highlighting service", () => {
  it("does not select or run a parser for oversized source", async () => {
    const select = vi.fn(() => undefined);
    const capability = createSyntaxHighlightingCapability(select);
    const request = { machineId: "local", language: "test", signal: new AbortController().signal };
    expect(await capability.highlight({ ...request, text: "x".repeat(MAX_SYNTAX_HIGHLIGHT_LENGTH + 1) })).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    await capability.highlight({ ...request, text: "x".repeat(MAX_SYNTAX_HIGHLIGHT_LENGTH) });
    expect(select).toHaveBeenCalledOnce();
  });

  it("snapshots selectors and UTF-16 tokens while retaining gaps", async () => {
    const tokens = [{ from: 2, to: 4, kind: "string" as const }];
    const source = contribution(() => tokens);
    const snapshot = snapshotSyntaxHighlighter(source);
    source.languages = ["changed"];
    expect(snapshot.languages).toEqual(["test"]);
    const result = await runSyntaxHighlighter(snapshot, "😀ab!", new AbortController().signal);
    const token = tokens[0];
    if (token === undefined) throw new Error("Missing fixture token");
    token.to = 5;
    expect(result).toEqual([{ from: 2, to: 4, kind: "string" }]);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(validateSyntaxHighlightTokens([], "")).toEqual([]);
  });

  it.each([
    null, {}, [undefined], Array(1),
    [{ from: -1, to: 1, kind: "keyword" }],
    [{ from: 0, to: 4, kind: "keyword" }],
    [{ from: 0.5, to: 1, kind: "keyword" }],
    [{ from: 0, to: NaN, kind: "keyword" }],
    [{ from: 1, to: 1, kind: "keyword" }],
    [{ from: 0, to: 1, kind: "arbitrary-css" }],
    [{ from: 1, to: 3, kind: "keyword" }, { from: 0, to: 1, kind: "string" }],
    [{ from: 0, to: 2, kind: "keyword" }, { from: 1, to: 3, kind: "string" }],
  ].map((tokens) => [tokens]))("rejects malformed output %#", (tokens) => {
    expect(() => validateSyntaxHighlightTokens(tokens, "abc")).toThrow();
  });

  it("propagates synchronous, asynchronous and validation errors with identity and cause", async () => {
    const failure = new Error("broken parser");
    for (const highlight of [() => { throw failure; }, () => Promise.reject(failure)]) {
      await expect(runSyntaxHighlighter(contribution(highlight), "text", new AbortController().signal))
        .rejects.toMatchObject({ message: "Syntax highlighter test failed", cause: failure });
    }
    await expect(runSyntaxHighlighter(contribution(() => [{ from: 0, to: 99, kind: "number" }]), "x", new AbortController().signal))
      .rejects.toThrow("Syntax highlighter test failed");
  });

  it("never starts aborted work and settles cancellation even for uncooperative plugins", async () => {
    const controller = new AbortController();
    const highlight = vi.fn(() => new Promise<readonly never[]>(() => { /* Deliberately uncooperative plugin. */ }));
    const result = runSyntaxHighlighter(contribution(highlight), "text", controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await rejection;
    await expect(runSyntaxHighlighter(contribution(highlight), "text", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(highlight).toHaveBeenCalledTimes(1);
  });
});
