import { PI_WEB_CAPABILITIES, type PiWebCapability, type PiWebRuntimeComponent, type PiWebServiceComponent } from "./apiTypes.js";

export { PI_WEB_CAPABILITIES };
export type { PiWebCapability };

export const KNOWN_PI_WEB_CAPABILITIES = Object.values(PI_WEB_CAPABILITIES);
const knownPiWebCapabilities: ReadonlySet<string> = new Set(KNOWN_PI_WEB_CAPABILITIES);

export const WEB_RUNTIME_CAPABILITIES = [
  PI_WEB_CAPABILITIES.sessionsDeleteArchived,
  PI_WEB_CAPABILITIES.sessionsBulkMutations,
  PI_WEB_CAPABILITIES.sessionsCleanup,
  PI_WEB_CAPABILITIES.sessionsReload,
  PI_WEB_CAPABILITIES.sessionsClearQueue,
  PI_WEB_CAPABILITIES.sessionsPersistedState,
  PI_WEB_CAPABILITIES.promptAttachments,
  PI_WEB_CAPABILITIES.workspaceFileSuggestions,
  PI_WEB_CAPABILITIES.piPackagesManage,
  PI_WEB_CAPABILITIES.selectedMachineSettings,
  PI_WEB_CAPABILITIES.agentProfileConfig,
] as const satisfies readonly PiWebCapability[];

export const SESSIOND_RUNTIME_CAPABILITIES = [
  PI_WEB_CAPABILITIES.sessionsDeleteArchived,
  PI_WEB_CAPABILITIES.sessionsBulkMutations,
  PI_WEB_CAPABILITIES.sessionsCleanup,
  PI_WEB_CAPABILITIES.sessionsReload,
  PI_WEB_CAPABILITIES.sessionsClearQueue,
  PI_WEB_CAPABILITIES.sessionsPersistedState,
  PI_WEB_CAPABILITIES.promptAttachments,
] as const satisfies readonly PiWebCapability[];

const EFFECTIVE_CAPABILITY_REQUIREMENTS = {
  [PI_WEB_CAPABILITIES.sessionsDeleteArchived]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.sessionsBulkMutations]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.sessionsCleanup]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.sessionsReload]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.sessionsClearQueue]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.sessionsPersistedState]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.promptAttachments]: ["web", "sessiond"],
  [PI_WEB_CAPABILITIES.workspaceFileSuggestions]: ["web"],
  [PI_WEB_CAPABILITIES.piPackagesManage]: ["web"],
  [PI_WEB_CAPABILITIES.selectedMachineSettings]: ["web"],
  [PI_WEB_CAPABILITIES.agentProfileConfig]: ["web"],
} as const satisfies Record<PiWebCapability, readonly PiWebServiceComponent[]>;

export function isPiWebCapability(value: unknown): value is PiWebCapability {
  return typeof value === "string" && knownPiWebCapabilities.has(value);
}

export function supportsPiWebCapability(source: { capabilities?: readonly PiWebCapability[] } | undefined, capability: PiWebCapability): boolean {
  return source?.capabilities?.includes(capability) === true;
}

export function parseKnownPiWebCapabilities(value: unknown): PiWebCapability[] | undefined {
  if (!Array.isArray(value) || !value.every((capability) => typeof capability === "string")) return undefined;
  return value.filter(isPiWebCapability);
}

export function effectivePiWebCapabilities(components: Partial<Record<PiWebServiceComponent, Pick<PiWebRuntimeComponent, "available" | "capabilities">>>): PiWebCapability[] {
  return KNOWN_PI_WEB_CAPABILITIES.filter((capability) => {
    const requiredComponents = EFFECTIVE_CAPABILITY_REQUIREMENTS[capability];
    return requiredComponents.every((component) => {
      const runtime = components[component];
      return runtime?.available === true && supportsPiWebCapability(runtime, capability);
    });
  });
}
