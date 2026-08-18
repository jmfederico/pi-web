import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SessionModel } from "../api";
import { PromptEditor } from "./PromptEditor";

const sonnet: SessionModel = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
const gpt: SessionModel = { provider: "openai", id: "gpt-5.2" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptEditor model completions", () => {
  it("requests models for the session and maps a # token to model completions", async () => {
    const models = vi.spyOn(api, "models").mockResolvedValue({ models: [sonnet, gpt] });
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";
    editor.machineId = "remote-a";

    await refreshCompletions(editor, "please use #cla");

    expect(models).toHaveBeenCalledWith({ id: "session-1", cwd: "/repo" }, "remote-a");
    expect(currentCompletions(editor)).toEqual([
      { kind: "model", replaceFrom: 11, replaceTo: 15, insertText: "#anthropic/claude-sonnet-4-5", detail: "anthropic", description: "Claude Sonnet 4.5" },
    ]);
    expect(Reflect.get(editor, "selectedIndex")).toBe(0);
  });

  it("lists every model for a bare # token", async () => {
    vi.spyOn(api, "models").mockResolvedValue({ models: [sonnet, gpt] });
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "#");

    expect(currentCompletions(editor)).toEqual([
      { kind: "model", replaceFrom: 0, replaceTo: 1, insertText: "#anthropic/claude-sonnet-4-5", detail: "anthropic", description: "Claude Sonnet 4.5" },
      { kind: "model", replaceFrom: 0, replaceTo: 1, insertText: "#openai/gpt-5.2", detail: "openai" },
    ]);
  });

  it("clears completions when the models request fails", async () => {
    vi.spyOn(api, "models").mockRejectedValue(new Error("models unavailable"));
    const editor = new PromptEditor();
    editor.sessionId = "session-1";
    editor.cwd = "/repo";

    await refreshCompletions(editor, "#cla");

    expect(currentCompletions(editor)).toEqual([]);
  });

  it("does not request models without session context", async () => {
    const models = vi.spyOn(api, "models").mockResolvedValue({ models: [sonnet] });
    const editor = new PromptEditor();

    await refreshCompletions(editor, "#cla");

    expect(models).not.toHaveBeenCalled();
    expect(currentCompletions(editor)).toEqual([]);
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
