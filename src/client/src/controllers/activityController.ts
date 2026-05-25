import { activityApi as defaultApi, type WorkspaceActivity, type WorkspaceActivityResponse } from "../api";
import { isWorkspaceActivityActive } from "../../../shared/activity";
import { selectedMachineId, type GetState, type SetState } from "./types";

export interface ActivityControllerDependencies {
  api?: Pick<typeof defaultApi, "workspaceActivity">;
}

export class ActivityController {
  private readonly api: Pick<typeof defaultApi, "workspaceActivity">;

  constructor(private readonly getState: GetState, private readonly setState: SetState, deps: ActivityControllerDependencies = {}) {
    this.api = deps.api ?? defaultApi;
  }

  async refresh(): Promise<void> {
    const snapshot = await this.api.workspaceActivity(selectedMachineId(this.getState()));
    this.setState({ workspaceActivities: indexWorkspaceActivities(snapshot) });
  }

  applyWorkspaceActivity(activity: WorkspaceActivity): void {
    this.setState({ workspaceActivities: applyWorkspaceActivityToMap(this.getState().workspaceActivities, activity) });
  }
}

export function indexWorkspaceActivities(snapshot: WorkspaceActivityResponse): Record<string, WorkspaceActivity> {
  const activities: Record<string, WorkspaceActivity> = {};
  for (const activity of snapshot.workspaces) {
    if (isWorkspaceActivityActive(activity)) activities[activity.cwd] = activity;
  }
  return activities;
}

export function applyWorkspaceActivityToMap(current: Record<string, WorkspaceActivity>, activity: WorkspaceActivity): Record<string, WorkspaceActivity> {
  const next = { ...current };
  if (isWorkspaceActivityActive(activity)) {
    next[activity.cwd] = activity;
    return next;
  }
  return Object.fromEntries(Object.entries(next).filter(([cwd]) => cwd !== activity.cwd));
}
