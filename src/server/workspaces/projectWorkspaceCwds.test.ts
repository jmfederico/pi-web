import { describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceListing } from "../types.js";
import { RegisteredProjectWorkspaceCwds } from "./projectWorkspaceCwds.js";

describe("RegisteredProjectWorkspaceCwds", () => {
  it("returns every workspace path of the project containing the cwd", async () => {
    const locator = new RegisteredProjectWorkspaceCwds(deps({
      "project-1": ["/srv/dev/pi-web", "/srv/dev/pi-web-feature"],
      "project-2": ["/srv/dev/other"],
    }));

    expect(await locator.forCwd("/srv/dev/pi-web-feature")).toEqual(["/srv/dev/pi-web", "/srv/dev/pi-web-feature"]);
  });

  it("returns undefined when no registered project contains the cwd", async () => {
    const locator = new RegisteredProjectWorkspaceCwds(deps({ "project-1": ["/srv/dev/pi-web"] }));

    expect(await locator.forCwd("/srv/dev/unregistered")).toBeUndefined();
  });

  it("matches a cwd that differs from the stored workspace path only by normalization", async () => {
    const locator = new RegisteredProjectWorkspaceCwds(deps({ "project-1": ["/srv/dev/pi-web"] }));

    expect(await locator.forCwd("/srv/dev/pi-web/")).toEqual(["/srv/dev/pi-web"]);
  });

  it("stops listing workspaces once the owning project is found", async () => {
    const workspaceLister = vi.fn((project: Project) => Promise.resolve(workspacesFor(project, ["/srv/dev/pi-web"])));
    const locator = new RegisteredProjectWorkspaceCwds({
      projects: { list: () => Promise.resolve([project("project-1"), project("project-2")]) },
      workspaces: { list: workspaceLister },
    });

    await locator.forCwd("/srv/dev/pi-web");

    expect(workspaceLister).toHaveBeenCalledTimes(1);
  });
});

function deps(pathsByProjectId: Record<string, string[]>) {
  const projects = Object.keys(pathsByProjectId).map(project);
  return {
    projects: { list: () => Promise.resolve(projects) },
    workspaces: { list: (candidate: Project) => Promise.resolve(workspacesFor(candidate, pathsByProjectId[candidate.id] ?? [])) },
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/srv/dev/${id}`, createdAt: "2026-07-28T00:00:00.000Z" };
}

function workspacesFor(owner: Project, paths: string[]): WorkspaceListing[] {
  return paths.map((path, index) => ({
    id: `${owner.id}-workspace-${String(index)}`,
    projectId: owner.id,
    path,
    label: path,
    isMain: index === 0,
  }));
}
