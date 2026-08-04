import { describe, expect, it } from "vitest";
import type { Project, SessionInfo, Workspace } from "./api";
import { parentSessionLocationLabel, parentSessionLocationTitle, resolveParentSessionLocation } from "./parentSessionLocation";

describe("resolveParentSessionLocation", () => {
  it("names and targets a parent living in a sibling worktree of the selected project", () => {
    const session = child({ parentSessionCwd: "/srv/dev/pi-web-feature", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({ workspaces: [mainWorkspace, featureWorkspace] }));

    expect(location).toEqual({
      kind: "workspace",
      label: "feature/parent-links",
      projectId: "project-1",
      workspaceId: "workspace-feature",
      sessionId: "parent-id",
      cwd: "/srv/dev/pi-web-feature",
    });
  });

  it("qualifies a parent in another loaded project with that project's name", () => {
    const otherWorkspace: Workspace = { ...featureWorkspace, id: "workspace-other", projectId: "project-2", path: "/srv/dev/other", branch: "main" };
    const session = child({ parentSessionCwd: "/srv/dev/other", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({
      workspaces: [mainWorkspace],
      workspacesByProjectId: { "project-2": [otherWorkspace] },
      projects: [{ id: "project-2", name: "other-project", path: "/srv/dev/other", createdAt: "2026-07-28T00:00:00.000Z" }],
    }));

    expect(location).toMatchObject({ kind: "workspace", label: "other-project · main", projectId: "project-2", workspaceId: "workspace-other" });
  });

  it("falls back to a shortened path when the parent cwd belongs to no loaded workspace", () => {
    const session = child({ parentSessionCwd: "/srv/dev/unknown/deeply/nested", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({ workspaces: [mainWorkspace] }));

    expect(location).toEqual({ kind: "path", label: "…/deeply/nested", cwd: "/srv/dev/unknown/deeply/nested" });
  });

  it("reports unknown when the server sent no parent cwd", () => {
    const location = resolveParentSessionLocation(child({}), sources({ workspaces: [mainWorkspace, featureWorkspace] }));

    expect(location).toEqual({ kind: "unknown" });
  });

  it("matches workspace paths that differ only by a trailing separator", () => {
    const session = child({ parentSessionCwd: "/srv/dev/pi-web-feature", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({ workspaces: [{ ...featureWorkspace, path: "/srv/dev/pi-web-feature/" }] }));

    expect(location).toMatchObject({ kind: "workspace", workspaceId: "workspace-feature" });
  });

  it("prefers the selected project's workspaces over another project with the same path", () => {
    const session = child({ parentSessionCwd: "/srv/dev/pi-web-feature", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({
      workspaces: [featureWorkspace],
      workspacesByProjectId: { "project-2": [{ ...featureWorkspace, id: "workspace-duplicate", projectId: "project-2" }] },
    }));

    expect(location).toMatchObject({ kind: "workspace", workspaceId: "workspace-feature", label: "feature/parent-links" });
  });

  it("labels a detached parent workspace by its workspace label when it has no branch", () => {
    const detached: Workspace = { ...featureWorkspace, label: "detached" };
    delete detached.branch;
    const session = child({ parentSessionCwd: "/srv/dev/pi-web-feature", parentSessionId: "parent-id" });

    const location = resolveParentSessionLocation(session, sources({ workspaces: [detached] }));

    expect(location).toMatchObject({ kind: "workspace", label: "detached" });
  });
});

describe("parentSessionLocationLabel", () => {
  it("names the parent's workspace for a resolved location", () => {
    expect(parentSessionLocationLabel({ kind: "path", label: "…/deeply/nested", cwd: "/srv/dev/unknown/deeply/nested" }))
      .toBe("parent in …/deeply/nested");
  });

  it("keeps the generic wording when nothing is known about the parent", () => {
    expect(parentSessionLocationLabel({ kind: "unknown" })).toBe("parent unavailable");
  });
});

describe("parentSessionLocationTitle", () => {
  it("includes the full parent path so the row tooltip stays precise", () => {
    const title = parentSessionLocationTitle({
      kind: "workspace",
      label: "feature/parent-links",
      projectId: "project-1",
      workspaceId: "workspace-feature",
      sessionId: "parent-id",
      cwd: "/srv/dev/pi-web-feature",
    });

    expect(title).toBe("Parent session is in feature/parent-links (/srv/dev/pi-web-feature)");
  });

  it("explains an unknown parent without inventing a location", () => {
    expect(parentSessionLocationTitle({ kind: "unknown" })).toBe("Parent session is not available in this workspace");
  });
});

const mainWorkspace: Workspace = {
  id: "workspace-main",
  projectId: "project-1",
  path: "/srv/dev/pi-web",
  label: "main",
  branch: "main",
  isMain: true,
  effectiveConfig: {},
};

const featureWorkspace: Workspace = {
  id: "workspace-feature",
  projectId: "project-1",
  path: "/srv/dev/pi-web-feature",
  label: "feature/parent-links",
  branch: "feature/parent-links",
  isMain: false,
  effectiveConfig: {},
};

function child(parent: { parentSessionCwd?: string; parentSessionId?: string }): SessionInfo {
  return {
    id: "child-id",
    path: "/sessions/--srv-dev-pi-web--/child.jsonl",
    cwd: "/srv/dev/pi-web",
    created: "2026-07-28T00:00:00.000Z",
    modified: "2026-07-28T00:00:00.000Z",
    messageCount: 3,
    firstMessage: "do the thing",
    parentSessionPath: "/sessions/--srv-dev-pi-web-feature--/parent.jsonl",
    ...(parent.parentSessionCwd === undefined ? {} : { parentSessionCwd: parent.parentSessionCwd }),
    ...(parent.parentSessionId === undefined ? {} : { parentSessionId: parent.parentSessionId }),
  };
}

function sources(overrides: {
  workspaces?: readonly Workspace[];
  workspacesByProjectId?: Record<string, readonly Workspace[]>;
  projects?: readonly Project[];
}) {
  return {
    workspaces: overrides.workspaces ?? [],
    workspacesByProjectId: overrides.workspacesByProjectId ?? {},
    projects: overrides.projects ?? [],
  };
}
