import { resolve } from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPluginCatalogRoutes } from "./pluginCatalogRoutes.js";

const repositoryPath = resolve("/repo");
const project = { id: "p1", name: "Project", path: repositoryPath, createdAt: "2026-01-01T00:00:00.000Z" };
const workspace = { id: "w1", projectId: project.id, path: repositoryPath, label: "Main", isMain: true };

describe("browser plugin catalog routes", () => {
  it("lists/resolves core objects using host authority and excludes private session data", async () => {
    const app = Fastify();
    const sessions = {
      listCatalogSessions: vi.fn(() => Promise.resolve([{ id: "s1", cwd: repositoryPath, archived: false, runtime: "not-hosted" as const, path: "/private", firstMessage: "private" }])),
      inspectionMessages: vi.fn(() => Promise.resolve({ messages: [], start: 0, total: 0 })),
    };
    registerPluginCatalogRoutes(app, {
      projects: { list: () => Promise.resolve([project]), requireProject: () => Promise.resolve(project) },
      workspaces: { resolve: () => Promise.resolve({ projectId: project.id, status: "provider" as const, diagnostics: [], workspaces: [workspace] }) },
      sessions,
    });
    try {
      const projects = await app.inject({ method: "GET", url: "/plugin-catalog/projects" });
      expect(projects.statusCode).toBe(200);
      expect(projects.json()).toEqual([{ id: "p1", name: "Project", path: repositoryPath }]);
      const response = await app.inject({ method: "GET", url: "/plugin-catalog/projects/p1/workspaces/w1/sessions/s1" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ id: "s1", cwd: repositoryPath, archived: false, runtime: "not-hosted" });
      expect(sessions.listCatalogSessions).toHaveBeenCalledTimes(1);
      const missing = await app.inject({ method: "GET", url: "/plugin-catalog/projects/p1/workspaces/stale/sessions" });
      expect(missing.statusCode).toBe(404);
      expect(sessions.listCatalogSessions).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
