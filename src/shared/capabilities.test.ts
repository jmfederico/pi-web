import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, isPiWebCapability, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities, sessiondRuntimeCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("requires both web and sessiond to advertise Automations", () => {
    const automations = PI_WEB_CAPABILITIES.automations;
    expect(WEB_RUNTIME_CAPABILITIES).toEqual([automations]);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toEqual([automations]);
    expect(sessiondRuntimeCapabilities(true)).toEqual([automations]);
    expect(sessiondRuntimeCapabilities(false)).toEqual([]);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [automations] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(automations);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [automations] },
    })).not.toContain(automations);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [automations] },
      sessiond: { available: true, capabilities: [automations] },
    })).toContain(automations);
  });

  it("keeps only known string capabilities when parsing runtime data", () => {
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.automations, "future.capability"])).toEqual([PI_WEB_CAPABILITIES.automations]);
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.automations, 1])).toBeUndefined();
    expect(isPiWebCapability(PI_WEB_CAPABILITIES.automations)).toBe(true);
    expect(isPiWebCapability("future.capability")).toBe(false);
  });
});
