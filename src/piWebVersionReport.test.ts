import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printPiWebVersionReport, probeRunningComponentReady, runningComponentsReady, type RunningVersionInfo } from "./piWebVersionReport.js";
import type { PiWebComponentStatus } from "./shared/apiTypes.js";

function componentStatus(overrides: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return {
    component: "web",
    label: "Web/UI",
    available: true,
    stale: false,
    ...overrides,
  };
}

function sessiondStatus(overrides: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return componentStatus({ component: "sessiond", label: "Session daemon", ...overrides });
}

describe("probeRunningComponentReady", () => {
  it("resolves the web endpoint from an injected managed config environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-web-version-probe-"));
    const configPath = join(directory, "managed.json");
    writeFileSync(configPath, `${JSON.stringify({ host: "0.0.0.0", port: 9123 })}\n`);
    const requests: string[] = [];
    const fetchImplementation: typeof globalThis.fetch = (input) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response(JSON.stringify({
        packageName: "@jmfederico/pi-web",
        generatedAt: "2026-08-01T00:00:00.000Z",
        components: {
          web: componentStatus(),
          sessiond: sessiondStatus(),
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    };

    try {
      await expect(probeRunningComponentReady("web", {
        configEnv: { PI_WEB_CONFIG: configPath },
        fetch: fetchImplementation,
      })).resolves.toBe(true);
      expect(requests).toEqual(["http://127.0.0.1:9123/api/pi-web/version"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not probe an endpoint when the selected config is malformed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-web-version-probe-"));
    const configPath = join(directory, "managed.json");
    writeFileSync(configPath, "not json\n");
    let requests = 0;
    const fetchImplementation: typeof globalThis.fetch = () => {
      requests += 1;
      return Promise.reject(new Error("unexpected fetch"));
    };

    try {
      await expect(probeRunningComponentReady("web", {
        configEnv: { PI_WEB_CONFIG: configPath },
        fetch: fetchImplementation,
      })).resolves.toBe(false);
      expect(requests).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ACCEPTANCE A6: `pi-web version` shows the runtime each running component reported, per
// component — the CLI's own runtime is not evidence for a long-lived daemon.
describe("printPiWebVersionReport", () => {
  it("prints the runtime of every reported component", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-web-version-report-"));
    const configPath = join(directory, "managed.json");
    writeFileSync(configPath, `${JSON.stringify({ host: "127.0.0.1", port: 9124 })}\n`);
    const fetchImplementation: typeof globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
      packageName: "@jmfederico/pi-web",
      generatedAt: "2026-08-01T00:00:00.000Z",
      components: {
        web: componentStatus({ runtimeVersion: "1.202608.1", runtime: "bun" }),
        sessiond: sessiondStatus({ runtimeVersion: "1.202608.1", runtime: "node" }),
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    try {
      await printPiWebVersionReport({ configEnv: { PI_WEB_CONFIG: configPath }, fetch: fetchImplementation });
    } finally {
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(lines.filter((line) => line === "  runtime: bun")).toHaveLength(1);
    expect(lines.filter((line) => line === "  runtime: node")).toHaveLength(1);
  });
});

describe("runningComponentsReady", () => {
  it("passes when nothing is expected even if components are unavailable", () => {
    const info: RunningVersionInfo = { webError: "connection refused", sessiondError: "socket missing" };

    expect(runningComponentsReady(info, [])).toBe(true);
  });

  it("passes when every expected component is available and current", () => {
    const info: RunningVersionInfo = { web: componentStatus(), sessiond: sessiondStatus() };

    expect(runningComponentsReady(info, ["web", "sessiond"])).toBe(true);
  });

  it("fails when an expected component is unavailable", () => {
    const info: RunningVersionInfo = {
      sessiond: sessiondStatus({ available: false, error: "health probe failed" }),
    };

    expect(runningComponentsReady(info, ["sessiond"])).toBe(false);
  });

  it("fails when an expected component is stale (restart needed)", () => {
    const info: RunningVersionInfo = {
      web: componentStatus({ stale: true, runtimeVersion: "1.202608.0", installedVersion: "1.202608.1" }),
    };

    expect(runningComponentsReady(info, ["web"])).toBe(false);
  });

  it("fails when an expected component is absent from the report (error-only entry)", () => {
    const info: RunningVersionInfo = { sessiondError: "connect ENOENT /run/pi-web/sessiond.sock" };

    expect(runningComponentsReady(info, ["sessiond"])).toBe(false);
  });

  it("ignores components that are not expected regardless of their state", () => {
    const info: RunningVersionInfo = {
      web: componentStatus({ available: false, error: "down" }),
      sessiond: sessiondStatus(),
    };

    expect(runningComponentsReady(info, ["sessiond"])).toBe(true);
  });
});
