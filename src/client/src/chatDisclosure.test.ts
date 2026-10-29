import { describe, expect, it } from "vitest";
import { ChatDisclosureController, parseDisclosureSnapshot, type ChatDisclosureSnapshot, type ChatDisclosureStorage } from "./chatDisclosure";

class MemoryDisclosureStorage implements ChatDisclosureStorage {
  readonly snapshots = new Map<string, ChatDisclosureSnapshot>();

  read(sessionId: string): ChatDisclosureSnapshot | undefined {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
  }

  write(sessionId: string, snapshot: ChatDisclosureSnapshot): void {
    this.snapshots.set(sessionId, cloneSnapshot(snapshot));
  }
}

function cloneSnapshot(snapshot: ChatDisclosureSnapshot): ChatDisclosureSnapshot {
  return { open: [...snapshot.open], closedDefaultOpen: [...snapshot.closedDefaultOpen] };
}

describe("ChatDisclosureController", () => {
  it("isolates identical sessions on different machines while preserving local storage", () => {
    const storage = new MemoryDisclosureStorage();
    storage.snapshots.set("same", { open: ["choice"], closedDefaultOpen: [] });
    const controller = new ChatDisclosureController(storage);
    controller.syncSession("same");
    expect(controller.isOpen("choice", false)).toBe(true);
    controller.syncSession("same", "remote");
    expect(controller.isOpen("choice", false)).toBe(false);
    controller.applyToggle("remote-only", true, false);
    controller.syncSession("same");
    expect(controller.isOpen("remote-only", false)).toBe(false);
    controller.syncSession("same", "remote");
    expect(controller.isOpen("remote-only", false)).toBe(true);
  });

  it("moves explicit choices to committed addresses without retaining provisional keys", () => {
    const storage = new MemoryDisclosureStorage();
    const controller = new ChatDisclosureController(storage);
    controller.syncSession("session");
    controller.applyToggle("stream", false, true);
    controller.transferChoice("stream", "entry");
    expect(controller.hasChoice("stream")).toBe(false);
    expect(controller.isOpen("entry", true)).toBe(false);
    const reloaded = new ChatDisclosureController(storage);
    reloaded.syncSession("session");
    expect(reloaded.isOpen("entry", true)).toBe(false);
  });

  it("keeps a default-open live group closed after the user closes it", () => {
    const storage = new MemoryDisclosureStorage();
    const controller = new ChatDisclosureController(storage);
    const key = "s1:live:12";

    controller.syncSession("s1");

    expect(controller.isOpen(key, true)).toBe(true);
    expect(controller.applyToggle(key, false, true)).toBe(true);
    expect(controller.isOpen(key, true)).toBe(false);
    expect(storage.read("s1")).toEqual({ open: [], closedDefaultOpen: [key] });
  });

  it("allows a closed default-open group to be reopened by the user", () => {
    const controller = new ChatDisclosureController(new MemoryDisclosureStorage());
    const key = "s1:live:12";

    controller.syncSession("s1");
    controller.applyToggle(key, false, true);

    expect(controller.applyToggle(key, true, true)).toBe(true);
    expect(controller.isOpen(key, true)).toBe(true);
    expect(controller.snapshot()).toEqual({ open: [], closedDefaultOpen: [] });
  });

  it("persists explicit opens for groups that are closed by default", () => {
    const storage = new MemoryDisclosureStorage();
    const key = "s1:44";

    const first = new ChatDisclosureController(storage);
    first.syncSession("s1");
    first.applyToggle(key, true, false);

    const second = new ChatDisclosureController(storage);
    second.syncSession("s1");

    expect(second.isOpen(key, false)).toBe(true);
  });
});

describe("parseDisclosureSnapshot", () => {
  it("hydrates legacy array storage as open group keys", () => {
    expect(parseDisclosureSnapshot(["a", 1, "b"])).toEqual({ open: ["a", "b"], closedDefaultOpen: [] });
  });

  it("hydrates object storage", () => {
    expect(parseDisclosureSnapshot({ open: ["a"], closedDefaultOpen: ["b", false] })).toEqual({ open: ["a"], closedDefaultOpen: ["b"] });
  });
});
