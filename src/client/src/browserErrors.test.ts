import { describe, expect, it } from "vitest";
import {
  browserErrorScopeKey,
  clearBrowserError,
  machineBrowserErrorScope,
  discardBrowserErrors,
  reportBrowserError,
  sessionBrowserErrorScope,
  visibleBrowserErrors,
  workspaceBrowserErrorScope,
} from "./browserErrors";

const workspaceA = workspaceBrowserErrorScope("local", "project-a", "workspace-a");
const workspaceB = workspaceBrowserErrorScope("local", "project-b", "workspace-b");
const sessionA = sessionBrowserErrorScope("local", "session-a", { cwd: "/workspace-a", projectId: "project-a", workspaceId: "workspace-a" });

function context(overrides: Partial<{ machineId: string; projectId: string; workspaceId: string; sessionId: string; cwd: string }> = {}) {
  return {
    machineId: "local",
    projectId: "project-a",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    cwd: "/workspace-a",
    ...overrides,
  };
}

describe("browser error scopes", () => {
  it("retains independent workspace and session failures while showing only the active context", () => {
    let errors = reportBrowserError({}, workspaceA, "Workspace A failed");
    errors = reportBrowserError(errors, workspaceB, "Workspace B failed");
    errors = reportBrowserError(errors, sessionA, "Session A failed");

    expect(visibleBrowserErrors(errors, context())).toEqual([
      { scope: workspaceA, message: "Workspace A failed" },
      { scope: sessionA, message: "Session A failed" },
    ]);
    expect(visibleBrowserErrors(errors, context({ projectId: "project-b", workspaceId: "workspace-b" }))).toEqual([
      { scope: workspaceB, message: "Workspace B failed" },
    ]);
  });

  it("keeps machine failures visible only for the affected machine", () => {
    const machineError = machineBrowserErrorScope("remote-a");
    const errors = reportBrowserError({}, machineError, "Remote machine unavailable");

    expect(visibleBrowserErrors(errors, context({ machineId: "local" }))).toEqual([]);
    expect(visibleBrowserErrors(errors, context({ machineId: "remote-a" }))).toEqual([{ scope: machineError, message: "Remote machine unavailable" }]);
  });

  it("does not let a stale dismissal remove a replacement for the same scope", () => {
    let errors = reportBrowserError({}, workspaceA, "first failure");
    errors = reportBrowserError(errors, workspaceA, "replacement failure");

    expect(clearBrowserError(errors, workspaceA, "first failure")).toBe(errors);
    expect(clearBrowserError(errors, workspaceA, "replacement failure")).toEqual({});
  });

  it("discards a workspace and its child session errors without touching another workspace", () => {
    let errors = reportBrowserError({}, workspaceA, "workspace failure");
    errors = reportBrowserError(errors, sessionA, "session failure");
    errors = reportBrowserError(errors, workspaceB, "other failure");

    const remaining = discardBrowserErrors(errors, workspaceA);

    expect(Object.keys(remaining)).toEqual([browserErrorScopeKey(workspaceB)]);
    expect(remaining[browserErrorScopeKey(workspaceB)]?.message).toBe("other failure");
  });
});
