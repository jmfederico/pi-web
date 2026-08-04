import { describe, expect, it } from "vitest";
import type { Project, WorkspaceProviderResolution } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp local machine aliases", () => {
  it("serves local session and terminal proxy routes through machine-scoped aliases", async () => {
    const sessionsResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()).toEqual({ method: "GET", path: `/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` });
    expect(appTestContext.sessionDaemonRequests).toEqual([{ method: "GET", path: `/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` }]);

    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines/local/projects",
      payload: { name: "Machine Local", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces` });
    const workspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (workspace === undefined) throw new Error("Expected workspace");

    const terminalResponse = await appTestContext.app.inject({
      method: "POST",
      url: `/api/machines/local/projects/${project.id}/workspaces/${workspace.id}/terminal-command-runs`,
      payload: { origin: "core", title: "Build", command: "npm test", metadata: { "pi.operation": "test" } },
    });

    const closeTerminalsResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/machines/local/projects/${project.id}/workspaces/${workspace.id}/terminals` });

    expect(terminalResponse.statusCode).toBe(200);
    expect(terminalResponse.json()).toEqual({
      method: "POST",
      path: "/terminal-command-runs",
      body: {
        origin: "core",
        projectId: project.id,
        workspaceId: workspace.id,
        cwd: appTestContext.projectDir,
        title: "Build",
        command: "npm test",
        metadata: { "pi.operation": "test" },
      },
    });
    expect(closeTerminalsResponse.statusCode).toBe(200);
    expect(closeTerminalsResponse.json()).toEqual({ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(appTestContext.projectDir)}` });
    expect(appTestContext.sessionDaemonRequests[1]).toEqual({
      method: "POST",
      path: "/terminal-command-runs",
      body: {
        origin: "core",
        projectId: project.id,
        workspaceId: workspace.id,
        cwd: appTestContext.projectDir,
        title: "Build",
        command: "npm test",
        metadata: { "pi.operation": "test" },
      },
    });
    expect(appTestContext.sessionDaemonRequests[2]).toEqual({ method: "DELETE", path: `/terminals?cwd=${encodeURIComponent(appTestContext.projectDir)}` });
  });

  it("does not proxy terminals for a workspace removed from the daemon authority", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Stale", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const staleWorkspace = workspacesResponse.json<WorkspaceProviderResolution>().workspaces[0];
    if (staleWorkspace === undefined) throw new Error("Expected workspace");
    appTestContext.workspaceCatalog.set(project.id, [{
      ...staleWorkspace,
      id: "replacement",
      path: appTestContext.tempDir,
      label: "replacement",
    }]);

    const response = await appTestContext.app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/workspaces/${staleWorkspace.id}/terminals`,
      payload: { name: "shell" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Workspace not found" });
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("serves local projects and workspaces through machine-scoped aliases", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/machines/local/projects",
      payload: { name: "Machine Local", path: appTestContext.projectDir, create: true },
    });
    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();

    const listResponse = await appTestContext.app.inject({ method: "GET", url: "/api/machines/local/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Project[]>()).toEqual([project]);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces` });
    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceProviderResolution>()).toMatchObject({
      status: "folder",
      projectId: project.id,
      diagnostics: [],
      workspaces: [expect.objectContaining({ projectId: project.id, path: appTestContext.projectDir })],
    });
  });
});
