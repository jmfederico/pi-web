import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_FILE_VIEW_MODE,
  WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY,
  adoptWorkspaceFileViewMode,
  parseWorkspaceFileViewMode,
  publishWorkspaceFileViewMode,
  readStoredWorkspaceFileViewMode,
  type WorkspaceFileViewMode,
  type WorkspaceFileViewModeRoute,
  type WorkspaceFileViewModeStorage,
} from "./workspaceFileViewMode";

describe("workspace file view mode", () => {
  it("defaults to raw source", () => {
    expect(DEFAULT_WORKSPACE_FILE_VIEW_MODE).toBe("raw");
    expect(adoptWorkspaceFileViewMode(fakeRoute(), fakeStorage())).toBe("raw");
  });

  it("accepts only the two known modes", () => {
    expect(parseWorkspaceFileViewMode("raw")).toBe("raw");
    expect(parseWorkspaceFileViewMode("preview")).toBe("preview");
    for (const value of ["", "RAW", "html", "1", null, undefined]) {
      expect(parseWorkspaceFileViewMode(value)).toBeUndefined();
    }
  });

  it("restores the stored device preference when no link specifies a mode", () => {
    const storage = fakeStorage({ [WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY]: "preview" });
    expect(adoptWorkspaceFileViewMode(fakeRoute(), storage)).toBe("preview");
  });

  it("lets a deep link win and adopts it as the device preference", () => {
    const storage = fakeStorage({ [WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY]: "raw" });
    expect(adoptWorkspaceFileViewMode(fakeRoute("preview"), storage)).toBe("preview");
    expect(readStoredWorkspaceFileViewMode(storage)).toBe("preview");
  });

  it("falls back to the stored preference when a link carries an unusable mode", () => {
    const storage = fakeStorage({ [WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY]: "preview" });
    expect(adoptWorkspaceFileViewMode(fakeRoute("rendered"), storage)).toBe("preview");
  });

  it("ignores an unusable stored value rather than trusting it", () => {
    const storage = fakeStorage({ [WORKSPACE_FILE_VIEW_MODE_STORAGE_KEY]: "rendered" });
    expect(readStoredWorkspaceFileViewMode(storage)).toBeUndefined();
    expect(adoptWorkspaceFileViewMode(fakeRoute(), storage)).toBe("raw");
  });

  it("publishes the displayed mode to both the address bar and storage", () => {
    const storage = fakeStorage();
    const route = fakeRoute();
    publishWorkspaceFileViewMode("preview", route, storage);
    expect(route.written).toEqual(["preview"]);
    expect(readStoredWorkspaceFileViewMode(storage)).toBe("preview");
  });

  it("keeps working when storage is unavailable or refuses writes", () => {
    expect(adoptWorkspaceFileViewMode(fakeRoute(), undefined)).toBe("raw");
    expect(adoptWorkspaceFileViewMode(fakeRoute("preview"), undefined)).toBe("preview");
    expect(readStoredWorkspaceFileViewMode(unavailableStorage())).toBeUndefined();

    const route = fakeRoute();
    expect(() => { publishWorkspaceFileViewMode("preview", route, unavailableStorage()); }).not.toThrow();
    expect(route.written).toEqual(["preview"]);
  });
});

interface FakeRoute extends WorkspaceFileViewModeRoute {
  written: WorkspaceFileViewMode[];
}

function fakeRoute(linked?: string): FakeRoute {
  const written: WorkspaceFileViewMode[] = [];
  return {
    written,
    read: () => linked,
    write: (mode) => { written.push(mode); },
  };
}

function fakeStorage(initial: Record<string, string> = {}): WorkspaceFileViewModeStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

/** Private-mode browsers throw on both reads and writes. */
function unavailableStorage(): WorkspaceFileViewModeStorage {
  return {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  };
}
