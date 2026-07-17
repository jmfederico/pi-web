import type { GlobalSessionEvent, RealtimeEvent, SessionUiEvent } from "../../shared/apiTypes.js";
import { projectBrowserSessionEvent } from "../browserMessageProjection.js";

export interface RealtimeSocket {
  readonly OPEN: number;
  readyState: number;
  send(payload: string): void;
  on(event: "close", listener: () => void): unknown;
}

export class SessionEventHub {
  private readonly socketsBySession = new Map<string, Set<RealtimeSocket>>();
  private readonly globalSockets = new Set<RealtimeSocket>();

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

  addGlobal(socket: RealtimeSocket): void {
    this.globalSockets.add(socket);
    socket.on("close", () => this.globalSockets.delete(socket));
  }

  publish(sessionId: string, event: SessionUiEvent): void {
    const payload = JSON.stringify(projectBrowserSessionEvent(event));
    this.sendToSockets(this.socketsBySession.get(sessionId), payload);
  }

  publishGlobal(event: GlobalSessionEvent): void {
    this.publishRealtime(event);
  }

  publishRealtime(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  private sendToSockets(sockets: Set<RealtimeSocket> | undefined, payload: string): void {
    if (sockets === undefined) return;
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        sockets.delete(socket);
      }
    }
  }
}
