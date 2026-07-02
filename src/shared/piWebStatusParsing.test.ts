import { describe, expect, it } from "vitest";
import { PI_WEB_CAPABILITIES } from "./capabilities";
import { parsePiWebRuntimeResponse } from "./piWebStatusParsing";

describe("PI WEB status parsing", () => {
  it("parses known runtime capabilities and ignores unknown string capabilities", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, "future.capability"] },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: ["future.sessiondCapability"] },
      },
      capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, "future.capability"],
    })).toMatchObject({
      components: {
        web: { capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings] },
        sessiond: { capabilities: [] },
      },
      capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings],
    });
  });

  it("rejects malformed capability arrays", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [PI_WEB_CAPABILITIES.piPackagesManage, 1] },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [] },
      },
      capabilities: [PI_WEB_CAPABILITIES.piPackagesManage],
    })).toBeUndefined();
  });
});
