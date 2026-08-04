import { describe, expect, it } from "vitest";
import type { Project, SessionUnreadSummary, Workspace } from "../../shared/apiTypes";
import type { SessionUnreadProjectionView } from "./sessionUnread";
import {
  deriveUnreadPresence,
  EMPTY_UNREAD_PRESENCE,
  hasUnreadSessions,
  machineUnreadPresence,
  projectUnreadPresence,
  sameUnreadPresence,
  unreadCwds,
  workspaceUnreadPresence,
  type UnreadPresenceInputs,
} from "./unreadPresence";

describe("hasUnreadSessions", () => {
  it("treats an unavailable projection as no presence", () => {
    expect(hasUnreadSessions(undefined)).toBe(false);
  });

  it("treats an empty projection as no presence", () => {
    expect(hasUnreadSessions(projection())).toBe(false);
  });

  it("treats any summary as presence, even when the projection is stale", () => {
    expect(hasUnreadSessions(projection([summary("session-1", "/repo")]))).toBe(true);
    expect(hasUnreadSessions(projection([summary("session-1", "/repo")], "stale"))).toBe(true);
  });
});

describe("unreadCwds", () => {
  it("is empty without a projection or without sessions", () => {
    expect([...unreadCwds(undefined)]).toEqual([]);
    expect([...unreadCwds(projection())]).toEqual([]);
  });

  it("collects the distinct cwds of unread summaries", () => {
    const cwds = unreadCwds(projection([
      summary("session-1", "/repo", 2),
      summary("session-2", "/repo", 1),
      summary("session-3", "/other", 3),
    ]));
    expect([...cwds].sort()).toEqual(["/other", "/repo"]);
  });
});

describe("machineUnreadPresence", () => {
  it("flags machines with any unread summary, including cwds mapped to no known workspace", () => {
    const projections = new Map<string, SessionUnreadProjectionView | undefined>([
      ["local", projection([summary("session-1", "/unmapped")])],
      ["empty", projection()],
      ["unloaded", undefined],
    ]);
    const present = machineUnreadPresence(["local", "empty", "unloaded"], (machineId) => projections.get(machineId));
    expect([...present]).toEqual(["local"]);
  });

  it("only considers the listed machine ids", () => {
    const present = machineUnreadPresence(["local"], () => projection([summary("session-1", "/repo")]));
    expect([...present]).toEqual(["local"]);
  });
});

describe("workspaceUnreadPresence", () => {
  it("flags the workspace whose path exactly matches an unread cwd", () => {
    const workspaces = [workspace("ws-1", "project-1", "/repo"), workspace("ws-2", "project-1", "/repo/branch")];
    expect([...workspaceUnreadPresence(workspaces, new Set(["/repo/branch"]))]).toEqual(["ws-2"]);
  });

  it("flags nothing when no unread cwd maps to a workspace path", () => {
    const workspaces = [workspace("ws-1", "project-1", "/repo")];
    expect([...workspaceUnreadPresence(workspaces, new Set(["/unmapped"]))]).toEqual([]);
    expect([...workspaceUnreadPresence(workspaces, new Set())]).toEqual([]);
  });
});

describe("projectUnreadPresence", () => {
  it("flags the project owning a workspace with an unread cwd", () => {
    const projects = [project("project-1"), project("project-2")];
    const workspacesByProjectId = {
      "project-1": [workspace("ws-1", "project-1", "/repo")],
      "project-2": [workspace("ws-2", "project-2", "/other")],
    };
    expect([...projectUnreadPresence(projects, workspacesByProjectId, new Set(["/other"]))]).toEqual(["project-2"]);
  });

  it("flags the project through its main workspace at the project path", () => {
    const projects = [project("project-1", "/repo")];
    const workspacesByProjectId = { "project-1": [workspace("ws-1", "project-1", "/repo")] };
    expect([...projectUnreadPresence(projects, workspacesByProjectId, new Set(["/repo"]))]).toEqual(["project-1"]);
  });

  it("does not flag a project whose workspaces are not loaded", () => {
    const projects = [project("project-1")];
    expect([...projectUnreadPresence(projects, {}, new Set(["/repo"]))]).toEqual([]);
  });

  it("leaves a cwd under the project path but matching no known workspace to the machine dot only", () => {
    const projects = [project("project-1", "/repo")];
    const workspacesByProjectId = { "project-1": [workspace("ws-1", "project-1", "/repo/main")] };
    expect([...projectUnreadPresence(projects, workspacesByProjectId, new Set(["/repo/unmapped-subdir"]))]).toEqual([]);
  });
});

describe("deriveUnreadPresence", () => {
  it("maps the selected machine's unread cwds to workspace and project presence", () => {
    const inputs = presenceInputs({
      projections: new Map([["local", projection([summary("session-1", "/repo")])]]),
    });

    const presence = deriveUnreadPresence(inputs);

    expect([...presence.machines]).toEqual(["local"]);
    expect([...presence.workspaces]).toEqual(["ws-1"]);
    expect([...presence.projects]).toEqual(["project-1"]);
  });

  it("reflects background machines at machine level without leaking their cwds into workspace or project rows", () => {
    const inputs = presenceInputs({
      machineIds: ["local", "remote"],
      projections: new Map([
        ["local", projection()],
        ["remote", projection([summary("session-1", "/repo")])],
      ]),
    });

    const presence = deriveUnreadPresence(inputs);

    expect([...presence.machines]).toEqual(["remote"]);
    expect([...presence.workspaces]).toEqual([]);
    expect([...presence.projects]).toEqual([]);
  });

  it("is empty when no machine has a usable projection", () => {
    const presence = deriveUnreadPresence(presenceInputs({ projections: new Map([["local", undefined]]) }));
    expect(sameUnreadPresence(presence, EMPTY_UNREAD_PRESENCE)).toBe(true);
  });
});

describe("sameUnreadPresence", () => {
  it("compares presence by set contents", () => {
    const left = { machines: new Set(["local"]), projects: new Set(["project-1"]), workspaces: new Set(["ws-1"]) };
    const matching = { machines: new Set(["local"]), projects: new Set(["project-1"]), workspaces: new Set(["ws-1"]) };
    const different = { machines: new Set(["remote"]), projects: new Set(["project-1"]), workspaces: new Set(["ws-1"]) };
    expect(sameUnreadPresence(left, matching)).toBe(true);
    expect(sameUnreadPresence(left, different)).toBe(false);
    expect(sameUnreadPresence(EMPTY_UNREAD_PRESENCE, { machines: new Set(), projects: new Set(), workspaces: new Set() })).toBe(true);
  });
});

function presenceInputs(options: {
  machineIds?: string[];
  projections: Map<string, SessionUnreadProjectionView | undefined>;
}): UnreadPresenceInputs {
  return {
    machineIds: options.machineIds ?? ["local"],
    projectionFor: (machineId) => options.projections.get(machineId),
    selectedMachineId: "local",
    projects: [project("project-1", "/repo")],
    workspaces: [workspace("ws-1", "project-1", "/repo")],
    workspacesByProjectId: { "project-1": [workspace("ws-1", "project-1", "/repo")] },
  };
}

function summary(sessionId: string, cwd: string, completionOrder = 1): SessionUnreadSummary {
  return { sessionId, cwd, completionOrder, completedAt: "2026-07-20T00:00:00.000Z" };
}

function projection(summaries: SessionUnreadSummary[] = [], status: "fresh" | "stale" = "fresh"): SessionUnreadProjectionView {
  return {
    status,
    catalogId: "catalog-a",
    catalogRevision: summaries.reduce((revision, entry) => Math.max(revision, entry.completionOrder), 0),
    sessions: summaries,
  };
}

function workspace(id: string, projectId: string, path: string): Workspace {
  return { id, projectId, path, label: id, isMain: false, effectiveConfig: {} };
}

function project(id: string, path = `/${id}`): Project {
  return { id, name: id, path, createdAt: "2026-07-20T00:00:00.000Z" };
}
