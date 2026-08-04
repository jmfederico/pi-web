import { describe, expect, it } from "vitest";
import type { Workspace } from "../api";
import type { KeyValueStorage } from "./sessionStorageMemory";
import { InMemoryWorkspaceSelectionMemory, selectPreferredWorkspace, SessionStorageWorkspaceSelectionMemory } from "./workspaceSelection";

describe("selectPreferredWorkspace", () => {
  it("prefers an explicit target workspace", () => {
    const workspaces = [testWorkspace("main"), testWorkspace("feature")];

    expect(selectPreferredWorkspace(workspaces, { targetWorkspaceId: "feature", latestWorkspaceId: "main" })?.id).toBe("feature");
  });

  it("remembers the latest selected workspace when no explicit target is provided", () => {
    const workspaces = [testWorkspace("main"), testWorkspace("feature")];

    expect(selectPreferredWorkspace(workspaces, { latestWorkspaceId: "feature" })?.id).toBe("feature");
  });

  it("falls back to the first workspace when the remembered workspace no longer exists", () => {
    const workspaces = [testWorkspace("main"), testWorkspace("feature")];

    expect(selectPreferredWorkspace(workspaces, { latestWorkspaceId: "old" })?.id).toBe("main");
  });

  it("does not fall back to remembered workspace when the explicit target is invalid", () => {
    const workspaces = [testWorkspace("main"), testWorkspace("feature")];

    expect(selectPreferredWorkspace(workspaces, { targetWorkspaceId: "old", latestWorkspaceId: "feature" })).toBeUndefined();
  });
});

describe("InMemoryWorkspaceSelectionMemory", () => {
  it("remembers and forgets the latest selected workspace per project", () => {
    const memory = new InMemoryWorkspaceSelectionMemory();

    memory.rememberWorkspace({ ...testWorkspace("feature"), projectId: "p1" });
    memory.rememberWorkspace({ ...testWorkspace("other"), projectId: "p2" });

    expect(memory.latestWorkspaceId("p1")).toBe("feature");
    expect(memory.latestWorkspaceId("p2")).toBe("other");

    memory.forgetProject("p1");

    expect(memory.latestWorkspaceId("p1")).toBeUndefined();
    expect(memory.latestWorkspaceId("p2")).toBe("other");
  });
});

describe("SessionStorageWorkspaceSelectionMemory", () => {
  it("persists the latest selected workspace per project", () => {
    const storage = memoryStorage();
    const memory = new SessionStorageWorkspaceSelectionMemory(storage);

    memory.rememberWorkspace({ ...testWorkspace("feature"), projectId: "local:p1" });
    memory.rememberWorkspace({ ...testWorkspace("other"), projectId: "remote:p1" });

    const restored = new SessionStorageWorkspaceSelectionMemory(storage);

    expect(restored.latestWorkspaceId("local:p1")).toBe("feature");
    expect(restored.latestWorkspaceId("remote:p1")).toBe("other");

    restored.forgetProject("local:p1");

    expect(new SessionStorageWorkspaceSelectionMemory(storage).latestWorkspaceId("local:p1")).toBeUndefined();
    expect(new SessionStorageWorkspaceSelectionMemory(storage).latestWorkspaceId("remote:p1")).toBe("other");
  });
});

function testWorkspace(id: string): Workspace {
  return { id, projectId: "project", path: `/tmp/project/${id}`, label: id, isMain: id === "main", effectiveConfig: {} };
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
