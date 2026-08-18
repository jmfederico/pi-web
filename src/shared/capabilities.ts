import { PI_WEB_CAPABILITIES, type PiWebCapability, type PiWebRuntimeComponent, type PiWebServiceComponent } from "./apiTypes.js";

export { PI_WEB_CAPABILITIES };
export type { PiWebCapability };

// Annotated (not inferred) so the empty and populated registry shapes are
// identical for consumers: `Object.values` on the empty registry alone would
// not infer `PiWebCapability[]`.
export const KNOWN_PI_WEB_CAPABILITIES: PiWebCapability[] = Object.values(PI_WEB_CAPABILITIES);
const knownPiWebCapabilities: ReadonlySet<string> = new Set(KNOWN_PI_WEB_CAPABILITIES);

export const WEB_RUNTIME_CAPABILITIES = [
  PI_WEB_CAPABILITIES.pluginLifecycle,
] as const satisfies readonly PiWebCapability[];

export const SESSIOND_RUNTIME_CAPABILITIES = [] as const satisfies readonly PiWebCapability[];

// Populated entries map each capability to the components that must both
// advertise it.
const EFFECTIVE_CAPABILITY_REQUIREMENTS = {
  [PI_WEB_CAPABILITIES.pluginLifecycle]: ["web"],
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
    const requiredComponents: readonly PiWebServiceComponent[] = EFFECTIVE_CAPABILITY_REQUIREMENTS[capability];
    return requiredComponents.every((component) => {
      const runtime = components[component];
      return runtime?.available === true && supportsPiWebCapability(runtime, capability);
    });
  });
}
