import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import {
  getSessionDaemonActiveAgentProfile,
  type SessionDaemonAgentProfileResult,
  type SessionDaemonRequestClient,
} from "../sessiond/sessionDaemonClient.js";

export interface ActiveAgentProfileProvider {
  getActiveAgentProfile(): Promise<SessionDaemonAgentProfileResult>;
}

/** Reads the daemon-owned profile on every call so a new sessiond epoch is observed. */
export class SessionDaemonActiveAgentProfileProvider implements ActiveAgentProfileProvider {
  constructor(private readonly daemon: SessionDaemonRequestClient) {}

  getActiveAgentProfile(): Promise<SessionDaemonAgentProfileResult> {
    return getSessionDaemonActiveAgentProfile(this.daemon);
  }
}

export class ActiveAgentProfileAccessError extends Error {
  readonly profileStatus: "unavailable" | "invalid";

  constructor(result: Exclude<SessionDaemonAgentProfileResult, { status: "available" }>) {
    const label = result.status === "unavailable" ? "unavailable" : "invalid";
    super(`Active agent profile is ${label}: ${result.error}`);
    this.name = "ActiveAgentProfileAccessError";
    this.profileStatus = result.status;
  }
}

export async function requireActiveAgentProfile(provider: ActiveAgentProfileProvider): Promise<ActiveAgentProfileDescriptor> {
  const result = await provider.getActiveAgentProfile();
  if (result.status !== "available") throw new ActiveAgentProfileAccessError(result);
  return result.profile;
}
