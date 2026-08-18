import { describe, expect, it } from "vitest";
import { inputModeForDraft, inputModesEqual, isShellInput } from "./inputModes";

describe("input mode helpers", () => {
  it("detects shell mode and context-excluded shell mode after leading whitespace", () => {
    expect(inputModeForDraft(" ! npm test")).toEqual({ kind: "shell", excludeFromContext: false });
    expect(inputModeForDraft("\n!! secret command")).toEqual({ kind: "shell", excludeFromContext: true });
    expect(isShellInput(" ! pwd")).toBe(true);
  });

  it("detects slash-command mode from the current token", () => {
    expect(inputModeForDraft("/compact")).toEqual({ kind: "command" });
    expect(inputModeForDraft("please /compact")).toEqual({ kind: "command" });
    expect(inputModeForDraft("please mention/path")).toEqual({ kind: "normal" });
  });

  it("compares modes by kind and shell context-exclusion", () => {
    expect(inputModesEqual({ kind: "normal" }, { kind: "normal" })).toBe(true);
    expect(inputModesEqual({ kind: "normal" }, { kind: "command" })).toBe(false);
    expect(inputModesEqual({ kind: "shell", excludeFromContext: false }, { kind: "shell", excludeFromContext: false })).toBe(true);
    expect(inputModesEqual({ kind: "shell", excludeFromContext: false }, { kind: "shell", excludeFromContext: true })).toBe(false);
  });

  it("collapses file completion triggers to file mode", () => {
    expect(inputModeForDraft("open @src/main.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open @ ")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open @ A FILE")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open !@vendor/file.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("!@vendor/file.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open @ \"src/main.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open !@\"vendor/file.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open \"src/main.ts")).toEqual({ kind: "normal" });
  });

  it("collapses # model completion tokens to model mode", () => {
    expect(inputModeForDraft("#anthropic/claude-opus")).toEqual({ kind: "model" });
    expect(inputModeForDraft("use #gpt-5.2")).toEqual({ kind: "model" });
    expect(inputModeForDraft("use #gpt-5.2 please")).toEqual({ kind: "normal" });
    expect(inputModeForDraft("# ")).toEqual({ kind: "normal" });
  });
});
