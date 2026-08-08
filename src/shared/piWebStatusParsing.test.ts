import { describe, expect, it } from "vitest";
import { PI_WEB_CAPABILITIES } from "./capabilities";
import { parsePiWebComponentStatus, parsePiWebInstallationInfo, parsePiWebRuntimeResponse, parsePiWebVersionResponse } from "./piWebStatusParsing";

describe("PI WEB status parsing", () => {
  it("keeps known capabilities while dropping retired and unknown strings", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.automations, "piPackages.manage", "future.capability"] },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: [PI_WEB_CAPABILITIES.automations, "future.sessiondCapability"] },
      },
      capabilities: [PI_WEB_CAPABILITIES.automations, "piPackages.manage", "future.capability"],
    })).toMatchObject({
      components: {
        web: { capabilities: [PI_WEB_CAPABILITIES.automations] },
        sessiond: { capabilities: [PI_WEB_CAPABILITIES.automations] },
      },
      capabilities: [PI_WEB_CAPABILITIES.automations],
    });
  });

  it("rejects runtime responses with malformed component capability arrays", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: ["piPackages.manage", 1] },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [] },
      },
      capabilities: ["piPackages.manage"],
    })).toBeUndefined();
  });

  it("parses and freezes a session daemon active agent profile", () => {
    const parsed = parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [] },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          available: true,
          capabilities: [],
          activeAgentProfile: {
            schemaVersion: 1,
            revision: `sha256:${"a".repeat(64)}`,
            command: "acme-agent",
            dir: "/opt/acme-agent/state",
            sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
          },
        },
      },
      capabilities: [],
    });

    expect(parsed?.components.sessiond.activeAgentProfile).toMatchObject({ command: "acme-agent", dir: "/opt/acme-agent/state" });
    expect(Object.isFrozen(parsed?.components.sessiond.activeAgentProfile)).toBe(true);
    expect(Object.isFrozen(parsed?.components.sessiond.activeAgentProfile?.sessionDirEnvKeys)).toBe(true);
  });

  it("rejects malformed, secret-bearing, or web-owned active profile descriptors", () => {
    const profile = {
      schemaVersion: 1,
      revision: `sha256:${"a".repeat(64)}`,
      command: "acme-agent",
      dir: "/opt/acme-agent/state",
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
    };
    const responseFor = (webProfile: unknown, sessiondProfile: unknown) => ({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", available: true, capabilities: [], ...(webProfile === undefined ? {} : { activeAgentProfile: webProfile }) },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], ...(sessiondProfile === undefined ? {} : { activeAgentProfile: sessiondProfile }) },
      },
      capabilities: [],
    });

    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, token: "secret" }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, command: "./acme-agent" }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, dir: "relative/state" }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, sessionDirEnvKeys: ["ARBITRARY_AGENT_SESSION_DIR"] }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(profile, undefined))).toBeUndefined();
  });

  it("parses Docker installation metadata", () => {
    expect(parsePiWebInstallationInfo({ kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" })).toEqual({
      kind: "docker",
      path: "/srv/pi-web-docker",
      dockerMode: "runtime",
    });
    expect(parsePiWebInstallationInfo({ kind: "docker", path: "/workspace/pi-web", dockerMode: "dev" })).toEqual({
      kind: "docker",
      path: "/workspace/pi-web",
      dockerMode: "dev",
    });
  });

  it("ignores invalid optional Docker modes without rejecting component status", () => {
    expect(parsePiWebComponentStatus({
      component: "web",
      label: "Web/UI",
      runtimeVersion: "1.0.0",
      stale: false,
      available: true,
      installation: { kind: "docker", path: "/workspace/pi-web", dockerMode: "hidden" },
    })?.installation).toEqual({ kind: "docker", path: "/workspace/pi-web" });
  });

  it("parses version responses that include Docker runtime and development components", () => {
    const parsed = parsePiWebVersionResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", stale: false, available: true, installation: { kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" } },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", stale: false, available: true, installation: { kind: "docker", path: "/workspace/pi-web", dockerMode: "dev" } },
      },
    });

    expect(parsed?.components.web.installation).toEqual({ kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" });
    expect(parsed?.components.sessiond.installation).toEqual({ kind: "docker", path: "/workspace/pi-web", dockerMode: "dev" });
  });
});
