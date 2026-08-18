import { machineStatusApi as defaultApi } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import type { GetState, SetState } from "./types";
import { TrailingRefreshCoordinator } from "./trailingRefreshCoordinator";

export interface MachineStatusApi {
  machineStatus(machineId: string): Promise<MachineStatusSnapshot>;
}

export interface MachineStatusControllerDependencies {
  api?: MachineStatusApi;
}

/**
 * Browser projection of the per-machine status trees sessiond publishes.
 *
 * Every message is a complete snapshot, so this controller only has to decide
 * which of two snapshots is newer: a different `epochId` means the daemon
 * restarted and its tree replaces whatever was held, and within an epoch only
 * a higher `revision` wins. That keeps an HTTP refresh resolving after a socket
 * frame from reinstating older state without any delta, gap, or replay
 * machinery.
 *
 * A machine simply has no entry until one of its snapshots arrives, which is
 * how a daemon that does not publish the tree ends up showing no indicators.
 */
export class MachineStatusController {
  private readonly api: MachineStatusApi;
  private readonly refreshes = new TrailingRefreshCoordinator<string>();

  constructor(
    private readonly getState: GetState,
    private readonly setState: SetState,
    deps: MachineStatusControllerDependencies = {},
  ) {
    this.api = deps.api ?? defaultApi;
  }

  /** Fetch the current snapshot for explicit refresh paths. Rejects on failure. */
  refresh(machineId: string): Promise<void> {
    return this.refreshes.request(machineId, async () => {
      this.apply(machineId, await this.api.machineStatus(machineId));
    });
  }

  apply(machineId: string, snapshot: MachineStatusSnapshot): void {
    const snapshots = this.getState().machineStatusSnapshots;
    if (!supersedes(snapshots[machineId], snapshot)) return;
    this.setState({ machineStatusSnapshots: { ...snapshots, [machineId]: snapshot } });
  }
}

function supersedes(current: MachineStatusSnapshot | undefined, candidate: MachineStatusSnapshot): boolean {
  if (current === undefined) return true;
  return current.epochId !== candidate.epochId || candidate.revision > current.revision;
}
