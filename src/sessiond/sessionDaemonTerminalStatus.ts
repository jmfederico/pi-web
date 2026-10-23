import { SessionDaemonClient, type SessionDaemonRequestClient } from "./sessionDaemonClient.js";
import { parseTerminalServiceStatus, type TerminalServiceStatus } from "../shared/terminalServiceStatus.js";

export async function getSessionDaemonTerminalStatus(client: SessionDaemonRequestClient = new SessionDaemonClient()): Promise<TerminalServiceStatus> {
  try {
    const response = await client.request("GET", "/terminal-status", undefined, { signal: AbortSignal.timeout(2_000) });
    if (response.statusCode !== 200) throw new Error(`Session daemon returned HTTP ${String(response.statusCode)}`);
    const value: unknown = JSON.parse(response.body);
    const status = parseTerminalServiceStatus(value);
    if (status === undefined) throw new Error("Invalid Terminal status response");
    return status;
  } catch (error) {
    return { state: "unavailable", message: `Could not read the running Terminal state: ${error instanceof Error ? error.message : String(error)}. Restart the session daemon after updating PI WEB, then run pi-web doctor again.` };
  }
}

export function formatTerminalServiceStatus(status: TerminalServiceStatus): { ok: boolean; lines: string[] } {
  if (status.state === "disabled") return { ok: true, lines: ["- Terminal plugin is disabled", `  ${status.message}`] };
  if (status.state === "unavailable") return { ok: false, lines: ["✗ Terminal plugin is unavailable", `  ${status.message}`] };
  const ok = status.health !== "unhealthy";
  const marker = status.health === "healthy" ? "✓" : ok ? "!" : "✗";
  return { ok, lines: [`${marker} Terminal plugin is active (${status.health})`, ...(status.message === undefined ? [] : [`  ${status.message}`])] };
}
