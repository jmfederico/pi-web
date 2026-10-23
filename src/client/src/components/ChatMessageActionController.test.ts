import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageActionResult } from "../../../plugin-api";
import type { RegisteredMessageAction } from "../plugins/messageActions";
import { ChatMessageActionController, type ChatMessageActionContext } from "./ChatMessageActionController";
import type { ChatLine } from "./shared";

const entry: RegisteredMessageAction = {
  id: "test:entry", title: "Entry", run: () => undefined,
  binding: { registrationPluginId: "test", sourcePluginId: "test" },
};
const display: RegisteredMessageAction = {
  id: "test:display", target: "display", title: "Display", run: () => undefined, binding: entry.binding,
};
const message: ChatLine = { role: "user", entryId: "entry", parts: [{ type: "text", text: "Hello" }] };

function deferred() {
  let resolve!: (value: MessageActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MessageActionResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const context: ChatMessageActionContext = {
    machineId: "local", sessionId: "session", connected: true, actions: [entry, display],
    availability: {
      machine: { id: "local", name: "Local", kind: "local" },
      session: { id: "session", cwd: "/repo", archived: false, pending: false, busy: false },
    },
    onEntry: vi.fn(() => Promise.resolve()), onDisplay: vi.fn(() => Promise.resolve()),
  };
  const changed = vi.fn();
  return { context, changed, controller: new ChatMessageActionController(() => context, changed) };
}

afterEach(() => { vi.useRealTimers(); });

describe("ChatMessageActionController", () => {
  it("serializes entry workflows globally but scopes display pending to each action and header", async () => {
    const { context, controller } = fixture();
    const history = deferred();
    const copy = deferred();
    context.onEntry = vi.fn(() => history.promise);
    context.onDisplay = vi.fn(() => copy.promise);
    const runningEntry = controller.run(message, message, "first", entry);
    const runningDisplay = controller.run(message, message, "first", display);
    await controller.run(message, message, "second", entry);
    await controller.run(message, message, "first", display);
    expect(context.onEntry).toHaveBeenCalledOnce();
    expect(context.onDisplay).toHaveBeenCalledOnce();
    expect(controller.pending("second", entry)).toBe(true);
    expect(controller.pending("first", display)).toBe(true);
    expect(controller.pending("second", display)).toBe(false);
    expect(controller.pending("first", { ...display, id: "test:other" })).toBe(false);
    history.resolve(undefined);
    copy.resolve(undefined);
    await Promise.all([runningEntry, runningDisplay]);
    expect(controller.pending("second", entry)).toBe(false);
    expect(controller.pending("first", display)).toBe(false);
  });

  it("keeps the entry lock across sessions and ignores stale errors and feedback", async () => {
    const { context, controller } = fixture();
    const history = deferred();
    const copy = deferred();
    context.onEntry = () => history.promise;
    context.onDisplay = () => copy.promise;
    const runningEntry = controller.run(message, message, "first", entry);
    const runningDisplay = controller.run(message, message, "first", display);
    context.sessionId = "other";
    controller.reset();
    expect(controller.pending("first", entry)).toBe(true);
    expect(controller.pending("first", display)).toBe(false);
    history.reject(new Error("Old session failed"));
    copy.resolve({ title: "Old success" });
    await Promise.all([runningEntry, runningDisplay]);
    expect(controller.errorMessage("first")).toBeUndefined();
    expect(controller.presentation("first", display.id)).toBeUndefined();
    expect(controller.pending("first", entry)).toBe(false);
  });

  it("does not let an old display completion unlock a remounted invocation at the same header", async () => {
    const { context, controller } = fixture();
    const old = deferred();
    const current = deferred();
    context.onDisplay = () => old.promise;
    const oldRun = controller.run(message, message, "first", display);
    context.connected = false;
    controller.reset();
    context.connected = true;
    context.onDisplay = () => current.promise;
    const currentRun = controller.run(message, message, "first", display);
    old.resolve({ title: "Stale" });
    await oldRun;
    expect(controller.pending("first", display)).toBe(true);
    expect(controller.presentation("first", display.id)).toBeUndefined();
    current.resolve(undefined);
    await currentRun;
    expect(controller.pending("first", display)).toBe(false);
  });

  it("renews feedback, clears its timer on reset, and exposes errors only at their header", async () => {
    vi.useFakeTimers();
    const { context, controller, changed } = fixture();
    context.onDisplay = () => Promise.resolve({ title: "Saved" });
    await controller.run(message, message, "first", display);
    await vi.advanceTimersByTimeAsync(800);
    await controller.run(message, message, "first", display);
    await vi.advanceTimersByTimeAsync(800);
    expect(controller.presentation("first", display.id)?.title).toBe("Saved");
    expect(controller.presentation("second", display.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.presentation("first", display.id)).toBeUndefined();
    await controller.run(message, message, "first", display);
    expect(vi.getTimerCount()).toBe(1);
    controller.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.presentation("first", display.id)).toBeUndefined();
    context.onDisplay = () => Promise.reject(new Error("Save failed"));
    await controller.run(message, message, "first", display);
    expect(controller.errorMessage("first")).toBe("Save failed");
    expect(controller.errorMessage("second")).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    controller.reset();
    expect(controller.errorMessage("first")).toBeUndefined();
  });
});
