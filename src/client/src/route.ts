import type { QualifiedContributionId } from "./plugins/types";

export interface AppRoute {
  machineId: string | undefined;
  projectId: string | undefined;
  workspaceId: string | undefined;
  sessionId: string | undefined;
  tool: QualifiedContributionId | undefined;
  view: "chat" | QualifiedContributionId | undefined;
}

export function readRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search);
  return {
    machineId: params.get("machine") ?? undefined,
    projectId: params.get("project") ?? undefined,
    workspaceId: params.get("workspace") ?? undefined,
    sessionId: params.get("session") ?? undefined,
    tool: parseTool(params.get("tool")),
    view: parseView(params.get("view")),
  };
}

export function writeRoute(route: AppRoute, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("machine");
  url.searchParams.delete("project");
  url.searchParams.delete("workspace");
  url.searchParams.delete("session");
  url.searchParams.delete("tool");
  url.searchParams.delete("view");
  if (route.machineId !== undefined && route.machineId !== "" && route.machineId !== "local") url.searchParams.set("machine", route.machineId);
  if (route.projectId !== undefined && route.projectId !== "") url.searchParams.set("project", route.projectId);
  if (route.workspaceId !== undefined && route.workspaceId !== "") url.searchParams.set("workspace", route.workspaceId);
  if (route.sessionId !== undefined && route.sessionId !== "") url.searchParams.set("session", route.sessionId);
  if (route.tool !== undefined) url.searchParams.set("tool", route.tool);
  if (route.view !== undefined) url.searchParams.set("view", route.view);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

function parseTool(value: string | null): QualifiedContributionId | undefined {
  if (value === "files") return "core:workspace.files";
  if (value === "git") return "core:workspace.git";
  return isQualifiedId(value) ? value : undefined;
}

function parseView(value: string | null): "chat" | QualifiedContributionId | undefined {
  if (value === "chat") return "chat";
  if (value === "files") return "core:workspace.files";
  if (value === "git") return "core:workspace.git";
  return isQualifiedId(value) ? value : undefined;
}

function isQualifiedId(value: string | null): value is QualifiedContributionId {
  return value !== null && /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u.test(value);
}
