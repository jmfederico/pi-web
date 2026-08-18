import { describe, expect, it } from "vitest";
import { parsePiWebComponentStatus, parsePiWebInstallationInfo, parsePiWebRuntimeResponse, parsePiWebVersionResponse } from "./piWebStatusParsing";

describe("PI WEB status parsing", () => {
  it("drops every advertised capability string while the registry is empty", () => {
    expect(parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", available: true, capabilities: ["piPackages.manage", "future.capability"] },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", available: true, capabilities: ["future.sessiondCapability"] },
      },
      capabilities: ["piPackages.manage", "future.capability"],
    })).toMatchObject({
      components: {
        web: { capabilities: [] },
        sessiond: { capabilities: [] },
      },
      capabilities: [],
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
            schemaVersion: 2,
            dir: "/opt/pi/state",
          },
        },
      },
      capabilities: [],
    });

    expect(parsed?.components.sessiond.activeAgentProfile).toEqual({ schemaVersion: 2, dir: "/opt/pi/state" });
    expect(Object.isFrozen(parsed?.components.sessiond.activeAgentProfile)).toBe(true);
  });

  it("rejects malformed, secret-bearing, or web-owned active profile descriptors", () => {
    const profile = {
      schemaVersion: 2,
      dir: "/opt/pi/state",
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
    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, dir: "relative/state" }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(undefined, { ...profile, schemaVersion: 1 }))).toBeUndefined();
    expect(parsePiWebRuntimeResponse(responseFor(profile, undefined))).toBeUndefined();
  });

  it("carries per-component deprecated agent input reports through runtime responses", () => {
    const parsed = parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: {
          component: "web",
          label: "Web/UI",
          available: true,
          capabilities: [],
          deprecatedAgentInputs: [
            { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
            { source: "config", name: "agent.command" },
          ],
        },
        sessiond: {
          component: "sessiond",
          label: "Session daemon",
          available: true,
          capabilities: [],
          deprecatedAgentInputs: [{ source: "environment", name: "PI_WEB_AGENT_SESSION_DIR", replacement: "PI_CODING_AGENT_SESSION_DIR" }],
        },
      },
      capabilities: [],
    });

    expect(parsed?.components.web.deprecatedAgentInputs).toEqual([
      { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
      { source: "config", name: "agent.command" },
    ]);
    expect(parsed?.components.sessiond.deprecatedAgentInputs).toEqual([
      { source: "environment", name: "PI_WEB_AGENT_SESSION_DIR", replacement: "PI_CODING_AGENT_SESSION_DIR" },
    ]);
  });

  it("drops malformed deprecated-input reports without failing the runtime response", () => {
    const parsed = parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: {
          component: "web",
          label: "Web/UI",
          available: true,
          capabilities: [],
          deprecatedAgentInputs: [
            { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
            { source: "process", name: "PI_WEB_AGENT_DIR" },
            { source: "config" },
            { source: "config", name: "agent.dir", replacement: 42 },
            "PI_WEB_AGENT_DIR",
          ],
        },
        sessiond: { component: "sessiond", label: "Session daemon", available: true, capabilities: [], deprecatedAgentInputs: "PI_WEB_AGENT_DIR" },
      },
      capabilities: [],
    });

    expect(parsed?.components.web.deprecatedAgentInputs).toEqual([
      { source: "environment", name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
    ]);
    expect(parsed?.components.sessiond).not.toHaveProperty("deprecatedAgentInputs");
  });

  it("carries reported Pi versions through component and runtime parsing", () => {
    expect(parsePiWebComponentStatus({
      component: "web",
      label: "Web/UI",
      runtimeVersion: "1.0.0",
      piVersion: "0.84.1",
      stale: false,
      available: true,
    })).toMatchObject({ runtimeVersion: "1.0.0", piVersion: "0.84.1" });

    expect(parsePiWebComponentStatus({
      component: "web",
      label: "Web/UI",
      stale: false,
      available: true,
    })).not.toHaveProperty("piVersion");

    const runtime = parsePiWebRuntimeResponse({
      packageName: "@jmfederico/pi-web",
      generatedAt: "now",
      components: {
        web: { component: "web", label: "Web/UI", runtimeVersion: "1.0.0", piVersion: "0.84.1", available: true, capabilities: [] },
        sessiond: { component: "sessiond", label: "Session daemon", runtimeVersion: "1.0.0", piVersion: "0.83.0", available: true, capabilities: [] },
      },
      capabilities: [],
    });

    expect(runtime?.components.web.piVersion).toBe("0.84.1");
    expect(runtime?.components.sessiond.piVersion).toBe("0.83.0");
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
