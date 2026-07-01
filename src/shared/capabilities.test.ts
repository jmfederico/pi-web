import { describe, expect, it } from "vitest";
import { effectivePiWebCapabilities, PI_WEB_CAPABILITIES, SESSIOND_RUNTIME_CAPABILITIES, WEB_RUNTIME_CAPABILITIES, parseKnownPiWebCapabilities } from "./capabilities";

describe("PI WEB capabilities", () => {
  it("advertises Pi package management from the web runtime only", () => {
    expect(WEB_RUNTIME_CAPABILITIES).toContain(PI_WEB_CAPABILITIES.piPackagesManage);
    expect(SESSIOND_RUNTIME_CAPABILITIES).not.toContain(PI_WEB_CAPABILITIES.piPackagesManage);

    expect(effectivePiWebCapabilities({
      web: { available: true, capabilities: [PI_WEB_CAPABILITIES.piPackagesManage] },
      sessiond: { available: false, capabilities: [] },
    })).toEqual([PI_WEB_CAPABILITIES.piPackagesManage]);
  });

  it("keeps only known string capabilities when parsing runtime data", () => {
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.piPackagesManage, "future.capability"])).toEqual([PI_WEB_CAPABILITIES.piPackagesManage]);
    expect(parseKnownPiWebCapabilities([PI_WEB_CAPABILITIES.piPackagesManage, 1])).toBeUndefined();
  });
});
