import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import { ProjectService } from "../projects/projectService.js";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { ProjectStore } from "../storage/projectStore.js";
import type { Project, Workspace } from "../types.js";
import { registerWorkspaceDeletionRoutes } from "./workspaceDeletionRoutes.js";
import { WorkspaceService } from "./workspaceService.js";

let app: FastifyInstance;
let daemonRequests: DaemonRequest[];
let closeStatusCode: number;

const project: Project = {
  id: "p1",
  name: "Project",
  path: "/repo",
  createdAt: "2026-05-25T00:00:00.000Z",
};

const mainWorkspace: Workspace = {
  id: "main",
  projectId: project.id,
  path: "/repo",
  label: "main",
  branch: "main",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

const targetWorkspace: Workspace = {
  id: "feature",
  projectId: project.id,
  path: "/repo/feature path",
  label: "feature",
  branch: "feature/branch",
  vcs: "git",
  isMain: false,
  isGitRepo: true,
  isGitWorktree: true,
};

const jjWorkspace: Workspace = {
  id: "jj-feature",
  projectId: project.id,
  path: "/repo/jj feature",
  label: "agent feature",
  vcs: "jj",
  vcsWorkspaceName: "agent feature",
  isMain: false,
  isGitRepo: false,
  isGitWorktree: false,
};

beforeEach(() => {
  app = Fastify({ logger: false });
  daemonRequests = [];
  closeStatusCode = 200;
  registerWorkspaceDeletionRoutes(app, fakeProjects(), fakeWorkspaces([mainWorkspace, targetWorkspace, jjWorkspace]), fakeDaemon(), "/api", { validateDeletion: () => Promise.resolve() });
});

afterEach(async () => {
  await app.close();
});

describe("workspace deletion routes", () => {
  it("closes target workspace terminals before starting deletion from the main workspace", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(200);
    expect(response.json<TerminalCommandRun>()).toMatchObject({ id: "run1", workspaceId: "main", terminalId: "terminal1", status: "running" });
    expect(daemonRequests).toEqual([
      { method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}` },
      {
        method: "POST",
        path: "/terminal-command-runs",
        body: {
          origin: "core",
          projectId: "p1",
          workspaceId: "main",
          cwd: "/repo",
          title: "Delete workspace: feature/branch",
          command: "git worktree remove '/repo/feature path'",
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": "feature",
            "target.workspacePath": "/repo/feature path",
          },
        },
      },
    ]);
  });

  it("forgets and removes a secondary Jujutsu workspace", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/jj-feature" });

    expect(response.statusCode).toBe(200);
    expect(daemonRequests[0]).toEqual({ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(jjWorkspace.path)}` });
    expect(daemonRequests[1]).toMatchObject({ method: "POST", path: "/terminal-command-runs" });
    expect(daemonRequests[1]?.body).toMatchObject({
      cwd: "/repo",
      title: "Delete workspace: agent feature",
      command: "jj -R '/repo' workspace forget 'agent feature'",
    });
  });

  it("does not start deletion when terminal cleanup fails", async () => {
    closeStatusCode = 500;

    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/feature" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Failed to close workspace terminals: cleanup failed" });
    expect(daemonRequests).toEqual([{ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(targetWorkspace.path)}` }]);
  });

  it("rejects main workspace deletion before touching terminals", async () => {
    const response = await app.inject({ method: "DELETE", url: "/api/projects/p1/workspaces/main" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Only secondary Git worktrees or Jujutsu workspaces can be deleted" });
    expect(daemonRequests).toEqual([]);
  });
});

interface DaemonRequest {
  method: string;
  path: string;
  body?: unknown;
}

function fakeProjects(): ProjectService {
  return new FakeProjectService();
}

function fakeWorkspaces(workspaces: Workspace[]): WorkspaceService {
  return new FakeWorkspaceService(workspaces);
}

class FakeProjectService extends ProjectService {
  constructor() {
    super(new ProjectStore("/dev/null"));
  }

  override requireProject(projectId: string): Promise<Project> {
    return projectId === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found"));
  }
}

class FakeWorkspaceService extends WorkspaceService {
  constructor(private readonly workspaces: Workspace[]) {
    super();
  }

  override list(): Promise<Workspace[]> {
    return Promise.resolve(this.workspaces);
  }
}

function fakeDaemon(): SessionProxyDaemon {
  return {
    request: (method, path, body) => {
      daemonRequests.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (method === "DELETE") {
        return Promise.resolve({
          statusCode: closeStatusCode,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(closeStatusCode === 200 ? { closed: true } : { error: "cleanup failed" }),
        });
      }
      return Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "run1",
          origin: "core",
          projectId: project.id,
          workspaceId: mainWorkspace.id,
          terminalId: "terminal1",
          title: "Delete workspace: feature/branch",
          command: "git worktree remove '/repo/feature path'",
          status: "running",
          createdAt: "2026-05-25T00:00:00.000Z",
          metadata: {
            "pi.operation": "workspace.delete",
            "target.workspaceId": targetWorkspace.id,
            "target.workspacePath": targetWorkspace.path,
          },
        } satisfies TerminalCommandRun),
      });
    },
    connectWebSocket: () => { throw new Error("WebSocket not configured for test"); },
  };
}
