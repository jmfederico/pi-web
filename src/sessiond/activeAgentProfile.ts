import { isHostAbsoluteAgentDir, type EffectivePiWebAgentConfig } from "../config.js";
import type { ActiveAgentProfileDescriptor } from "../shared/apiTypes.js";
import { ACTIVE_AGENT_PROFILE_SCHEMA_VERSION } from "../shared/activeAgentProfile.js";

export function createActiveAgentProfileDescriptor(agent: EffectivePiWebAgentConfig): ActiveAgentProfileDescriptor {
  if (!isHostAbsoluteAgentDir(agent.dir)) {
    throw new Error("Active agent profile directory must be valid for this host");
  }
  return Object.freeze({
    schemaVersion: ACTIVE_AGENT_PROFILE_SCHEMA_VERSION,
    dir: agent.dir,
  });
}
