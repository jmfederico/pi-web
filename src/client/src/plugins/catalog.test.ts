import { describe, expect, it, vi } from "vitest";
import { createPluginCatalog, type PluginCatalogRequester } from "./catalog";

const metadata = { created: null, modified: null, archivedAt: null, pinned: false };
const project = { id: "p/a", name: "Project", path: "/project" };
const workspace = { id: "w/b", projectId: project.id, path: "/project", label: "Main", isMain: true };

describe("machine-bound plugin catalogs", () => {
  it("captures the target and encodes every identifier without exposing private session data", async () => {
    const requester = vi.fn<PluginCatalogRequester>((path) => Promise.resolve(path.endsWith("/sessions/s%2Fc")
      ? { id: "s/c", cwd: "/project", ...metadata, archived: false, runtime: "not-hosted", path: "/private/session.jsonl", firstMessage: "secret" }
      : workspace));
    const catalog = createPluginCatalog("remote/a", undefined, requester);
    expect(await catalog.workspaces.get({ projectId: project.id, workspaceId: workspace.id })).toEqual(workspace);
    expect(await catalog.sessions.get({ projectId: project.id, workspaceId: workspace.id, sessionId: "s/c" })).toEqual({
      id: "s/c", cwd: "/project", ...metadata, archived: false, runtime: "not-hosted",
    });
    expect(requester.mock.calls.map(([path]) => path)).toEqual([
      "api/machines/remote%2Fa/plugin-catalog/projects/p%2Fa/workspaces/w%2Fb",
      "api/machines/remote%2Fa/plugin-catalog/projects/p%2Fa/workspaces/w%2Fb/sessions/s%2Fc",
    ]);
    expect(catalog.machineId).toBe("remote/a");
  });

  it("rejects mismatched host authority and never substitutes another machine", async () => {
    const requester = vi.fn<PluginCatalogRequester>(() => Promise.resolve({ ...project, id: "other" }));
    const catalog = createPluginCatalog("remote", undefined, requester);
    await expect(catalog.projects.get(project.id)).rejects.toThrow();
    expect(requester).toHaveBeenCalledTimes(1);
    expect(requester.mock.calls[0]?.[0]).toBe("api/machines/remote/plugin-catalog/projects/p%2Fa");
  });

  it("forwards caller cancellation and revokes retained catalogs with plugin lifetime", async () => {
    const lifetime = new AbortController();
    const caller = new AbortController();
    const requester = vi.fn<PluginCatalogRequester>(() => Promise.resolve([project]));
    const catalog = createPluginCatalog("local", lifetime.signal, requester);
    await catalog.projects.list({ signal: caller.signal });
    const signal = requester.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    caller.abort();
    expect(signal?.aborted).toBe(true);
    lifetime.abort();
    await expect(catalog.projects.list()).rejects.toThrow();
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
