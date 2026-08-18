import { isSessionActive } from "../../shared/activity.js";
import type { SessionActivity, SessionStatus, TerminalInfo } from "../../shared/apiTypes.js";

/** One working directory that currently has session or terminal activity. */
export interface ActiveWorkspaceActivity {
  cwd: string;
  hasSessionActivity: boolean;
  hasTerminalActivity: boolean;
}

interface SessionRecord {
  cwd: string;
  status?: SessionStatus;
  activity?: SessionActivity;
}

interface TerminalRecord {
  cwd: string;
}

/**
 * In-memory record of which working directories currently have session or
 * terminal activity.
 *
 * It publishes nothing itself: attribution and roll-up belong to the machine
 * status projection, which this service notifies whenever the record changes.
 */
export class WorkspaceActivityService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(private readonly onChanged?: () => void) {}

  applySessionStatus(cwd: string, status: SessionStatus): void {
    const previousCwd = this.sessions.get(status.sessionId)?.cwd;
    const record = this.sessions.get(status.sessionId) ?? { cwd };
    record.cwd = cwd;
    record.status = status;
    if (!isSessionActive(status) && record.activity?.phase === "active") delete record.activity;
    this.sessions.set(status.sessionId, record);
    this.pruneIdleSession(status.sessionId);
    this.notifyChangedCwds(previousCwd, cwd);
  }

  applySessionActivity(cwd: string, activity: SessionActivity): void {
    const previousCwd = this.sessions.get(activity.sessionId)?.cwd;
    const record = this.sessions.get(activity.sessionId) ?? { cwd };
    record.cwd = cwd;
    record.activity = activity;
    this.sessions.set(activity.sessionId, record);
    this.pruneIdleSession(activity.sessionId);
    this.notifyChangedCwds(previousCwd, cwd);
  }

  removeSession(sessionId: string, cwd?: string): void {
    const previousCwd = this.sessions.get(sessionId)?.cwd ?? cwd;
    this.sessions.delete(sessionId);
    this.notifyCwd(previousCwd);
  }

  reconcileSessionActivity(cwd: string, sessionIds: Iterable<string>): void {
    const knownSessionIds = new Set(sessionIds);
    let changed = false;
    for (const [sessionId, record] of this.sessions.entries()) {
      if (record.cwd !== cwd || knownSessionIds.has(sessionId)) continue;
      this.sessions.delete(sessionId);
      changed = true;
    }
    if (changed) this.notifyCwd(cwd);
  }

  updateTerminal(terminal: Pick<TerminalInfo, "id" | "cwd" | "exited">): void {
    const previousCwd = this.terminals.get(terminal.id)?.cwd;
    if (terminal.exited) this.terminals.delete(terminal.id);
    else this.terminals.set(terminal.id, { cwd: terminal.cwd });
    this.notifyChangedCwds(previousCwd, terminal.cwd);
  }

  removeTerminal(terminalId: string, cwd?: string): void {
    const previousCwd = this.terminals.get(terminalId)?.cwd ?? cwd;
    this.terminals.delete(terminalId);
    this.notifyCwd(previousCwd);
  }

  snapshot(): { workspaces: ActiveWorkspaceActivity[] } {
    return { workspaces: this.activeCwds().map((cwd) => this.summaryForCwd(cwd)) };
  }

  private pruneIdleSession(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record !== undefined && !isSessionActive(record.status, record.activity)) this.sessions.delete(sessionId);
  }

  private notifyChangedCwds(previousCwd: string | undefined, cwd: string): void {
    this.notifyCwd(previousCwd);
    if (previousCwd !== cwd) this.notifyCwd(cwd);
  }

  /**
   * The listener recomputes the whole projection, so it is told that something
   * changed rather than which cwd changed. Repeated notifications are harmless:
   * the projection publishes only when the computed tree actually differs.
   */
  private notifyCwd(cwd: string | undefined): void {
    if (cwd === undefined || cwd === "") return;
    this.onChanged?.();
  }

  private activeCwds(): string[] {
    const cwds = new Set<string>();
    for (const record of this.sessions.values()) {
      if (isSessionActive(record.status, record.activity)) cwds.add(record.cwd);
    }
    for (const record of this.terminals.values()) cwds.add(record.cwd);
    return [...cwds].sort((a, b) => a.localeCompare(b));
  }

  private summaryForCwd(cwd: string): ActiveWorkspaceActivity {
    return {
      cwd,
      hasSessionActivity: [...this.sessions.values()].some((record) => record.cwd === cwd && isSessionActive(record.status, record.activity)),
      hasTerminalActivity: [...this.terminals.values()].some((terminal) => terminal.cwd === cwd),
    };
  }
}
