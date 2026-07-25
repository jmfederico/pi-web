import type { SessionRef } from "../../../shared/apiTypes";
import { resolveAppWebSocketUrl } from "../appUrl";
import { storedToken } from "../passwordAuth";

type SessionLookup = SessionRef | string;

function authQuery(): string {
  const token = storedToken();
  if (token === null) return "";
  const params = new URLSearchParams();
  params.set("token", token);
  return params.toString();
}

function appendAuth(url: string, existingQuery: string): string {
  const auth = authQuery();
  if (auth === "") return url + existingQuery;
  const separator = existingQuery === "" ? "?" : "&";
  return url + existingQuery + separator + auth;
}

export function sessionEvents(session: SessionLookup, machineId = "local"): WebSocket {
  const cwd = typeof session === "string" ? undefined : session.cwd;
  const query = cwd === undefined || cwd === "" ? "" : `?${new URLSearchParams({ cwd }).toString()}`;
  const sessionId = typeof session === "string" ? session : session.id;
  return new WebSocket(appendAuth(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/${encodeURIComponent(sessionId)}/events`), query));
}

export function globalSessionEvents(machineId = "local"): WebSocket {
  return new WebSocket(appendAuth(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/sessions/events`), ""));
}

export function terminalSocket(projectId: string, workspaceId: string, terminalId: string, initialSize?: { cols: number; rows: number }, machineId = "local"): WebSocket {
  const sizeQuery = initialSize === undefined ? "" : `?${new URLSearchParams({ cols: String(initialSize.cols), rows: String(initialSize.rows) }).toString()}`;
  return new WebSocket(appendAuth(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(terminalId)}/socket`), sizeQuery));
}

export function realtimeEvents(machineId = "local"): WebSocket {
  return new WebSocket(appendAuth(resolveAppWebSocketUrl(`${machinePrefix(machineId)}/events`), ""));
}

function machinePrefix(machineId: string): string {
  return `api/machines/${encodeURIComponent(machineId)}`;
}
