import { describe, expect, it } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { Machine, Project, SessionInfo, Workspace } from "../api";
import type { KeyValueStorage } from "./sessionStorageMemory";
import { emptyMachineNavigationSnapshot, InMemoryMachineNavigationMemory, machineNavigationSnapshotFromState, routeFromMachineNavigationSnapshot, SessionStorageMachineNavigationMemory } from "./machineNavigationMemory";

describe("InMemoryMachineNavigationMemory", () => {
  it("remembers independent navigation snapshots per machine", () => {
    const memory = new InMemoryMachineNavigationMemory();

    memory.remember({ machineId: "local", projectId: "local-project", surface: { selectedFilePath: "README.md" } });
    memory.remember({ machineId: "remote", projectId: "remote-project", workspaceId: "remote-workspace", sessionId: "remote-session", surface: {} });

    expect(memory.latest("local")?.projectId).toBe("local-project");
    expect(memory.latest("remote")?.workspaceId).toBe("remote-workspace");

    memory.forget("local");

    expect(memory.latest("local")).toBeUndefined();
    expect(memory.latest("remote")?.projectId).toBe("remote-project");
  });

  it("returns cloned snapshots so callers cannot mutate memory", () => {
    const memory = new InMemoryMachineNavigationMemory();

    memory.remember({ machineId: "local", surface: { selectedFilePath: "README.md" } });
    const snapshot = memory.latest("local");
    if (snapshot !== undefined) snapshot.surface.selectedFilePath = "changed.ts";

    expect(memory.latest("local")?.surface.selectedFilePath).toBe("README.md");
  });
});

describe("SessionStorageMachineNavigationMemory", () => {
  it("persists independent navigation snapshots in per-tab storage", () => {
    const storage = memoryStorage();
    const memory = new SessionStorageMachineNavigationMemory(storage);

    memory.remember({ machineId: "local", projectId: "local-project", surface: { selectedFilePath: "README.md" } });
    memory.remember({ machineId: "remote", projectId: "remote-project", workspaceId: "remote-workspace", sessionId: "remote-session", surface: {} });

    const restored = new SessionStorageMachineNavigationMemory(storage);

    expect(restored.latest("local")?.projectId).toBe("local-project");
    expect(restored.latest("remote")?.workspaceId).toBe("remote-workspace");

    restored.forget("local");

    expect(new SessionStorageMachineNavigationMemory(storage).latest("local")).toBeUndefined();
    expect(new SessionStorageMachineNavigationMemory(storage).latest("remote")?.projectId).toBe("remote-project");
  });

  it("ignores malformed stored snapshots", () => {
    const storage = memoryStorage({
      "pi-web:machine-navigation:v1": JSON.stringify({ version: 1, entries: [["local", { machineId: "local", tool: "bad", surface: { selectedFilePath: "README.md" } }], ["remote", { projectId: "missing-machine", surface: {} }]] }),
    });

    const memory = new SessionStorageMachineNavigationMemory(storage);

    expect(memory.latest("local")?.tool).toBeUndefined();
    expect(memory.latest("local")?.surface.selectedFilePath).toBe("README.md");
    expect(memory.latest("remote")).toBeUndefined();
  });

  it("retains qualified legacy panel ids for plugin route migration", () => {
    const storage = memoryStorage({
      "pi-web:machine-navigation:v1": JSON.stringify({ version: 1, entries: [["local", {
        machineId: "local",
        tool: "core:workspace.git",
        view: "core:workspace.git",
        surface: {},
      }]] }),
    });

    const snapshot = new SessionStorageMachineNavigationMemory(storage).latest("local");

    expect(snapshot?.tool).toBe("core:workspace.git");
    expect(snapshot?.view).toBe("core:workspace.git");
  });
});

describe("machineNavigationSnapshotFromState", () => {
  it("captures the selected machine location and workspace surface", () => {
    const state: AppState = {
      ...initialAppState(),
      selectedMachine: machine("remote"),
      selectedProject: project("project"),
      selectedWorkspace: workspace("workspace", "project"),
      selectedSession: session("session"),
      workspaceTool: "core:workspace.files",
      mainView: "core:workspace.files",
      selectedFilePath: "src/main.ts",
      selectedTerminalId: "terminal-1",
    };

    expect(machineNavigationSnapshotFromState(state)).toEqual({
      machineId: "remote",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: "session",
      tool: "core:workspace.files",
      view: "core:workspace.files",
      surface: {
        selectedFilePath: "src/main.ts",
        selectedTerminalId: "terminal-1",
      },
    });
  });

  it("does not carry workspace surface without a selected workspace", () => {
    const state: AppState = {
      ...initialAppState(),
      selectedFilePath: "src/main.ts",
      selectedTerminalId: "terminal-1",
    };

    expect(machineNavigationSnapshotFromState(state).surface).toEqual({
      selectedFilePath: undefined,
      selectedTerminalId: undefined,
    });
  });
});

describe("routeFromMachineNavigationSnapshot", () => {
  it("converts navigation snapshots to URL routes", () => {
    expect(routeFromMachineNavigationSnapshot({
      machineId: "remote",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: "session",
      tool: "git:workspace.git",
      view: "navigation",
      surface: {},
    })).toEqual({
      machineId: "remote",
      projectId: "project",
      workspaceId: "workspace",
      sessionId: "session",
      tool: "git:workspace.git",
      view: undefined,
    });
  });

  it("creates an empty machine-only snapshot", () => {
    expect(emptyMachineNavigationSnapshot("remote")).toEqual({ machineId: "remote", surface: {} });
  });
});

function machine(id: string): Machine {
  return { id, name: id, kind: id === "local" ? "local" : "remote", createdAt: "now", updatedAt: "now" };
}

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, createdAt: "now" };
}

function workspace(id: string, projectId: string): Workspace {
  return { id, projectId, path: `/tmp/${projectId}/${id}`, label: id, isMain: true, effectiveConfig: {} };
}

function session(id: string): SessionInfo {
  return { id, path: `/tmp/project/.pi/sessions/${id}`, cwd: "/tmp/project", created: "now", modified: "now", messageCount: 0, firstMessage: "" };
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
