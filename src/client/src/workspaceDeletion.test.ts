import { describe, expect, it } from "vitest";
import type { TerminalCommandRun, Workspace } from "./api";
import { canDeleteWorkspace, isWorkspaceDeletionPending, latestWorkspaceDeletionRuns, pendingWorkspaceDeletionIds, workspaceDeleteOperation, workspaceDeletionMetadata, workspaceRemovalConfirmation } from "./workspaceDeletion";

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  path: "/repo/worktree",
  label: "worktree",
  isMain: false,
  effectiveConfig: {},
  removal: {
    actionLabel: "Disconnect view",
    confirmation: "Disconnect this view without deleting files?",
    precondition: "removal-v1",
  },
};

function run(id: string, workspaceId: string, createdAt: string, status: TerminalCommandRun["status"]): TerminalCommandRun {
  return {
    id,
    origin: "core",
    projectId: "p1",
    workspaceId: "main",
    terminalId: `t-${id}`,
    title: "Delete workspace",
    command: "git worktree remove '/repo/worktree'",
    status,
    createdAt,
    metadata: { "pi.operation": workspaceDeleteOperation, "target.workspaceId": workspaceId, "target.workspacePath": "/repo/worktree" },
  };
}

describe("workspace deletion state", () => {
  it("derives provider-neutral eligibility and confirmation only from removal presentation", () => {
    expect(canDeleteWorkspace(workspace)).toBe(true);
    expect(workspaceRemovalConfirmation(workspace)).toBe("Disconnect this view without deleting files?");
    expect(canDeleteWorkspace({ ...workspace, isMain: true })).toBe(false);
    const withoutRemoval = { ...workspace };
    delete withoutRemoval.removal;
    expect(canDeleteWorkspace(withoutRemoval)).toBe(false);
  });

  it("builds command-run metadata for workspace deletion", () => {
    expect(workspaceDeletionMetadata(workspace)).toEqual({
      "pi.operation": "workspace.delete",
      "target.workspaceId": "w1",
      "target.workspacePath": "/repo/worktree",
    });
  });

  it("tracks the latest deletion run per target workspace", () => {
    expect(latestWorkspaceDeletionRuns([
      run("old", "w1", "2026-05-25T00:00:00.000Z", "failed"),
      run("new", "w1", "2026-05-25T00:00:01.000Z", "running"),
      run("other", "w2", "2026-05-25T00:00:00.000Z", "running"),
    ])).toMatchObject({
      w1: { id: "new", status: "running" },
      w2: { id: "other", status: "running" },
    });
  });

  it("reports only queued or running workspace deletions as pending", () => {
    const state = {
      workspaceDeletionRuns: {
        w1: run("running", "w1", "2026-05-25T00:00:01.000Z", "running"),
        w2: run("queued", "w2", "2026-05-25T00:00:02.000Z", "queued"),
        w3: run("succeeded", "w3", "2026-05-25T00:00:03.000Z", "succeeded"),
        w4: run("failed", "w4", "2026-05-25T00:00:04.000Z", "failed"),
      },
    };

    expect(isWorkspaceDeletionPending(state, workspace)).toBe(true);
    expect(isWorkspaceDeletionPending(state, { ...workspace, id: "w3" })).toBe(false);
    expect(pendingWorkspaceDeletionIds(state.workspaceDeletionRuns)).toEqual(["w1", "w2"]);
  });
});
