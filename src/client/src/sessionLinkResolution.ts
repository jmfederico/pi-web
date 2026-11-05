import type { Machine, SessionLocation } from "../../shared/apiTypes";
import { isCreatingSessionId, type ParsedAppRoute } from "./route";

/**
 * Asks one machine where a session lives. Resolves `undefined` when the machine
 * does not know the session; rejects when the machine could not be asked.
 */
export type SessionLocator = (sessionId: string, machineId: string, signal: AbortSignal) => Promise<SessionLocation | undefined>;

export type SessionLinkResolution =
  | { kind: "workspace"; machineId: string; projectId: string; workspaceId: string }
  | { kind: "not-found"; uncheckedMachineIds: readonly string[] };

/**
 * A link that names a session but not where it lives, such as
 * `?session=<PI_SESSION_ID>` written by an agent that only knows its own id.
 */
export function isSessionOnlyRoute(route: ParsedAppRoute): route is ParsedAppRoute & { sessionId: string } {
  return route.sessionId !== undefined
    && !isCreatingSessionId(route.sessionId)
    && route.projectId === undefined
    && route.workspaceId === undefined;
}

/**
 * Machines to ask, in priority order: only the linked machine when the link
 * names one, otherwise this machine first and then remote machines in their
 * configured order.
 */
export function sessionLinkMachineOrder(machines: readonly Pick<Machine, "id" | "kind">[], routeMachineId: string | undefined): string[] {
  if (routeMachineId !== undefined) return [routeMachineId];
  return ["local", ...machines.filter((machine) => machine.kind === "remote").map((machine) => machine.id)];
}

/**
 * Asks every machine at once but answers in priority order, so a session found
 * on an earlier machine wins without waiting on slower or offline ones.
 * Outstanding lookups are aborted once the answer is known.
 */
export async function resolveSessionLink(sessionId: string, machineIds: readonly string[], locate: SessionLocator): Promise<SessionLinkResolution> {
  const controller = new AbortController();
  const lookups = machineIds.map((machineId) => locate(sessionId, machineId, controller.signal).then(
    (location) => ({ machineId, location, checked: true as const }),
    () => ({ machineId, location: undefined, checked: false as const }),
  ));
  const uncheckedMachineIds: string[] = [];
  try {
    for (const lookup of lookups) {
      const { machineId, location, checked } = await lookup;
      if (!checked) uncheckedMachineIds.push(machineId);
      else if (location !== undefined) return { kind: "workspace", machineId, projectId: location.projectId, workspaceId: location.workspaceId };
    }
  } finally {
    controller.abort();
  }
  return { kind: "not-found", uncheckedMachineIds };
}
