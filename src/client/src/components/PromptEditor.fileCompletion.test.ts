import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PromptEditor } from "./PromptEditor";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PromptEditor file completions", () => {
  it("debounces file completion requests while the query is changing", async () => {
    vi.useFakeTimers();
    const files = vi.spyOn(api, "files").mockResolvedValue([{ path: "README.md", kind: "tracked" }]);
    const editor = configuredEditor();
    const updateDraft = privateProcedure(editor, "updateDraft");

    updateDraft.call(editor, "@");
    updateDraft.call(editor, "@R");

    expect(files).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(149);
    expect(files).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(files).toHaveBeenCalledOnce();
    expect(files.mock.calls[0]?.[0]).toBe("R");
  });

  it("reuses a recent result for the same workspace query", async () => {
    const files = vi.spyOn(api, "files").mockResolvedValue([{ path: "README.md", kind: "tracked" }]);
    const editor = configuredEditor();
    const refreshCompletions = privateMethod(editor, "refreshCompletions");

    setDraft(editor, "@README");
    await refreshCompletions.call(editor);
    await refreshCompletions.call(editor);

    expect(files).toHaveBeenCalledOnce();
    expect(currentCompletions(editor)).toEqual([{
      kind: "file",
      replaceFrom: 0,
      replaceTo: 7,
      insertText: "@README.md",
      detail: "tracked",
    }]);
  });

  it("cancels the previous in-flight file request", async () => {
    const firstRequest = deferred<{ path: string; kind: "tracked" }[]>();
    const requests = vi.spyOn(api, "files")
      .mockImplementationOnce((_query, options) => {
        options.signal?.addEventListener("abort", () => {
          firstRequest.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        return firstRequest.promise;
      })
      .mockResolvedValueOnce([{ path: "README.md", kind: "tracked" }]);
    const editor = configuredEditor();
    const refreshCompletions = privateMethod(editor, "refreshCompletions");

    setDraft(editor, "@R");
    const first = refreshCompletions.call(editor);
    await Promise.resolve();
    setDraft(editor, "@RE");
    const second = refreshCompletions.call(editor);
    await Promise.all([first, second]);

    expect(requests).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(currentCompletions(editor)).toHaveLength(1);
  });
});

function configuredEditor(): PromptEditor {
  const editor = new PromptEditor();
  editor.machineId = "local";
  editor.projectId = "project-1";
  editor.workspaceId = "workspace-1";
  return editor;
}

function setDraft(editor: PromptEditor, draft: string): void {
  Reflect.set(editor, "draft", draft);
}

function currentCompletions(editor: PromptEditor): unknown {
  return Reflect.get(editor, "completions");
}

function privateMethod(object: PromptEditor, name: string): PrivateAsyncMethod {
  const value: unknown = Reflect.get(object, name);
  if (!isPrivateAsyncMethod(value)) throw new Error(`PromptEditor.${name} is not callable`);
  return value;
}

function privateProcedure(object: PromptEditor, name: string): PrivateProcedure {
  const value: unknown = Reflect.get(object, name);
  if (!isPrivateProcedure(value)) throw new Error(`PromptEditor.${name} is not callable`);
  return value;
}

type PrivateAsyncMethod = (this: PromptEditor) => Promise<void>;
type PrivateProcedure = (this: PromptEditor, value: string) => void;

function isPrivateAsyncMethod(value: unknown): value is PrivateAsyncMethod {
  return typeof value === "function";
}

function isPrivateProcedure(value: unknown): value is PrivateProcedure {
  return typeof value === "function";
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
