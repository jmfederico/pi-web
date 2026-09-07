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
