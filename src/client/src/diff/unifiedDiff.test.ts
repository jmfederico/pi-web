import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, type UnifiedDiffLine, type UnifiedDiffLineKind } from "./unifiedDiff";

describe("parseUnifiedDiff", () => {
  it("computes inline spans for paired removed and added lines", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,2 +10,2 @@ export function demo() {",
      "-  const name = \"fooBar\";",
      "+  const name = \"fooBaz\";",
      "   return name;",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);
    const removed = firstLineOfKind(lines, "remove");
    const added = firstLineOfKind(lines, "add");
    const context = firstLineOfKind(lines, "context");

    expect(removed.oldLineNumber).toBe(10);
    expect(removed.newLineNumber).toBeUndefined();
    expect(changedText(removed)).toEqual(["r"]);
    expect(added.oldLineNumber).toBeUndefined();
    expect(added.newLineNumber).toBe(10);
    expect(changedText(added)).toEqual(["z"]);
    expect(context.oldLineNumber).toBe(11);
    expect(context.newLineNumber).toBe(11);
  });

  it("keeps file headers as metadata before a hunk starts", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(parseUnifiedDiff(diff).slice(0, 5).map((line) => line.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk"]);
  });

  it("parses changed content that starts with file header markers inside hunks", () => {
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "---- removed heading",
      "++++ added heading",
    ].join("\n");

    const removed = firstLineOfKind(parseUnifiedDiff(diff), "remove");
    const added = firstLineOfKind(parseUnifiedDiff(diff), "add");

    expect(removed.text).toBe("--- removed heading");
    expect(added.text).toBe("+++ added heading");
  });

  it("pairs a single removed line with the closest added line in uneven blocks", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1,2 @@",
      "-const label = \"old\";",
      "+const label = \"new\";",
      "+const extra = true;",
    ].join("\n");

    const addedLines = linesOfKind(parseUnifiedDiff(diff), "add");
    const firstAdded = lineAt(addedLines, 0);
    const secondAdded = lineAt(addedLines, 1);

    expect(changedText(firstAdded)).toEqual(["new"]);
    expect(secondAdded.spans.every((span) => !span.changed)).toBe(true);
  });

  it("leaves pure additions without inline change spans", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+brand new",
    ].join("\n");

    const added = firstLineOfKind(parseUnifiedDiff(diff), "add");

    expect(added.newLineNumber).toBe(1);
    expect(added.spans).toEqual([{ text: "brand new", changed: false }]);
  });
});

function firstLineOfKind(lines: UnifiedDiffLine[], kind: UnifiedDiffLineKind): UnifiedDiffLine {
  const found = lines.find((line) => line.kind === kind);
  if (found === undefined) throw new Error(`Missing ${kind} line`);
  return found;
}

function linesOfKind(lines: UnifiedDiffLine[], kind: UnifiedDiffLineKind): UnifiedDiffLine[] {
  return lines.filter((line) => line.kind === kind);
}

function lineAt(lines: UnifiedDiffLine[], index: number): UnifiedDiffLine {
  const line = lines[index];
  if (line === undefined) throw new Error(`Missing line at ${String(index)}`);
  return line;
}

function changedText(line: UnifiedDiffLine): string[] {
  return line.spans.filter((span) => span.changed).map((span) => span.text);
}
