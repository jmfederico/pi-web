import { describe, expect, it } from "vitest";
import type { PiWebComponentStatus, PiWebReleaseStatus, PiWebStatusResponse, PluginMachine, Workspace } from "@jmfederico/pi-web/plugin-api";
import { componentDetails, componentHealth, diagnosticsSummary, formatVersion, installationLabel, machineKindLabel, releaseSummary, workspaceFlags } from "./infoInternals.js";

describe("componentHealth", () => {
  it("reports current when the component is available and not stale", () => {
    expect(componentHealth(componentStatus())).toBe("current");
  });

  it("reports restart needed when the installed version is newer than the running one", () => {
    expect(componentHealth(componentStatus({ stale: true }))).toBe("restart needed");
  });

  it("reports unavailable when the component cannot be reached", () => {
    expect(componentHealth(componentStatus({ available: false, stale: true }))).toBe("unavailable");
  });
});

describe("releaseSummary", () => {
  it("names the latest version when an update is available", () => {
    expect(releaseSummary(release({ updateAvailable: true, latestVersion: "1.2.3" }))).toBe("Update available: 1.2.3");
  });

  it("still reports an update when the latest version is unknown", () => {
    expect(releaseSummary(release({ updateAvailable: true }))).toBe("Update available");
  });

  it("surfaces a failed release check", () => {
    expect(releaseSummary(release({ error: "registry unreachable" }))).toBe("Update check failed: registry unreachable");
  });

  it("reports skipped checks distinctly from an up-to-date install", () => {
    expect(releaseSummary(release({ skipped: true }))).toBe("Update check skipped");
    expect(releaseSummary(release())).toBe("Up to date");
  });
});

describe("componentDetails", () => {
  it("combines versions, health, and installation into one line", () => {
    expect(componentDetails(componentStatus())).toBe("running 1.0.0 · installed 1.0.0 · current · global npm package · /usr/lib/node_modules");
  });

  it("includes the component error when present", () => {
    const details = componentDetails(componentStatus({ available: false, error: "connection refused" }));
    expect(details).toContain("unavailable");
    expect(details).toContain("error: connection refused");
  });
});

describe("diagnosticsSummary", () => {
  it("renders a full status block for bug reports", () => {
    const summary = diagnosticsSummary({ status: statusResponse(), machine: machineFixture(), workspace: workspaceFixture() });

    expect(summary).toBe([
      "PI WEB diagnostics",
      "Package: @jmfederico/pi-web",
      "Web/UI: running 1.0.0 · installed 1.0.1 · restart needed · global npm package · /usr/lib/node_modules",
      "Session daemon: running 1.0.0 · installed 1.0.0 · current · local checkout · /srv/dev/pi-web",
      "Release: Update available: 1.1.0 (checked 2025-01-02T03:04:05Z)",
      "Status generated: 2025-01-02T03:04:06Z",
      "Machine: devbox (local machine)",
      "Workspace: pi-web — /srv/dev/pi-web (branch main, provider: git, main workspace)",
    ].join("\n"));
  });

  it("degrades gracefully when the status and workspace are unavailable", () => {
    const summary = diagnosticsSummary({ status: undefined });

    expect(summary).toBe([
      "PI WEB diagnostics",
      "Status: unavailable",
      "Workspace: none selected",
    ].join("\n"));
  });
});

describe("small formatters", () => {
  it("formats missing versions as unknown", () => {
    expect(formatVersion(undefined)).toBe("unknown");
    expect(formatVersion("")).toBe("unknown");
    expect(formatVersion("1.0.0")).toBe("1.0.0");
  });

  it("labels installations", () => {
    expect(installationLabel(undefined)).toBe("installation unknown");
    expect(installationLabel({ kind: "pi-package", source: "Pi package", scope: "user" })).toBe("Pi package · user");
    expect(installationLabel({ kind: "docker", dockerMode: "dev" })).toBe("Docker development runtime");
    expect(installationLabel({ kind: "docker" })).toBe("Docker runtime");
    expect(installationLabel({ kind: "unknown" })).toBe("installation unknown");
  });

  it("labels machine kinds", () => {
    expect(machineKindLabel("local")).toBe("local machine");
    expect(machineKindLabel("remote")).toBe("remote machine");
  });

  it("describes folder workspaces", () => {
    expect(workspaceFlags({
      id: "ws-1",
      projectId: "proj-1",
      path: "/srv/dev/plain",
      label: "plain",
      isMain: false,
    })).toEqual(["folder workspace"]);
  });
});

function componentStatus(patch: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return {
    component: "web",
    label: "Web/UI",
    runtimeVersion: "1.0.0",
    installedVersion: "1.0.0",
    stale: false,
    available: true,
    installation: { kind: "npm-global", path: "/usr/lib/node_modules" },
    ...patch,
  };
}

function release(patch: Partial<PiWebReleaseStatus> = {}): PiWebReleaseStatus {
  return {
    packageName: "@jmfederico/pi-web",
    updateAvailable: false,
    checkedAt: "2025-01-02T03:04:05Z",
    ...patch,
  };
}

function statusResponse(): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "2025-01-02T03:04:06Z",
    components: {
      web: componentStatus({ installedVersion: "1.0.1", stale: true }),
      sessiond: componentStatus({ component: "sessiond", label: "Session daemon", installation: { kind: "local", path: "/srv/dev/pi-web" } }),
    },
    release: release({ updateAvailable: true, latestVersion: "1.1.0" }),
    commands: {},
    messages: [],
  };
}

function machineFixture(): PluginMachine {
  return { id: "local", name: "devbox", kind: "local" };
}

function workspaceFixture(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    projectId: "proj-1",
    path: "/srv/dev/pi-web",
    label: "pi-web",
    branch: "main",
    isMain: true,
    provider: { pluginId: "git", capabilities: { request: true, remove: true } },
    ...patch,
  };
}
