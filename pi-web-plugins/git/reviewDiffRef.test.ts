import { describe, expect, it } from "vitest";
import { hashDiffSource, reviewRefForDiffLine } from "./browser/reviewDiffRef.js";
import type { UnifiedDiffLine } from "./browser/unifiedDiff.js";

function line(patch: Partial<UnifiedDiffLine>): UnifiedDiffLine {
  return { kind: "context", prefix: " ", text: "", spans: [], ...patch };
}

describe("reviewRefForDiffLine", () => {
  it("maps a context line to the new-side line number", () => {
    expect(reviewRefForDiffLine(line({ kind: "context", oldLineNumber: 3, newLineNumber: 4 }))).toEqual({ side: "new", line: 4 });
  });

  it("maps an added line to the new-side line number", () => {
    expect(reviewRefForDiffLine(line({ kind: "add", newLineNumber: 10 }))).toEqual({ side: "new", line: 10 });
  });

  it("maps a removed line to the old-side line number", () => {
    expect(reviewRefForDiffLine(line({ kind: "remove", oldLineNumber: 7 }))).toEqual({ side: "old", line: 7 });
  });

  it("has no ref for meta, hunk, and marker lines", () => {
    expect(reviewRefForDiffLine(line({ kind: "meta" }))).toBeUndefined();
    expect(reviewRefForDiffLine(line({ kind: "hunk", oldLineNumber: 1, newLineNumber: 1 }))).toBeUndefined();
    expect(reviewRefForDiffLine(line({ kind: "marker" }))).toBeUndefined();
  });

  it("has no ref when the expected side's line number is missing", () => {
    expect(reviewRefForDiffLine(line({ kind: "context" }))).toBeUndefined();
    expect(reviewRefForDiffLine(line({ kind: "remove" }))).toBeUndefined();
  });
});

describe("hashDiffSource", () => {
  it("is stable for identical text", () => {
    expect(hashDiffSource("@@ -1 +1 @@\n-a\n+b")).toBe(hashDiffSource("@@ -1 +1 @@\n-a\n+b"));
  });

  it("differs for different text", () => {
    expect(hashDiffSource("a")).not.toBe(hashDiffSource("b"));
  });
});
