import { describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceListing } from "../types.js";
import { CachedWorkspaceAttribution } from "./workspaceAttribution.js";

describe("CachedWorkspaceAttribution", () => {
  it("attributes a cwd to its workspace and project without the project being visited", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({
      "project-1": ["/srv/dev/pi-web", "/srv/dev/pi-web-feature"],
    }));

    const resolved = await attribution.attribute(["/srv/dev/pi-web-feature"]);

    expect(resolved.get("/srv/dev/pi-web-feature")).toEqual({
      projectId: "project-1",
      workspaceId: "project-1-workspace-1",
    });
  });

  it("attributes a workspace outside its project directory to that project", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({
      "project-1": ["/srv/dev/project-1", "/srv/worktrees/detached"],
    }));

    const resolved = await attribution.attribute(["/srv/worktrees/detached"]);

    expect(resolved.get("/srv/worktrees/detached")).toEqual({
      projectId: "project-1",
      workspaceId: "project-1-workspace-1",
    });
  });

  it("omits a cwd that belongs to no known workspace", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({ "project-1": ["/srv/dev/project-1"] }));

    const resolved = await attribution.attribute(["/home/user/scratch", "/srv/dev/project-1"]);

    expect(resolved.has("/home/user/scratch")).toBe(false);
    expect(resolved.has("/srv/dev/project-1")).toBe(true);
  });

  it("attributes a cwd inside a workspace to the deepest workspace containing it", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({
      "project-1": ["/srv/dev/project-1", "/srv/dev/project-1/nested"],
    }));

    const resolved = await attribution.attribute(["/srv/dev/project-1/nested/src", "/srv/dev/project-1/src"]);

    expect(resolved.get("/srv/dev/project-1/nested/src")?.workspaceId).toBe("project-1-workspace-1");
    expect(resolved.get("/srv/dev/project-1/src")?.workspaceId).toBe("project-1-workspace-0");
  });

  it("does not attribute a sibling path that only shares a prefix", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({ "project-1": ["/srv/dev/wt1"] }));

    const resolved = await attribution.attribute(["/srv/dev/wt10"]);

    expect(resolved.size).toBe(0);
  });

  it("matches a cwd that differs from the workspace path only by normalization", async () => {
    const attribution = new CachedWorkspaceAttribution(dependencies({ "project-1": ["/srv/dev/project-1"] }));

    const resolved = await attribution.attribute(["/srv/dev/project-1/"]);

    expect(resolved.get("/srv/dev/project-1/")?.projectId).toBe("project-1");
  });

  it("lists workspace providers once per cache window instead of once per status change", async () => {
    const deps = dependencies({ "project-1": ["/srv/dev/project-1"] });
    const attribution = new CachedWorkspaceAttribution(deps);

    await attribution.attribute(["/srv/dev/project-1"]);
    await attribution.attribute(["/srv/dev/project-1"]);

    expect(deps.workspaces.list).toHaveBeenCalledTimes(1);
  });

  it("shares one listing pass between concurrent callers", async () => {
    const deps = dependencies({ "project-1": ["/srv/dev/project-1"] });
    const attribution = new CachedWorkspaceAttribution(deps);

    await Promise.all([
      attribution.attribute(["/srv/dev/project-1"]),
      attribution.attribute(["/srv/dev/project-1"]),
    ]);

    expect(deps.workspaces.list).toHaveBeenCalledTimes(1);
  });

  it("re-lists after a mutation invalidates the cache", async () => {
    const deps = dependencies({ "project-1": ["/srv/dev/project-1"] });
    const attribution = new CachedWorkspaceAttribution(deps);

    await attribution.attribute(["/srv/dev/project-1"]);
    attribution.invalidate();
    await attribution.attribute(["/srv/dev/project-1"]);

    expect(deps.workspaces.list).toHaveBeenCalledTimes(2);
  });

  it("picks up a workspace created outside this process once the cache window expires", async () => {
    const paths: Record<string, string[]> = { "project-1": ["/srv/dev/project-1"] };
    let clock = 1_000;
    const deps = dependencies(paths, { topologyTtlMs: 5_000, now: () => clock });
    const attribution = new CachedWorkspaceAttribution(deps);

    await attribution.attribute(["/srv/dev/project-1"]);
    paths["project-1"] = ["/srv/dev/project-1", "/srv/dev/project-1-hotfix"];
    expect((await attribution.attribute(["/srv/dev/project-1-hotfix"])).size).toBe(0);

    clock += 5_000;

    expect((await attribution.attribute(["/srv/dev/project-1-hotfix"])).size).toBe(1);
  });

  it("logs a provider listing failure and keeps attributing other projects", async () => {
    const deps = dependencies({ "project-1": ["/srv/dev/project-1"], "project-2": ["/srv/dev/project-2"] });
    deps.workspaces.list.mockImplementation((project: Project) => (project.id === "project-1"
      ? Promise.reject(new Error("provider offline"))
      : Promise.resolve(workspacesFor(project, ["/srv/dev/project-2"]))));
    const attribution = new CachedWorkspaceAttribution(deps);

    const resolved = await attribution.attribute(["/srv/dev/project-1", "/srv/dev/project-2"]);

    expect(resolved.has("/srv/dev/project-1")).toBe(false);
    expect(resolved.get("/srv/dev/project-2")?.projectId).toBe("project-2");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
      "workspace attribution could not list workspaces for a project",
    );
  });

  it("logs a failing project listing and does not retry it within the cache window", async () => {
    const deps = dependencies({});
    deps.projects.list.mockRejectedValue(new Error("projects.json unreadable"));
    const attribution = new CachedWorkspaceAttribution(deps);

    expect((await attribution.attribute(["/srv/dev/project-1"])).size).toBe(0);
    expect((await attribution.attribute(["/srv/dev/project-1"])).size).toBe(0);

    expect(deps.projects.list).toHaveBeenCalledTimes(1);
    const [details, message] = deps.logger.warn.mock.calls[0] ?? [];
    expect(message).toBe("workspace attribution could not list projects");
    expect(details?.["err"]).toBeInstanceOf(Error);
  });

  it("resolves nothing without listing anything when no cwd is active", async () => {
    const deps = dependencies({ "project-1": ["/srv/dev/project-1"] });
    const attribution = new CachedWorkspaceAttribution(deps);

    expect((await attribution.attribute([])).size).toBe(0);
    expect(deps.projects.list).not.toHaveBeenCalled();
  });
});

interface AttributionOptions {
  topologyTtlMs?: number;
  now?: () => number;
}

function dependencies(pathsByProjectId: Record<string, string[]>, options: AttributionOptions = {}) {
  return {
    projects: {
      list: vi.fn(() => Promise.resolve(Object.keys(pathsByProjectId).map(project))),
    },
    workspaces: {
      list: vi.fn((candidate: Project) => Promise.resolve(workspacesFor(candidate, pathsByProjectId[candidate.id] ?? []))),
    },
    logger: { warn: vi.fn<(details: Record<string, unknown>, message: string) => void>() },
    ...options,
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
