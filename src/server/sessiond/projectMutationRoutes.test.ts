import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectService } from "../projects/projectService.js";
import { registerProjectMutationRoutes } from "./projectMutationRoutes.js";

let app: FastifyInstance;
const projects = { add: vi.fn<ProjectService["add"]>(), updateSettings: vi.fn<ProjectService["updateSettings"]>(), close: vi.fn<ProjectService["close"]>() };

beforeEach(() => {
  vi.resetAllMocks();
  app = Fastify({ logger: false });
  registerProjectMutationRoutes(app, projects);
});
afterEach(async () => { await app.close(); });

describe("daemon project mutations", () => {
  it("delegates add input and returns the project", async () => {
    const project = { id: "project-1", name: "Repo", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };
    projects.add.mockResolvedValue(project);
    const input = { name: "Repo", path: "/repo", create: true };
    const response = await app.inject({ method: "POST", url: "/projects", payload: input });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(project);
    expect(projects.add).toHaveBeenCalledExactlyOnceWith(input);
  });

  it.each([{}, { path: 3 }, { path: " " }, { path: "/repo", create: "yes" }, { path: "/repo", name: 3 }])("rejects invalid input %j before calling the service", async (payload) => {
    const response = await app.inject({ method: "POST", url: "/projects", payload });
    expect(response.statusCode).toBe(400);
    expect(projects.add).not.toHaveBeenCalled();
  });

  it.each([
    [new Error("Project path must be a directory"), 400],
    [Object.assign(new Error("Missing path"), { code: "ENOENT" }), 400],
    [new Error("Catalog reconciliation failed"), 500],
  ])("maps add error %s to %s", async (error, status) => {
    projects.add.mockRejectedValue(error);
    const response = await app.inject({ method: "POST", url: "/projects", payload: { path: "/repo" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: error.message });
  });

  it("delegates rename and returns the project", async () => {
    const project = { id: "project 1", name: "Billing", path: "/repo", createdAt: "2026-01-01T00:00:00.000Z" };
    projects.updateSettings.mockResolvedValue(project);
    const response = await app.inject({ method: "PATCH", url: "/projects/project%201", payload: { name: "Billing" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(project);
    expect(projects.updateSettings).toHaveBeenCalledExactlyOnceWith("project 1", { set: { name: "Billing" } });
  });

  it.each([{}, { name: 3 }, { name: null }, { set: { worktreeFolder: " " } }, { set: { path: "/other" } }, { unset: ["/name"] }, { set: { worktreeFolder: "elsewhere" }, unset: ["/worktreeFolder"] }])("rejects invalid project settings %j before calling the service", async (payload) => {
    const response = await app.inject({ method: "PATCH", url: "/projects/project-1", payload });
    expect(response.statusCode).toBe(400);
    expect(projects.updateSettings).not.toHaveBeenCalled();
  });

  it.each([["Project not found", 404], ["Catalog unreadable", 500]])("maps rename error %s to %s", async (message, status) => {
    projects.updateSettings.mockRejectedValue(new Error(message));
    const response = await app.inject({ method: "PATCH", url: "/projects/project-1", payload: { name: "Billing" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: message });
  });

  it("guards environment-controlled worktree folders without blocking name changes", async () => {
    const locked = Fastify({ logger: false });
    registerProjectMutationRoutes(locked, projects, "PI_WEB_DEFAULT_WORKTREE_FOLDER");
    try {
      for (const payload of [{ set: { worktreeFolder: "trees" } }, { unset: ["/worktreeFolder"] }]) {
        const response = await locked.inject({ method: "PATCH", url: "/projects/project-1", payload });
        expect(response.statusCode).toBe(400);
        expect(response.json<{ error: string }>().error).toContain("PI_WEB_DEFAULT_WORKTREE_FOLDER");
      }
      expect(projects.updateSettings).not.toHaveBeenCalled();
      projects.updateSettings.mockResolvedValue({ id: "project-1", name: "Renamed", path: "/repo", createdAt: "" });
      const renamed = await locked.inject({ method: "PATCH", url: "/projects/project-1", payload: { set: { name: "Renamed" } } });
      expect(renamed.statusCode).toBe(200);
    } finally {
      await locked.close();
    }
  });

  it("delegates close and confirms completion", async () => {
    projects.close.mockResolvedValue(undefined);
    const response = await app.inject({ method: "DELETE", url: "/projects/project%201" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closed: true });
    expect(projects.close).toHaveBeenCalledExactlyOnceWith("project 1");
  });

  it.each([["Project not found", 404], ["Catalog reconciliation failed", 500]])("maps close error %s to %s", async (message, status) => {
    projects.close.mockRejectedValue(new Error(message));
    const response = await app.inject({ method: "DELETE", url: "/projects/project-1" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: message });
  });
});
