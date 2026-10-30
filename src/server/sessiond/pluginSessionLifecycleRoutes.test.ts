import { resolve } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPluginSessionLifecycleRoutes } from "./pluginSessionLifecycleRoutes.js";

const cwd = resolve("/repo");
const base = "/plugin-sessions/projects/p/workspaces/w/sessions/child";

describe("plugin session lifecycle routes", () => {
  it("routes all commands through workspace authority, ignoring raw cwd inputs", async () => {
    const app = Fastify();
    const project = { id: "p", name: "Project", path: cwd, createdAt: "now" };
    const sessions = {
      listCatalogSessions: vi.fn(() => Promise.resolve([{ id: "child", cwd, created: null, modified: null, archivedAt: null, archived: true, runtime: "not-hosted" as const }])),
      archiveMany: vi.fn(() => Promise.resolve({ archived: true as const, archivedSessionIds: ["child"], failures: [], generatedAt: "now" })),
      restore: vi.fn(() => Promise.resolve()),
      deleteArchivedMany: vi.fn(() => Promise.resolve({ deleted: true as const, deletedSessionIds: ["child"], failures: [], generatedAt: "now" })),
    };
    const pins = { pinnedSessionIds: vi.fn(() => Promise.resolve(["child"])), setPinned: vi.fn(() => Promise.resolve()) };
    registerPluginSessionLifecycleRoutes(app, {
      projects: { requireProject: () => Promise.resolve(project) },
      workspaces: { resolve: () => Promise.resolve({ projectId: "p", status: "provider" as const, diagnostics: [], workspaces: [{ id: "w", projectId: "p", path: cwd, label: "Main", isMain: true }] }) },
      sessions, pins,
    });
    try {
      const state = await app.inject({ method: "GET", url: base });
      expect(state.statusCode).toBe(200);
      expect(state.headers["cache-control"]).toBe("no-store");
      expect(state.json()).toEqual({ sessionId: "child", pinned: true, archived: true });
      for (const action of ["pin", "unpin", "archive", "restore"]) {
        const response = await app.inject({ method: "POST", url: `${base}/${action}?cwd=/outside`, payload: { cwd: "/outside", sessionId: "other" } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
      }
      const deleted = await app.inject({ method: "DELETE", url: base });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ ok: true });
      expect(sessions.archiveMany).toHaveBeenCalledWith([{ id: "child", cwd }]);
      expect(sessions.restore).toHaveBeenCalledWith({ id: "child", cwd });
      expect(sessions.deleteArchivedMany).toHaveBeenCalledWith([{ id: "child", cwd }]);
      expect(pins.setPinned.mock.calls).toEqual([
        [{ kind: "session-pins", projectId: "p", workspaceId: "w" }, "child", true],
        [{ kind: "session-pins", projectId: "p", workspaceId: "w" }, "child", false],
      ]);
      expect((await app.inject({ method: "DELETE", url: base.replace("/w/", "/missing/") })).statusCode).toBe(404);
      sessions.listCatalogSessions.mockResolvedValueOnce([]);
      expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(404);
      sessions.deleteArchivedMany.mockResolvedValueOnce({ deleted: true, deletedSessionIds: [], failures: [], generatedAt: "now" });
      expect((await app.inject({ method: "DELETE", url: base })).statusCode).toBe(400);
      expect(sessions.deleteArchivedMany).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
