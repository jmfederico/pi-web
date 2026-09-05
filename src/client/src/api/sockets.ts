import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppWebSocketUrl } from "../appUrl";

export function sessionEvents(session: SessionRef, machineId = "local"): WebSocket {
  const query = `?${new URLSearchParams({ cwd: session.cwd }).toString()}`;
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/${encodeURIComponent(session.id)}/events${query}`));
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/events`));
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/events`));
}

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}
