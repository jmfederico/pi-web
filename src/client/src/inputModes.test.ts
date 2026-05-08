import { describe, expect, it } from "vitest";
import { inputModeForDraft, isShellInput } from "./inputModes";

describe("inputModeForDraft", () => {
  it("detects shell input and context-excluded shell input after leading whitespace", () => {
    expect(inputModeForDraft(" ! npm test")).toEqual({ kind: "shell", excludeFromContext: false });
    expect(inputModeForDraft("\n!! secret command")).toEqual({ kind: "shell", excludeFromContext: true });
    expect(isShellInput(" ! pwd")).toBe(true);
  });

  it("detects slash commands only for the current token", () => {
    expect(inputModeForDraft("/compact")).toEqual({ kind: "command" });
    expect(inputModeForDraft("please /compact")).toEqual({ kind: "command" });
    expect(inputModeForDraft("please mention/path")).toEqual({ kind: "normal" });
  });

  it("detects file completion contexts", () => {
    expect(inputModeForDraft("open @src/main.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open @ ")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open @ \"src/main.ts")).toEqual({ kind: "file" });
    expect(inputModeForDraft("open \"src/main.ts")).toEqual({ kind: "normal" });
  });
});
