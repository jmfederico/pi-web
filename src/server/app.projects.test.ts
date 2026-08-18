import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Project, WorkspaceProviderResolution } from "./types.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { WorkspaceCatalogUnavailableError } from "./workspaces/workspaceCatalog.js";

registerAppTestHooks();

describe("buildApp project routes", () => {
  it("adds, lists, and closes projects through the HTTP contract", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Example", path: appTestContext.projectDir, create: true },
    });

    expect(addResponse.statusCode).toBe(200);
    const project = addResponse.json<Project>();
    expect(project).toMatchObject({ name: "Example", path: appTestContext.projectDir });
    expect(project.id).not.toBe("");

    const listResponse = await appTestContext.app.inject({ method: "GET", url: "/api/projects" });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<Project[]>()).toEqual([project]);

    const closeResponse = await appTestContext.app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(closeResponse.statusCode).toBe(200);
    expect(closeResponse.json()).toEqual({ closed: true });

    const emptyListResponse = await appTestContext.app.inject({ method: "GET", url: "/api/projects" });
    expect(emptyListResponse.json<Project[]>()).toEqual([]);
  });

  it("returns stable errors for invalid project requests", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Missing", path: join(appTestContext.tempDir, "missing") },
    });

    expect(addResponse.statusCode).toBe(400);
    expect(addResponse.json()).toHaveProperty("error");

    const closeResponse = await appTestContext.app.inject({ method: "DELETE", url: "/api/projects/does-not-exist" });
    expect(closeResponse.statusCode).toBe(404);
    expect(closeResponse.json()).toEqual({ error: "Project not found" });
  });

  it("lists a non-git project as a single workspace", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Plain", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceProviderResolution>()).toMatchObject({
      status: "folder",
      projectId: project.id,
      diagnostics: [],
      workspaces: [expect.objectContaining({
        projectId: project.id,
        path: appTestContext.projectDir,
        label: "Plain",
        isMain: true,
      })],
    });
  });

  it("preserves provider ownership diagnostics while adding web-owned effective config", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Degraded", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    const current = await appTestContext.workspaceCatalog.resolveProject(project.id);
    appTestContext.workspaceCatalog.setResolution({
      status: "degraded",
      projectId: project.id,
      ownerPluginId: "replacement",
      workspaces: current.workspaces,
      diagnostics: [{
        code: "list-failed",
        message: "Replacement workspace listing failed",
        tier: "primary",
        pluginId: "replacement",
      }],
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceProviderResolution>()).toEqual({
      status: "degraded",
      projectId: project.id,
      ownerPluginId: "replacement",
      workspaces: [expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: ".pi-web/uploads" } },
      })],
      diagnostics: [{
        code: "list-failed",
        message: "Replacement workspace listing failed",
        tier: "primary",
        pluginId: "replacement",
      }],
    });
  });

  it("fails explicitly instead of discovering workspaces in web when sessiond authority is unavailable", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Unavailable", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    appTestContext.workspaceCatalog.fail(new WorkspaceCatalogUnavailableError("Session daemon workspace authority unavailable: connection refused"));

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });
    const localAliasResponse = await appTestContext.app.inject({ method: "GET", url: `/api/machines/local/projects/${project.id}/workspaces` });

    expect([response.statusCode, localAliasResponse.statusCode]).toEqual([503, 503]);
    expect(response.json()).toEqual({ error: "Session daemon workspace authority unavailable: connection refused" });
    expect(localAliasResponse.json()).toEqual(response.json());
  });

  it("exposes the default upload config on workspace responses", async () => {
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Upload Defaults", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceProviderResolution>()).toMatchObject({
      projectId: project.id,
      workspaces: [expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: ".pi-web/uploads" } },
      })],
    });
  });

  it("lets project-local upload config override global upload config on workspace responses", async () => {
    appTestContext.piWebConfig = { uploads: { defaultFolder: "global-uploads" } };
    const addResponse = await appTestContext.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Project Upload Defaults", path: appTestContext.projectDir, create: true },
    });
    const project = addResponse.json<Project>();
    await mkdir(join(appTestContext.projectDir, ".pi-web"), { recursive: true });
    await writeFile(join(appTestContext.projectDir, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, uploads: { defaultFolder: "project-uploads" } }, null, 2)}\n`);

    const workspacesResponse = await appTestContext.app.inject({ method: "GET", url: `/api/projects/${project.id}/workspaces` });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(workspacesResponse.json<WorkspaceProviderResolution>()).toMatchObject({
      projectId: project.id,
      workspaces: [expect.objectContaining({
        projectId: project.id,
        effectiveConfig: { uploads: { defaultFolder: "project-uploads" } },
      })],
    });
  });
});
