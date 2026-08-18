import { randomUUID } from "node:crypto";
import {
  CORE_STATUS_FLAGS,
  rollUpStatusFlags,
  type MachineStatusSnapshot,
  type StatusFlags,
} from "../../shared/machineStatus.js";
import type { WorkspaceAttribution } from "./workspaceAttribution.js";

/** One active working directory as recorded by `WorkspaceActivityService`. */
export interface ActiveCwdActivity {
  cwd: string;
  hasSessionActivity: boolean;
  hasTerminalActivity: boolean;
}

/**
 * In-memory record of which cwds currently have session or terminal activity.
 * Entries without activity are already filtered out by the recorder.
 */
interface MachineStatusActivitySource {
  snapshot(): { workspaces: readonly ActiveCwdActivity[] };
}

/** Unread completions, read for their cwds only; the catalog itself is unchanged. */
interface MachineStatusUnreadSource {
  catalogSnapshot(): { sessions: readonly { cwd: string }[] };
}

interface MachineStatusPublisher {
  publish(snapshot: MachineStatusSnapshot): void;
}

interface MachineStatusLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface MachineStatusServiceDependencies {
  activity: MachineStatusActivitySource;
  unread: MachineStatusUnreadSource;
  attribution: Pick<WorkspaceAttribution, "attribute">;
  publisher: MachineStatusPublisher;
  logger: MachineStatusLogger;
}

/** The part of a snapshot that carries status; the rest is identity and ordering. */
type MachineStatusTree = Pick<MachineStatusSnapshot, "machine" | "projects" | "workspaces" | "unattributed">;

/**
 * Owns this daemon's per-machine status projection.
 *
 * Every published message is the complete tree, so the browser never merges
 * deltas and never attributes a cwd itself. Recomputation is driven by change
 * notifications rather than polling, and a recomputed tree that equals the last
 * published one is dropped: an ongoing session therefore produces no status
 * traffic after its first flag flip.
 */
export class MachineStatusService {
  private current: MachineStatusSnapshot;
  private pending = false;
  private running: Promise<void> | undefined;

  constructor(private readonly dependencies: MachineStatusServiceDependencies) {
    this.current = {
      epochId: randomUUID(),
      revision: 0,
      machine: {},
      projects: {},
      workspaces: {},
      unattributed: {},
      generatedAt: new Date().toISOString(),
    };
  }

  /** The snapshot served by `GET /status` and as the first realtime frame. */
  snapshot(): MachineStatusSnapshot {
    return this.current;
  }

  /** Change notification from a status source. Recomputation runs in the background. */
  notifyChanged(): void {
    void this.refresh();
  }

  /**
   * Recompute and publish if anything changed, resolving once no further
   * recomputation is outstanding. Notifications that arrive while a pass is in
   * flight are coalesced into exactly one follow-up pass, so sources never read
   * stale inputs and snapshots are never published out of order.
   */
  refresh(): Promise<void> {
    this.pending = true;
    const running = this.running ?? this.runUntilSettled();
    this.running = running;
    return running;
  }

  private async runUntilSettled(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.publishIfChanged();
      }
    } finally {
      this.running = undefined;
    }
  }

  /**
   * Never rejects: this runs as a background reaction to a status change, so a
   * source or publisher that fails must be logged and left behind rather than
   * escape as an unhandled rejection in the long-lived daemon. A source failure
   * leaves the last good snapshot in place; a publication failure keeps the
   * recomputed snapshot, which `GET /status` still serves.
   */
  private async publishIfChanged(): Promise<void> {
    let tree: MachineStatusTree;
    try {
      tree = await this.computeTree();
    } catch (error) {
      this.dependencies.logger.warn({ err: error }, "machine status projection could not be recomputed");
      return;
    }
    if (isSameStatusTree(tree, this.current)) return;
    this.current = {
      epochId: this.current.epochId,
      revision: this.current.revision + 1,
      ...tree,
      generatedAt: new Date().toISOString(),
    };
    try {
      this.dependencies.publisher.publish(this.current);
    } catch (error) {
      this.dependencies.logger.warn({ err: error }, "machine status projection could not be published");
    }
  }

  private async computeTree(): Promise<MachineStatusTree> {
    const flagsByCwd = this.flagsByCwd();
    const attributions = await this.dependencies.attribution.attribute(flagsByCwd.keys());

    const projects = new FlagAccumulator();
    const workspaces = new FlagAccumulator();
    const unattributed: StatusFlags[] = [];
    for (const [cwd, flags] of flagsByCwd) {
      const attribution = attributions.get(cwd);
      if (attribution === undefined) {
        unattributed.push(flags);
        continue;
      }
      projects.add(attribution.projectId, flags);
      workspaces.add(attribution.workspaceId, flags);
    }

    const rolledProjects = projects.rollUp();
    const rolledWorkspaces = workspaces.rollUp();
    const rolledUnattributed = rollUpStatusFlags(unattributed);
    return {
      machine: rollUpStatusFlags([
        ...Object.values(rolledProjects),
        ...Object.values(rolledWorkspaces),
        rolledUnattributed,
      ]),
      projects: rolledProjects,
      workspaces: rolledWorkspaces,
      unattributed: rolledUnattributed,
    };
  }

  /**
   * Status of each cwd that carries any flag. Only set flags are recorded, so a
   * cwd that stops being active disappears instead of turning into empty flags,
   * which is what makes structural comparison a sound change test.
   */
  private flagsByCwd(): Map<string, StatusFlags> {
    const flagsByCwd = new Map<string, Record<string, boolean>>();
    const setFlag = (cwd: string, flagId: string): void => {
      if (cwd === "") return;
      const flags = flagsByCwd.get(cwd) ?? {};
      flags[flagId] = true;
      flagsByCwd.set(cwd, flags);
    };
    for (const activity of this.dependencies.activity.snapshot().workspaces) {
      if (activity.hasSessionActivity) setFlag(activity.cwd, CORE_STATUS_FLAGS.working);
      if (activity.hasTerminalActivity) setFlag(activity.cwd, CORE_STATUS_FLAGS.terminal);
    }
    for (const session of this.dependencies.unread.catalogSnapshot().sessions) {
      setFlag(session.cwd, CORE_STATUS_FLAGS.unread);
    }
    return flagsByCwd;
  }
}

/** Collects the child flags of each node id before the node is rolled up once. */
class FlagAccumulator {
  private readonly sourcesByNodeId = new Map<string, StatusFlags[]>();

  add(nodeId: string, flags: StatusFlags): void {
    const sources = this.sourcesByNodeId.get(nodeId) ?? [];
    sources.push(flags);
    this.sourcesByNodeId.set(nodeId, sources);
  }

  rollUp(): Record<string, StatusFlags> {
    const nodes = new Map<string, StatusFlags>();
    for (const [nodeId, sources] of this.sourcesByNodeId) nodes.set(nodeId, rollUpStatusFlags(sources));
    return Object.fromEntries(nodes);
  }
}

function isSameStatusTree(left: MachineStatusTree, right: MachineStatusTree): boolean {
  return isSameFlags(left.machine, right.machine)
    && isSameFlags(left.unattributed, right.unattributed)
    && isSameNodes(left.projects, right.projects)
    && isSameNodes(left.workspaces, right.workspaces);
}

function isSameNodes(left: Readonly<Record<string, StatusFlags>>, right: Readonly<Record<string, StatusFlags>>): boolean {
  const leftIds = Object.keys(left);
  if (leftIds.length !== Object.keys(right).length) return false;
  return leftIds.every((nodeId) => {
    const rightFlags = right[nodeId];
    return rightFlags !== undefined && isSameFlags(left[nodeId] ?? {}, rightFlags);
  });
}

function isSameFlags(left: StatusFlags, right: StatusFlags): boolean {
  const leftIds = Object.keys(left);
  if (leftIds.length !== Object.keys(right).length) return false;
  return leftIds.every((flagId) => left[flagId] === right[flagId]);
}
