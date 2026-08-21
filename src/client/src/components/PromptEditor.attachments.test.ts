import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearStagedAttachments } from "../promptAttachmentStaging";
import { PromptEditor } from "./PromptEditor";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
});

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
  // Staged attachments live in an in-memory module singleton rather than the
  // swappable `localStorage` above, so each test's keys are cleared explicitly
  // rather than reset by replacing a global.
  clearStagedAttachments("local:session-a");
  clearStagedAttachments("local:session-b");
});

// `willUpdate` is a protected lifecycle hook Lit invokes as part of its async
// update cycle. Rather than pull in the full happy-dom harness just to drive
// that cycle, these tests call it directly (as other suites in this repo call
// protected/private methods through `Reflect`) with a synthetic `changed` map
// shaped like the one Lit would have built for a session switch.
function triggerSessionSwitch(editor: PromptEditor, previous: { machineId: string; sessionId: string }): void {
  const method: unknown = Reflect.get(editor, "willUpdate");
  if (typeof method !== "function") throw new Error("PromptEditor.willUpdate was unavailable");
  // `willUpdate` only reads `has`/`get` for "sessionId"/"machineId" off the
  // changed-properties map Lit would normally build, so a plain string-keyed
  // Map reproduces its contract here without needing a Lit `PropertyValues`.
  const changed = new Map([["sessionId", previous.sessionId], ["machineId", previous.machineId]]);
  Reflect.apply(method, editor, [changed]);
}

describe("PromptEditor pending attachments across session switches", () => {
  it("does not carry pending attachments from one session into another", () => {
    const editor = new PromptEditor();
    editor.machineId = "local";
    editor.sessionId = "session-a";
    const attachment = { id: "attachment-1", kind: "file" as const, name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    Reflect.set(editor, "attachments", [attachment]);

    // Switch to a different session: the pending attachment must not follow.
    editor.sessionId = "session-b";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-a" });

    expect(Reflect.get(editor, "attachments")).toEqual([]);
  });

  it("restores a session's own pending attachments when switching back to it", () => {
    const editor = new PromptEditor();
    editor.machineId = "local";
    editor.sessionId = "session-a";
    const attachment = { id: "attachment-1", kind: "file" as const, name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    Reflect.set(editor, "attachments", [attachment]);

    editor.sessionId = "session-b";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-a" });
    expect(Reflect.get(editor, "attachments")).toEqual([]);

    editor.sessionId = "session-a";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-b" });

    expect(Reflect.get(editor, "attachments")).toEqual([attachment]);
  });

  it("does not resurrect attachments once they were sent from a session", () => {
    const editor = new PromptEditor();
    editor.machineId = "local";
    editor.sessionId = "session-a";
    Reflect.set(editor, "attachments", [{ id: "attachment-1", kind: "file" as const, name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 }]);

    // Leave session-a with the attachment pending, then come back to it.
    editor.sessionId = "session-b";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-a" });
    editor.sessionId = "session-a";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-b" });
    expect(Reflect.get(editor, "attachments")).toEqual([{ id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 }]);

    // Sending (resetComposer) consumes the attachment for session-a.
    const resetComposer: unknown = Reflect.get(editor, "resetComposer");
    if (typeof resetComposer !== "function") throw new Error("PromptEditor.resetComposer was unavailable");
    Reflect.apply(resetComposer, editor, []);
    expect(Reflect.get(editor, "attachments")).toEqual([]);

    // Round-tripping through session-b and back must not resurrect it.
    editor.sessionId = "session-b";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-a" });
    editor.sessionId = "session-a";
    triggerSessionSwitch(editor, { machineId: "local", sessionId: "session-b" });

    expect(Reflect.get(editor, "attachments")).toEqual([]);
  });
});
