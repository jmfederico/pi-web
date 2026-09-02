import type { AppState } from "./appState";
import type { GetState, SetState } from "./controllers/types";

/** The narrowest application context that can own a browser-local failure. */
export type BrowserErrorScope =
  | { kind: "global" }
  | { kind: "machine"; machineId: string }
  | { kind: "project"; machineId: string; projectId: string }
  | { kind: "workspace"; machineId: string; projectId: string; workspaceId: string }
  | { kind: "session"; machineId: string; sessionId: string; cwd?: string; projectId?: string; workspaceId?: string };

export interface BrowserError {
  scope: BrowserErrorScope;
  message: string;
}

export type BrowserErrorMap = Record<string, BrowserError>;

/** The currently selected context used to decide which retained errors are visible. */
export interface BrowserErrorContext {
  machineId: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
  cwd?: string;
}

export interface SessionBrowserErrorOwner {
  cwd?: string;
  projectId?: string;
  workspaceId?: string;
}

export function machineBrowserErrorScope(machineId: string): BrowserErrorScope {
  return { kind: "machine", machineId };
}

export function projectBrowserErrorScope(machineId: string, projectId: string): BrowserErrorScope {
  return { kind: "project", machineId, projectId };
}

export function workspaceBrowserErrorScope(machineId: string, projectId: string, workspaceId: string): BrowserErrorScope {
  return { kind: "workspace", machineId, projectId, workspaceId };
}

export function sessionBrowserErrorScope(machineId: string, sessionId: string, owner: SessionBrowserErrorOwner = {}): BrowserErrorScope {
  return {
    kind: "session",
    machineId,
    sessionId,
    ...(owner.cwd === undefined ? {} : { cwd: owner.cwd }),
    ...(owner.projectId === undefined ? {} : { projectId: owner.projectId }),
    ...(owner.workspaceId === undefined ? {} : { workspaceId: owner.workspaceId }),
  };
}

export function browserErrorScopeKey(scope: BrowserErrorScope): string {
  switch (scope.kind) {
    case "global": return "global";
    case "machine": return JSON.stringify([scope.kind, scope.machineId]);
    case "project": return JSON.stringify([scope.kind, scope.machineId, scope.projectId]);
    case "workspace": return JSON.stringify([scope.kind, scope.machineId, scope.projectId, scope.workspaceId]);
    case "session": return JSON.stringify([scope.kind, scope.machineId, scope.sessionId, scope.cwd, scope.projectId, scope.workspaceId]);
  }
}

export function reportBrowserError(errors: BrowserErrorMap, scope: BrowserErrorScope, message: string): BrowserErrorMap {
  return { ...errors, [browserErrorScopeKey(scope)]: { scope, message } };
}

export function clearBrowserError(errors: BrowserErrorMap, scope: BrowserErrorScope, message?: string): BrowserErrorMap {
  const key = browserErrorScopeKey(scope);
  const current = errors[key];
  if (current === undefined || (message !== undefined && current.message !== message)) return errors;
  return Object.fromEntries(Object.entries(errors).filter(([candidate]) => candidate !== key));
}

/** Remove a discarded context and any narrower errors owned by its children. */
export function discardBrowserErrors(errors: BrowserErrorMap, scope: BrowserErrorScope): BrowserErrorMap {
  const next = Object.fromEntries(Object.entries(errors).filter(([, error]) => !isOwnedBy(error.scope, scope)));
  return Object.keys(next).length === Object.keys(errors).length ? errors : next;
}

export function browserErrorContext(state: Pick<AppState, "selectedMachine" | "selectedProject" | "selectedWorkspace" | "selectedSession">): BrowserErrorContext {
  const session = state.selectedSession;
  return {
    machineId: state.selectedMachine?.id ?? "local",
    ...(state.selectedProject === undefined ? {} : { projectId: state.selectedProject.id }),
    ...(state.selectedWorkspace === undefined ? {} : { workspaceId: state.selectedWorkspace.id }),
    ...(session === undefined ? {} : { sessionId: session.id, cwd: session.cwd }),
  };
}

export function visibleBrowserErrors(errors: BrowserErrorMap, context: BrowserErrorContext): BrowserError[] {
  return Object.values(errors)
    .filter((error) => scopeIsActive(error.scope, context))
    .sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || browserErrorScopeKey(left.scope).localeCompare(browserErrorScopeKey(right.scope)));
}

export class BrowserErrorReporter {
  constructor(private readonly getState: GetState, private readonly setState: SetState) {}

  report(scope: BrowserErrorScope, message: string): void {
    this.setState({ browserErrors: reportBrowserError(this.getState().browserErrors, scope, message) });
  }

  clear(scope: BrowserErrorScope, message?: string): void {
    const current = this.getState().browserErrors;
    const errors = clearBrowserError(current, scope, message);
    if (errors !== current) this.setState({ browserErrors: errors });
  }

  discard(scope: BrowserErrorScope): void {
    const errors = discardBrowserErrors(this.getState().browserErrors, scope);
    if (errors !== this.getState().browserErrors) this.setState({ browserErrors: errors });
  }
}

function scopeIsActive(scope: BrowserErrorScope, context: BrowserErrorContext): boolean {
  if (scope.kind === "global") return true;
  if (scope.machineId !== context.machineId) return false;
  if (scope.kind === "machine") return true;
  if (scope.kind === "project") return scope.projectId === context.projectId;
  if (scope.kind === "workspace") return scope.projectId === context.projectId && scope.workspaceId === context.workspaceId;
  return scope.sessionId === context.sessionId
    && (scope.cwd === undefined || scope.cwd === context.cwd)
    && (scope.projectId === undefined || scope.projectId === context.projectId)
    && (scope.workspaceId === undefined || scope.workspaceId === context.workspaceId);
}

function scopeRank(scope: BrowserErrorScope): number {
  switch (scope.kind) {
    case "global": return 0;
    case "machine": return 1;
    case "project": return 2;
    case "workspace": return 3;
    case "session": return 4;
  }
}

function isOwnedBy(candidate: BrowserErrorScope, owner: BrowserErrorScope): boolean {
  if (owner.kind === "global") return true;
  if (candidate.kind === "global" || candidate.machineId !== owner.machineId) return false;
  if (owner.kind === "machine") return true;
  if (owner.kind === "project") return candidate.kind !== "machine" && candidate.projectId === owner.projectId;
  if (owner.kind === "workspace") {
    return candidate.kind === "workspace"
      ? candidate.projectId === owner.projectId && candidate.workspaceId === owner.workspaceId
      : candidate.kind === "session" && candidate.projectId === owner.projectId && candidate.workspaceId === owner.workspaceId;
  }
  return candidate.kind === "session"
    && candidate.sessionId === owner.sessionId
    && (owner.cwd === undefined || candidate.cwd === owner.cwd);
}
