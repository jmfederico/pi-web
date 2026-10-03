import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, isPiWebCapability, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("keeps conditional web capabilities out of the static runtime snapshot", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toEqual([PI_WEB_CAPABILITIES.pluginLifecycle]);
    expect(WEB_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.safeTunnel);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.pluginLifecycle);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.safeTunnel);

    expect(effectivePiWebCapabilities({
      web: {
        available: true,
        capabilities: [
          PI_WEB_CAPABILITIES.pluginLifecycle,
          PI_WEB_CAPABILITIES.safeTunnel,
        ],
      },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([
      PI_WEB_CAPABILITIES.pluginLifecycle,
      PI_WEB_CAPABILITIES.safeTunnel,
    ]);
  });

  it("computes no effective capabilities when the registry entry is not advertised", () => {
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [] },
    })).toEqual([]);
  });

  it("parses only current capability strings from runtime data", () => {
    expect(parseKnownPiWebCapabilities([
      "plugins.lifecycle",
      "safeTunnel",
      "piPackages.manage",
      "future.capability",
    ])).toEqual(["plugins.lifecycle", "safeTunnel"]);
    expect(parseKnownPiWebCapabilities(["future.capability", 1])).toBeUndefined();
    expect(isPiWebCapability("plugins.lifecycle")).toBe(true);
    expect(isPiWebCapability("safeTunnel")).toBe(true);
    expect(isPiWebCapability("piPackages.manage")).toBe(false);
    expect(isPiWebCapability("future.capability")).toBe(false);
  });
});
