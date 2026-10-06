import { describe, expect, it, vi } from "vitest";
import { appendPromptChipText, PromptChipStore } from "./promptChips";

const target = { machineId: "local", sessionId: "session" };
const data = { id: "context", label: "Context", text: " saved text " };

describe("plugin prompt chip ownership", () => {
  it("isolates local ids by plugin, machine and conversation and withdraws silently", () => {
    const store = new PromptChipStore();
    const onRemove = vi.fn();
    store.set("one", target, { ...data, onRemove });
    store.set("two", target, data);
    store.set("one", { ...target, machineId: "remote" }, data);
    store.set("one", { ...target, sessionId: "other" }, data);
    store.remove("one", target, data.id);
    expect(store.list(target).map((chip) => chip.pluginId)).toEqual(["two"]);
    expect(store.list({ ...target, machineId: "remote" })).toHaveLength(1);
    expect(store.list({ ...target, sessionId: "other" })).toHaveLength(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("replaces saved data and callbacks, and consumes only the submitted version", () => {
    const store = new PromptChipStore();
    const original = vi.fn(), restored = vi.fn();
    store.set("one", target, { ...data, onRemove: original });
    const submitted = store.list(target);
    store.set("one", target, { ...data, text: "Updated", onRemove: restored });
    store.consume(submitted);
    expect(original).toHaveBeenCalledExactlyOnceWith("submitted");
    expect(store.list(target)[0]?.text).toBe("Updated");
    const replacement = store.list(target)[0];
    if (replacement === undefined) throw new Error("Missing replacement chip");
    store.removeByUser(replacement);
    expect(restored).toHaveBeenCalledExactlyOnceWith("user");
    expect(store.list(target)).toEqual([]);
  });

  it("restages plugin-saved data in a fresh host with fresh callbacks", () => {
    const oldHost = new PromptChipStore();
    oldHost.set("one", target, data);
    const newHost = new PromptChipStore();
    expect(newHost.list(target)).toEqual([]);
    const onRemove = vi.fn();
    newHost.set("one", target, { ...data, onRemove });
    newHost.consume(newHost.list(target));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("submitted");
  });

  it("isolates throwing and rejected notifications without losing other owners", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = new PromptChipStore();
    const onRemove = vi.fn();
    store.set("one", target, { ...data, onRemove: () => { throw new Error("bad callback"); } });
    store.set("two", target, { ...data, onRemove: () => Promise.reject(new Error("rejected callback")) });
    store.set("three", target, { ...data, onRemove });
    store.consume(store.list(target));
    await Promise.resolve();
    expect(store.list(target)).toEqual([]);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("submitted");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("appends text verbatim and supports chips alone", () => {
    const store = new PromptChipStore();
    store.set("one", target, data);
    expect(appendPromptChipText("Question", store.list(target))).toBe("Question\n\n saved text ");
    expect(appendPromptChipText("", store.list(target))).toBe(" saved text ");
  });

  it.each(["id", "label", "text"] as const)("rejects empty %s", (field) => {
    const store = new PromptChipStore();
    expect(() => { store.set("one", target, { ...data, [field]: "  " }); }).toThrow(TypeError);
    expect(store.list(target)).toEqual([]);
  });
});
