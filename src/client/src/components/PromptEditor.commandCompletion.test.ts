import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptEditor command completions", () => {
  it("maps slash commands, including argument hints, to completion items", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "pr", source: "prompt", description: "Review PRs from URLs", argumentHint: "<PR-URL>" },
      { name: "tree", source: "builtin", description: "Navigate session tree" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 1, insertText: "/pr", detail: "prompt", description: "Review PRs from URLs", argumentHint: "<PR-URL>" },
      { kind: "command", replaceFrom: 0, replaceTo: 1, insertText: "/tree", detail: "builtin", description: "Navigate session tree" },
    ]);
  });

  it("keeps all matching skills beyond twelve and still filters by name", async () => {
    const skills = Array.from({ length: 40 }, (_, index) => ({
      name: `skill:example-${String(index + 1).padStart(2, "0")}`,
      source: "skill" as const,
    }));
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "tree", source: "builtin" },
      ...skills,
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/skill:");

    expect(currentCompletions(editor)).toEqual(skills.map((skill) => ({
      kind: "command", replaceFrom: 0, replaceTo: 7,
      insertText: `/${skill.name}`, detail: "skill",
    })));

    await refreshCompletions(editor, "/skill:example-40");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 17, insertText: "/skill:example-40", detail: "skill" },
    ]);
  });

  it("filters commands by the typed query", async () => {
    vi.spyOn(api, "commands").mockResolvedValue([
      { name: "pr", source: "prompt", argumentHint: "<PR-URL>" },
      { name: "tree", source: "builtin" },
    ]);
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "/t");

    expect(currentCompletions(editor)).toEqual([
      { kind: "command", replaceFrom: 0, replaceTo: 2, insertText: "/tree", detail: "builtin" },
    ]);
  });
});

// refreshCompletions is private and driven by CodeMirror updates in production;
// invoking it through Reflect mirrors the PromptEditor.draft.test.ts seam and
// keeps the wiring test at the component boundary without a DOM harness.
async function refreshCompletions(editor: PromptEditor, draft: string): Promise<void> {
  Reflect.set(editor, "draft", draft);
  const refresh: unknown = Reflect.get(editor, "refreshCompletions");
  if (!isRefreshCompletions(refresh)) throw new Error("PromptEditor.refreshCompletions is not callable");
  await refresh.call(editor);
}

function isRefreshCompletions(value: unknown): value is (this: PromptEditor) => Promise<void> {
  return typeof value === "function";
}

function currentCompletions(editor: PromptEditor): unknown {
  return Reflect.get(editor, "completions");
}
