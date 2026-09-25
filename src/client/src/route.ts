import type { QualifiedContributionId } from "./plugins/types";

export type MainView = "navigation" | "chat" | "workspace";

export function parseMainView(value: unknown): MainView | undefined {
  return value === "navigation" || value === "chat" || value === "workspace" ? value : undefined;
}

interface AppRouteLocation {
  machineId: string | undefined;
  projectId: string | undefined;
  workspaceId: string | undefined;
  sessionId: string | undefined;
  /** Session cwd from push-notification deep links; joined against workspace paths to find the workspace. */
  cwd?: string | undefined;
}

export interface WorkspaceRouteIdentity {
  machineId: string;
  projectId: string;
  workspaceId: string;
}

/** Route values after plugin-contributed workspace panel aliases are resolved. */
export interface AppRoute extends AppRouteLocation {
  tool: QualifiedContributionId | undefined;
  view: MainView | undefined;
}

/** Raw URL values are retained so invalid destinations can be explained without rewriting them. */
export interface ParsedAppRoute extends AppRouteLocation {
  tool: string | undefined;
  view: string | undefined;
}

export type WorkspacePanelRouteResolver = (value: string) => QualifiedContributionId | undefined;

interface NotificationRouteProject {
  id: string;
}

interface NotificationRouteWorkspace {
  id: string;
  path: string;
}

interface NotificationRouteSession {
  id: string;
}

/** Browser-owned creation identity, never a backend session ID or a create command. */
export function isCreatingSessionId(sessionId: string | undefined): sessionId is `creating:${string}` {
  return sessionId?.startsWith("creating:") === true;
}

export function readRoute(): ParsedAppRoute {
  const params = new URLSearchParams(window.location.search);
  return {
    machineId: nonEmpty(params.get("machine")),
    projectId: nonEmpty(params.get("project")),
    workspaceId: nonEmpty(params.get("workspace")),
    sessionId: nonEmpty(params.get("session")),
    cwd: nonEmpty(params.get("cwd")),
    tool: nonEmpty(params.get("tool")),
    view: nonEmpty(params.get("view")),
  };
}

export function resolveAppRoute(route: ParsedAppRoute, resolveWorkspacePanel: WorkspacePanelRouteResolver): AppRoute {
  return {
    machineId: route.machineId,
    projectId: route.projectId,
    workspaceId: route.workspaceId,
    sessionId: route.sessionId,
    tool: route.tool === undefined ? undefined : resolveWorkspacePanelRouteValue(route.tool, resolveWorkspacePanel),
    view: parseMainView(route.view),
  };
}

export function resolveWorkspacePanelRouteValue(value: string, resolveWorkspacePanel: WorkspacePanelRouteResolver): QualifiedContributionId | undefined {
  return resolveWorkspacePanel(value) ?? (isQualifiedContributionId(value) ? value : undefined);
}

export function routeMatchesWorkspaceIdentity(
  route: Pick<ParsedAppRoute, "machineId" | "projectId" | "workspaceId">,
  identity: WorkspaceRouteIdentity,
): boolean {
  return (route.machineId ?? "local") === identity.machineId
    && route.projectId === identity.projectId
    && route.workspaceId === identity.workspaceId;
}

export function writeRoute(route: ParsedAppRoute, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("machine");
  url.searchParams.delete("project");
  url.searchParams.delete("workspace");
  url.searchParams.delete("session");
  url.searchParams.delete("cwd");
  url.searchParams.delete("tool");
  url.searchParams.delete("view");
  if (route.machineId !== undefined && route.machineId !== "" && route.machineId !== "local") url.searchParams.set("machine", route.machineId);
  if (route.projectId !== undefined && route.projectId !== "") url.searchParams.set("project", route.projectId);
  if (route.workspaceId !== undefined && route.workspaceId !== "") url.searchParams.set("workspace", route.workspaceId);
  if (route.sessionId !== undefined && route.sessionId !== "") url.searchParams.set("session", route.sessionId);
  if (route.cwd !== undefined && route.cwd !== "") url.searchParams.set("cwd", route.cwd);
  if (route.tool !== undefined && route.tool !== "") url.searchParams.set("tool", route.tool);
  if (route.view !== undefined && route.view !== "") url.searchParams.set("view", route.view);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

function nonEmpty(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/**
 * Workspace whose path equals a push-notification session cwd — the join key between what the
 * daemon knows (a session's directory) and what the browser routes by (project/workspace ids).
 */
export function findNotifiedWorkspace(workspaces: readonly { id: string; path: string }[], cwd: string): string | undefined {
  return workspaces.find((workspace) => workspace.path === cwd)?.id;
}

/** Resolve notification routes from cwd, with a session-list fallback for payloads from older daemons. */
export async function resolveNotificationRoute(
  route: ParsedAppRoute,
  projects: readonly NotificationRouteProject[],
  cachedWorkspaces: Readonly<Record<string, readonly NotificationRouteWorkspace[]>>,
  loadWorkspaces: (projectId: string) => Promise<readonly NotificationRouteWorkspace[]>,
  loadSessions: (cwd: string) => Promise<readonly NotificationRouteSession[]>,
): Promise<ParsedAppRoute> {
  if ((route.projectId ?? "") !== "" || route.sessionId === undefined) return route;
  for (const project of projects) {
    const workspaces = cachedWorkspaces[project.id] ?? await loadWorkspaces(project.id).catch(() => []);
    if (route.cwd !== undefined) {
      const workspaceId = findNotifiedWorkspace(workspaces, route.cwd);
      if (workspaceId !== undefined) return { ...route, projectId: project.id, workspaceId };
      continue;
    }
    for (const workspace of workspaces) {
      const sessions = await loadSessions(workspace.path).catch(() => []);
      if (sessions.some((session) => session.id === route.sessionId)) {
        return { ...route, projectId: project.id, workspaceId: workspace.id };
      }
    }
  }
  return route;
}

function isQualifiedContributionId(value: string): value is QualifiedContributionId {
  return /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(value);
}
