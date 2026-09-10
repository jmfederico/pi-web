import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, isPiWebCapability, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("advertises plugin lifecycle as a web-only capability that does not require session daemon support", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.pluginLifecycle);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.pluginLifecycle);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.pluginLifecycle] },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([PI_WEB_CAPABILITIES.pluginLifecycle]);
  });

  it("advertises OMP session creation only when both the web server and session daemon support it", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.ompSessionBackend);
    expect(SESSIOND_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.ompSessionBackend);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.ompSessionBackend] },
      sessiond: { available: true, capabilities: [] },
    })).not.toContain(PI_WEB_CAPABILITIES.ompSessionBackend);
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.ompSessionBackend] },
      sessiond: { available: true, capabilities: [PI_WEB_CAPABILITIES.ompSessionBackend] },
    })).toContain(PI_WEB_CAPABILITIES.ompSessionBackend);
  });

  it("computes no effective capabilities when the registry entry is not advertised", () => {
    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [] },
      sessiond: { available: true, capabilities: [] },
    })).toEqual([]);
  });

  it("parses only current capability strings from runtime data", () => {
    expect(parseKnownPiWebCapabilities(["plugins.lifecycle", "sessions.backend.omp", "piPackages.manage", "future.capability"])).toEqual([
      PI_WEB_CAPABILITIES.pluginLifecycle,
      PI_WEB_CAPABILITIES.ompSessionBackend,
    ]);
    expect(parseKnownPiWebCapabilities(["future.capability", 1])).toBeUndefined();
    expect(isPiWebCapability(PI_WEB_CAPABILITIES.pluginLifecycle)).toBe(true);
    expect(isPiWebCapability(PI_WEB_CAPABILITIES.ompSessionBackend)).toBe(true);
    expect(isPiWebCapability("piPackages.manage")).toBe(false);
    expect(isPiWebCapability("future.capability")).toBe(false);
  });
});
