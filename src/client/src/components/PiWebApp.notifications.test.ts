import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import type { SessionInfo } from "../api";
import type { NavigationNotificationBadges } from "./appShell/AppNavigationPanel";
import { machineSwitcherNotificationBadge } from "./MachineSwitcher";
import { PiWebApp } from "./PiWebApp";

const currentSession: SessionInfo = {
  id: "session-1",
  cwd: "/repo",
  path: "/tmp/session-1.jsonl",
  created: "2026-07-18T00:00:00.000Z",
  modified: "2026-07-18T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

const archivedSession: SessionInfo = {
  ...currentSession,
  id: "archived-session",
  path: "/tmp/archived-session.jsonl",
  archived: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PiWebApp notification hierarchy models", () => {
  it("projects exact machine/cwd counts through session, workspace, project, machine, heading, and mobile levels", () => {
    const app = createApp();
    const local = { id: "local", name: "Local", kind: "local" as const, createdAt: "now", updatedAt: "now" };
    const remote = { id: "remote", name: "Remote", kind: "remote" as const, createdAt: "now", updatedAt: "now" };
    const state: AppState = {
      ...initialAppState(),
      machines: [local, remote],
      selectedMachine: local,
      projects: [{ id: "project-1", name: "Repo", path: "/repo", createdAt: "now" }],
      selectedProject: { id: "project-1", name: "Repo", path: "/repo", createdAt: "now" },
      workspaces: [
        { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false },
        { id: "workspace-2", projectId: "project-1", path: "/repo-worktree", label: "worktree", isMain: false, isGitRepo: true, isGitWorktree: true },
      ],
      selectedWorkspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false },
      workspacesByProjectId: {
        "project-1": [
          { id: "workspace-1", projectId: "project-1", path: "/repo", label: "repo", isMain: true, isGitRepo: true, isGitWorktree: false },
          { id: "workspace-2", projectId: "project-1", path: "/repo-worktree", label: "worktree", isMain: false, isGitRepo: true, isGitWorktree: true },
        ],
      },
      sessions: [currentSession, archivedSession],
      selectedSession: currentSession,
      notificationCatalogsByMachine: {
        local: {
          machineId: "local",
          status: "fresh",
          daemonInstanceId: "daemon-local",
          catalogRevision: 4,
          summariesBySessionId: {
            "session-1": { sessionId: "session-1", cwd: "/repo", inboxRevision: 1, retainedCount: 2, discardedCount: 0, highestSeverity: "error" },
            "session-2": { sessionId: "session-2", cwd: "/repo-worktree", inboxRevision: 2, retainedCount: 1, discardedCount: 3, highestSeverity: "warning" },
          },
        },
        remote: {
          machineId: "remote",
          status: "fresh",
          daemonInstanceId: "daemon-remote",
          catalogRevision: 1,
          summariesBySessionId: {
            "session-1": { sessionId: "session-1", cwd: "/remote", inboxRevision: 1, retainedCount: 5, discardedCount: 0, highestSeverity: "info" },
          },
        },
      },
    };
    Reflect.set(app, "state", state);

    const badges = navigationNotificationBadges(app);
    const mobile = mobileSessionsNotificationBadge(app);

    expect(badges.sessions["session-1"]).toMatchObject({ text: "2", severity: "error" });
    expect(badges.sessions["archived-session"]).toBeUndefined();
    expect(badges.workspaces["workspace-1"]).toMatchObject({ text: "2", severity: "error" });
    expect(badges.workspaces["workspace-2"]).toMatchObject({ text: "1+", severity: "warning" });
    expect(badges.projects["project-1"]).toMatchObject({ text: "3+", severity: "error" });
    expect(badges.machines["local"]).toMatchObject({ text: "3+", severity: "error" });
    expect(badges.machines["remote"]).toMatchObject({ text: "5", severity: "info" });
    expect(badges.machinesHeading).toMatchObject({ text: "8+", severity: "error" });
    expect(machineSwitcherNotificationBadge("local", badges.machines, badges.machinesHeading)).toBe(badges.machinesHeading);
    expect(badges.sessionsHeading).toMatchObject({ text: "2", severity: "error" });
    expect(mobile).toMatchObject({ text: "8+", severity: "error" });
  });

  it("excludes stale remote catalogs from mobile and machine badges", () => {
    const app = createApp();
    const state = initialAppState();
    state.notificationCatalogsByMachine = {
      remote: {
        machineId: "remote",
        status: "stale",
        daemonInstanceId: "daemon-remote",
        catalogRevision: 3,
        summariesBySessionId: {
          "session-1": { sessionId: "session-1", cwd: "/repo", inboxRevision: 3, retainedCount: 9, discardedCount: 0, highestSeverity: "error" },
        },
      },
    };
    Reflect.set(app, "state", state);

    expect(mobileSessionsNotificationBadge(app)).toBeUndefined();
  });
});

function createApp(): PiWebApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

type NavigationNotificationBadgesMethod = (this: PiWebApp) => NavigationNotificationBadges;
type MobileNotificationBadgeMethod = (this: PiWebApp) => NavigationNotificationBadges["machinesHeading"];

function navigationNotificationBadges(app: PiWebApp): NavigationNotificationBadges {
  const method: unknown = Reflect.get(app, "navigationNotificationBadges");
  if (!isNavigationNotificationBadgesMethod(method)) throw new Error("PiWebApp.navigationNotificationBadges is not callable");
  return method.call(app);
}

function mobileSessionsNotificationBadge(app: PiWebApp): NavigationNotificationBadges["machinesHeading"] {
  const method: unknown = Reflect.get(app, "mobileSessionsNotificationBadge");
  if (!isMobileNotificationBadgeMethod(method)) throw new Error("PiWebApp.mobileSessionsNotificationBadge is not callable");
  return method.call(app);
}

function isNavigationNotificationBadgesMethod(value: unknown): value is NavigationNotificationBadgesMethod {
  return typeof value === "function";
}

function isMobileNotificationBadgeMethod(value: unknown): value is MobileNotificationBadgeMethod {
  return typeof value === "function";
}
