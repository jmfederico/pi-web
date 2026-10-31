import type { WorkspaceAttribution } from "../status/workspaceAttribution.js";
import type { MachineStatusService } from "../status/machineStatusService.js";
import type { WorkspaceChangedEvent } from "../../shared/apiTypes.js";

export interface WorkspaceChangeNotifierDependencies {
  requestRefresh(projectId: string): void;
  attribution: Pick<WorkspaceAttribution, "invalidate">;
  status: Pick<MachineStatusService, "notifyChanged">;
  publish(event: WorkspaceChangedEvent): void;
}

/** Mutations request discovery and invalidate projections; routine readers do neither. */
export class WorkspaceChangeNotifier {
  constructor(private readonly dependencies: WorkspaceChangeNotifierDependencies) {}

  notify(projectId: string): void {
    this.dependencies.requestRefresh(projectId);
    this.dependencies.attribution.invalidate();
    this.dependencies.status.notifyChanged();
    this.dependencies.publish({ type: "workspaces.changed", projectId });
  }
}
