import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, isPiWebCapability, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("advertises plugin lifecycle as a web-only capability that does not require session daemon support", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toEqual([PI_WEB_CAPABILITIES.pluginLifecycle]);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.pluginLifecycle);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.pluginLifecycle] },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([PI_WEB_CAPABILITIES.pluginLifecycle]);
  });

  it("computes no effective capabilities when the registry entry is not advertised", () => {
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [] },
    })).toEqual([]);
  });

  it("parses only current capability strings from runtime data", () => {
    expect(parseKnownPiWebCapabilities(["plugins.lifecycle", "piPackages.manage", "future.capability"])).toEqual(["plugins.lifecycle"]);
    expect(parseKnownPiWebCapabilities(["future.capability", 1])).toBeUndefined();
    expect(isPiWebCapability("plugins.lifecycle")).toBe(true);
    expect(isPiWebCapability("piPackages.manage")).toBe(false);
    expect(isPiWebCapability("future.capability")).toBe(false);
  });
});
