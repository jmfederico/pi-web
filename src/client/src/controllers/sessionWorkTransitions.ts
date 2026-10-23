import { isSessionActive } from "../../../shared/activity";
import type { GlobalSessionEvent } from "../sessionSocket";
import type { SessionStatus } from "../api";

type SessionWorkEvent = Extract<GlobalSessionEvent, { type: "status.update" | "activity.update" }>;

interface ObservedWork {
  statusActive: boolean;
  activityActive: boolean;
}

/** Tracks runtime observations, never selection state. */
export class SessionWorkTransitions {
  private readonly active = new Map<string, ObservedWork>();
  private readonly revisions = new Map<string, number>();
  private generation = 0;

  /** Return the session whose observed work became idle (including aborts/errors). */
  observe(machineId: string, event: SessionWorkEvent): string | undefined {
    const sessionId = event.type === "status.update" ? event.status.sessionId : event.activity.sessionId;
    const key = JSON.stringify([machineId, sessionId]);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    const previous = this.active.get(key);
    const next = { statusActive: previous?.statusActive ?? false, activityActive: previous?.activityActive ?? false };
    if (event.type === "status.update") {
      next.statusActive = isSessionActive(event.status);
      // An authoritative idle status supersedes a stale active activity label,
      // matching the session controller's status projection.
      if (!next.statusActive) next.activityActive = false;
    } else next.activityActive = isSessionActive(undefined, event.activity);
    if (next.statusActive || next.activityActive) {
      this.active.set(key, next);
      return undefined;
    }
    this.active.delete(key);
    return previous === undefined ? undefined : sessionId;
  }

  /** Capture before a read so a late snapshot cannot overwrite a newer runtime event. */
  snapshotObserver(machineId: string, sessionId: string): (status: SessionStatus) => string | undefined {
    const key = JSON.stringify([machineId, sessionId]);
    const revision = this.revisions.get(key);
    const generation = this.generation;
    return (status) => {
      if (status.sessionId !== sessionId || generation !== this.generation || this.revisions.get(key) !== revision) return undefined;
      return this.observe(machineId, { type: "status.update", status });
    };
  }

  clear(): void {
    this.active.clear();
    this.revisions.clear();
    this.generation += 1;
  }
}
