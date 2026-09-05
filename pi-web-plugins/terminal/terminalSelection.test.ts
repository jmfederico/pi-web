import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "./terminalProtocol";
import { InMemoryTerminalSelectionMemory, selectFallbackTerminal, selectPreferredTerminal, SessionStorageTerminalSelectionMemory, terminalSelectionScope, type KeyValueStorage } from "./terminalSelection";

function terminal(id: string, exited = false): TerminalInfo {
  return { id, cwd: "/repo", name: id, createdAt: "now", exited };
}

describe("terminal selection", () => {
  it("prefers explicit route targets before remembered or default terminals", () => {
    const terminals = [terminal("first"), terminal("target")];

    expect(selectPreferredTerminal(terminals, { targetTerminalId: "target", latestTerminalId: "first" })?.id).toBe("target");
  });

  it("uses remembered terminals when there is no route target", () => {
    const terminals = [terminal("first"), terminal("remembered")];

    expect(selectPreferredTerminal(terminals, { latestTerminalId: "remembered" })?.id).toBe("remembered");
  });

  it("falls back to an active terminal and then any terminal", () => {
    expect(selectPreferredTerminal([terminal("exited", true), terminal("active")])?.id).toBe("active");
    expect(selectFallbackTerminal([terminal("exited", true)])?.id).toBe("exited");
  });

  it("remembers terminal ids per workspace cwd", () => {
    const memory = new InMemoryTerminalSelectionMemory();
    memory.rememberTerminal("/repo", "t1");
    memory.rememberTerminal("/other", "t2");

    expect(memory.latestTerminalId("/repo")).toBe("t1");
    memory.forgetTerminal("t1");
    expect(memory.latestTerminalId("/repo")).toBeUndefined();
    expect(memory.latestTerminalId("/other")).toBe("t2");
  });

  it("keeps the legacy machine-and-path scope for persisted selection compatibility", () => {
    expect(terminalSelectionScope("remote-1", "/repo")).toBe("remote-1:/repo");
  });

  it("merges storage mutations from independent local and remote activations", () => {
    const storage = memoryStorage();
    const local = new SessionStorageTerminalSelectionMemory(storage);
    const remote = new SessionStorageTerminalSelectionMemory(storage);

    local.rememberTerminal("local:/repo", "local-terminal");
    remote.rememberTerminal("remote:/repo", "remote-terminal");

    expect(local.latestTerminalId("remote:/repo")).toBe("remote-terminal");
    local.forgetWorkspace("local:/repo");
    expect(new SessionStorageTerminalSelectionMemory(storage).latestTerminalId("remote:/repo")).toBe("remote-terminal");
    expect(new SessionStorageTerminalSelectionMemory(storage).latestTerminalId("local:/repo")).toBeUndefined();
  });

  it("persists terminal ids per workspace cwd", () => {
    const storage = memoryStorage();
    const memory = new SessionStorageTerminalSelectionMemory(storage);
    memory.rememberTerminal("local:/repo", "t1");
    memory.rememberTerminal("remote:/repo", "t2");

    const restored = new SessionStorageTerminalSelectionMemory(storage);

    expect(restored.latestTerminalId("local:/repo")).toBe("t1");
    restored.forgetTerminal("t1");
    expect(new SessionStorageTerminalSelectionMemory(storage).latestTerminalId("local:/repo")).toBeUndefined();
    expect(new SessionStorageTerminalSelectionMemory(storage).latestTerminalId("remote:/repo")).toBe("t2");
  });
});

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
