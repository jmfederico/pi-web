import type { WorkspaceAttribution } from "../status/workspaceAttribution.js";
import type { MachineStatusService } from "../status/machineStatusService.js";
import type { WorkspaceChangedEvent } from "../../shared/apiTypes.js";

export interface WorkspaceChangeNotifierDependencies {
  attribution: Pick<WorkspaceAttribution, "invalidate">;
  status: Pick<MachineStatusService, "notifyChanged">;
  publish(event: WorkspaceChangedEvent): void;
}

/** One entry point for invalidating projections; providers remain the discovery authority. */
export class WorkspaceChangeNotifier {
  constructor(private readonly dependencies: WorkspaceChangeNotifierDependencies) {}

  notify(projectId: string): void {
    this.dependencies.attribution.invalidate();
    this.dependencies.status.notifyChanged();
    this.dependencies.publish({ type: "workspaces.changed", projectId });
  }
}
