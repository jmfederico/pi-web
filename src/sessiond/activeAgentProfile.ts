import { createHash } from "node:crypto";
import { isHostAbsoluteAgentDir, isSafeAgentCommandForHost, PI_CODING_AGENT_SESSION_DIR_ENV, PI_WEB_AGENT_SESSION_DIR_ENV, type EffectivePiWebAgentConfig } from "../config.js";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import { ACTIVE_AGENT_PROFILE_SCHEMA_VERSION } from "../shared/activeAgentProfile.js";

export function createActiveAgentProfileDescriptor(agent: EffectivePiWebAgentConfig): ActiveAgentProfileDescriptor {
  if (!isSafeAgentCommandForHost(agent.command) || !isHostAbsoluteAgentDir(agent.dir)) {
    throw new Error("Active agent profile command and directory must be valid for this host");
  }
  if (!hasValidSessionDirEnvKeys(agent.sessionDirEnvKeys)) {
    throw new Error("Active agent profile session directory environment keys must use the explicit PI WEB policy");
  }
  const sessionDirEnvKeys = Object.freeze([...agent.sessionDirEnvKeys]);
  const revisionInput = JSON.stringify({
    schemaVersion: ACTIVE_AGENT_PROFILE_SCHEMA_VERSION,
    command: agent.command,
    dir: agent.dir,
    sessionDirEnvKeys,
  });

  return Object.freeze({
    schemaVersion: ACTIVE_AGENT_PROFILE_SCHEMA_VERSION,
    revision: `sha256:${createHash("sha256").update(revisionInput).digest("hex")}`,
    command: agent.command,
    dir: agent.dir,
    sessionDirEnvKeys,
  });
}

function hasValidSessionDirEnvKeys(keys: readonly string[]): boolean {
  return (keys.length === 1 || keys.length === 2)
    && keys[0] === PI_WEB_AGENT_SESSION_DIR_ENV
    && (keys.length === 1 || keys[1] === PI_CODING_AGENT_SESSION_DIR_ENV);
}
