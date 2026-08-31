import type { GlobalSessionEvent, RealtimeEvent, SessionNotificationSummaryEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { projectBrowserSessionEvent } from "../browserMessageProjection.js";

export interface RealtimeSocket {
  readonly OPEN: number;
  readyState: number;
  send(payload: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): unknown;
}

/** Synchronous per-session event consumer (web push today); must not throw — see {@link SessionEventHub.subscribe}. */
export type SessionEventListener = (sessionId: string, event: SessionUiEvent) => void;

export class SessionEventHub {
  private readonly socketsBySession = new Map<string, Set<RealtimeSocket>>();
  private readonly globalSockets = new Set<RealtimeSocket>();
  private readonly sessionListeners = new Set<SessionEventListener>();
  private readonly seqBySession = new Map<string, number>();
  private globalJoinFrame: (() => RealtimeEvent) | undefined;

  add(sessionId: string, socket: RealtimeSocket): void {
    let sockets = this.socketsBySession.get(sessionId);
    if (!sockets) {
      sockets = new Set();
      this.socketsBySession.set(sessionId, sockets);
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  }

  /**
   * Frame sent to each global subscriber the moment it joins, before any live
   * event. It closes the join race for state the browser would otherwise only
   * fetch over HTTP: with two proxy hops in federation, that fetch can resolve
   * before the upstream subscription exists and then be clobbered by a stale
   * value.
   */
  setGlobalJoinFrame(frame: () => RealtimeEvent): void {
    this.globalJoinFrame = frame;
  }

  addGlobal(socket: RealtimeSocket): void {
    this.globalSockets.add(socket);
    socket.on("close", () => this.globalSockets.delete(socket));
    const joinFrame = this.globalJoinFrame?.();
    if (joinFrame !== undefined) this.sendToSocket(this.globalSockets, socket, JSON.stringify(joinFrame));
  }

  /**
   * Subscribe a non-socket consumer to every per-session event as it is published. Listeners run
   * synchronously on the publish hot path with the same browser-projected payload sockets receive,
   * and must never throw: this hub also serves realtime delivery, so listener faults are the
   * subscriber's problem (the web push notifier translates its own errors internally).
   * Returns an unsubscribe function.
   */
  subscribe(listener: SessionEventListener): () => void {
    this.sessionListeners.add(listener);
    return (): void => { this.sessionListeners.delete(listener); };
  }

  publish(sessionId: string, event: SessionUiEvent): void {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    const projected = projectBrowserSessionEvent(event);
    this.sendToSockets(this.socketsBySession.get(sessionId), JSON.stringify({ ...projected, seq }));
    // Iterate a copy: listeners may unsubscribe (e.g. notifier teardown) while running.
    for (const listener of [...this.sessionListeners]) listener(sessionId, projected);
  }

  /**
   * Last per-session sequence number stamped by {@link publish} (0 before any
   * event). Callers building a join-time stream snapshot read this as the
   * watermark: buffered live events with `seq <= currentSeq` are already
   * reflected in the snapshot's partial and must be dropped by the client.
   */
  currentSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }

  publishGlobal(event: GlobalSessionEvent): void {
    this.publishRealtime(event);
  }

  publishNotificationSummary(event: SessionNotificationSummaryEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  publishRealtime(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  private sendToSockets(sockets: Set<RealtimeSocket> | undefined, payload: string): void {
    if (sockets === undefined) return;
    for (const socket of sockets) this.sendToSocket(sockets, socket, payload);
  }

  private sendToSocket(sockets: Set<RealtimeSocket>, socket: RealtimeSocket, payload: string): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
      try {
        socket.terminate();
      } catch {
        // Removal is authoritative; cleanup failure must not block healthy sockets.
      }
    }
  }
}
