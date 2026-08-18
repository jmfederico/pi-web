import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppWebSocketUrl } from "../appUrl";

export function sessionEvents(session: SessionRef, machineId = "local"): WebSocket {
  const query = `?${new URLSearchParams({ cwd: session.cwd }).toString()}`;
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/${encodeURIComponent(session.id)}/events${query}`));
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/events`));
}

export function terminalSocket(projectId: string, workspaceId: string, terminalId: string, initialSize?: { cols: number; rows: number }, machineId = "local"): WebSocket {
  const sizeQuery = initialSize === undefined ? "" : `?${new URLSearchParams({ cols: String(initialSize.cols), rows: String(initialSize.rows) }).toString()}`;
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/socket${sizeQuery}`));
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/events`));
}

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}
