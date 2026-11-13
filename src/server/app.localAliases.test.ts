import { describe, expect, it } from "vitest";
import type { Project, WorkspaceProviderResolution } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp local machine aliases", () => {
  it("serves local session proxy routes through machine-scoped aliases", async () => {
    const sessionsResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` });

    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()).toEqual({ method: "GET", path: `/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` });
    expect(appTestContext.sessionDaemonRequests).toEqual([{ method: "GET", path: `/sessions?cwd=${encodeURIComponent(appTestContext.projectDir)}` }]);
  });

  it.each(["/api", "/api/machines/local"])("forwards MCP reads and toggles from %s to the local daemon", async (prefix) => {
    const path = `/mcp/managed?cwd=${encodeURIComponent(appTestContext.projectDir)}&sessionId=session-1`;
    const read = await appTestContext.app.inject({ method: "GET", url: `${prefix}${path}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ method: "GET", path });

    const body = { cwd: appTestContext.projectDir, sessionId: "session-1", scope: "session", serverName: "docs", enabled: true, revision: "revision-1" };
    const write = await appTestContext.app.inject({ method: "POST", url: `${prefix}/mcp/managed`, payload: body });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toEqual({ method: "POST", path: "/mcp/managed", body });
    expect(appTestContext.sessionDaemonRequests).toEqual([
      { method: "GET", path },
      { method: "POST", path: "/mcp/managed", body },
    ]);
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
