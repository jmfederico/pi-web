import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { Project } from "../types.js";
import { WorkspaceRemovalError } from "../workspaces/workspaceRemovalService.js";
import {
  registerWorkspaceRemovalRoutes,
  type WorkspaceRemover,
} from "./workspaceRemovalRoutes.js";

const project: Project = {
  id: "project one",
  name: "Project",
  path: "/repo",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const run: TerminalCommandRun = {
  id: "run-1",
  origin: "core",
  projectId: project.id,
  workspaceId: "main",
  terminalId: "terminal-1",
  title: "Remove workspace",
  command: "neutral detach workspace",
  status: "running",
  createdAt: "2026-07-27T00:00:00.000Z",
  metadata: { "pi.operation": "workspace.delete", "target.workspaceId": "linked" },
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("session daemon workspace removal routes", () => {
  it("resolves the registered project and returns the host-owned command run", async () => {
    const remove = vi.fn<WorkspaceRemover["remove"]>(() => Promise.resolve(run));
    const onWorkspacesMutated = vi.fn();
    registerWorkspaceRemovalRoutes(app, { projects: projectReader(), removals: { remove }, onWorkspacesMutated });

    const response = await app.inject({
      method: "DELETE",
      url: "/workspace-removals/projects/project%20one/workspaces/linked",
      payload: { precondition: "v1.confirmed" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TerminalCommandRun>()).toEqual(run);
    expect(remove).toHaveBeenCalledTimes(1);
    const call = remove.mock.calls[0];
    expect(call?.slice(0, 3)).toEqual([project, "linked", "v1.confirmed"]);
    expect(call?.[3]).toBeInstanceOf(AbortSignal);
    expect(call?.[3].aborted).toBe(false);
    expect(onWorkspacesMutated).toHaveBeenCalledTimes(1);
  });

  it("serializes project, safety, and unexpected failures without a stack", async () => {
    const remove = vi.fn()
      .mockRejectedValueOnce(new WorkspaceRemovalError("Workspace owner is no longer current", 409))
      .mockRejectedValueOnce(new Error("unexpected failure"));
    const onWorkspacesMutated = vi.fn();
    registerWorkspaceRemovalRoutes(app, { projects: projectReader(), removals: { remove }, onWorkspacesMutated });

    const payload = { precondition: "v1.confirmed" };
    const missing = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/missing/workspaces/linked", payload });
    const rejected = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/project%20one/workspaces/linked", payload });
    const failed = await app.inject({ method: "DELETE", url: "/workspace-removals/projects/project%20one/workspaces/linked", payload });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Project not found" });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: "Workspace owner is no longer current" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "unexpected failure" });
    expect(failed.body).not.toContain("stack");
    // A removal that reached the provider and then failed may still have
    // changed the workspace listing, so cached attribution is dropped too.
    expect(onWorkspacesMutated).toHaveBeenCalledTimes(2);
  });

  it("rejects an absent confirmation precondition before project or removal work", async () => {
    const requireProject = vi.fn(projectReader().requireProject);
    const remove = vi.fn(() => Promise.resolve(run));
    registerWorkspaceRemovalRoutes(app, { projects: { requireProject }, removals: { remove }, onWorkspacesMutated: vi.fn() });

    const response = await app.inject({
      method: "DELETE",
      url: "/workspace-removals/projects/project%20one/workspaces/linked",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("precondition");
    expect(requireProject).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

function projectReader() {
  return {
    requireProject: (projectId: string) => projectId === project.id
      ? Promise.resolve(project)
      : Promise.reject(new Error("Project not found")),
  };
}
