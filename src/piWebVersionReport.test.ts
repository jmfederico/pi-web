import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    try {
      await expect(probeRunningComponentReady("web", {
        configEnv: { PI_WEB_CONFIG: configPath },
        fetch: fetchImplementation,
      })).resolves.toBe(true);
      expect(requests).toEqual(["http://127.0.0.1:9123/api/pi-web/health"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("falls back to version reporting only for hosts without the health route", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-web-version-probe-"));
    const configPath = join(directory, "managed.json");
    writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port: 9123 }));
    const requests: string[] = [];
    const fetchImplementation: typeof globalThis.fetch = (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return Promise.resolve(url.endsWith("/health") ? new Response("Not found", { status: 404 }) : new Response(JSON.stringify({
        packageName: "@jmfederico/pi-web", generatedAt: "2026-08-01T00:00:00.000Z",
        components: { web: componentStatus(), sessiond: sessiondStatus({ available: false }) },
      }), { status: 200 }));
    };
    try {
      await expect(probeRunningComponentReady("web", { configEnv: { PI_WEB_CONFIG: configPath }, fetch: fetchImplementation })).resolves.toBe(true);
      expect(requests).toEqual(["http://127.0.0.1:9123/api/pi-web/health", "http://127.0.0.1:9123/api/pi-web/version"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each([new Response("failed", { status: 503 }), new Response('{"ok":false}'), new Response("not json")])("rejects unhealthy responses without falling back", async (response) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-web-version-probe-"));
    const configPath = join(directory, "managed.json");
    writeFileSync(configPath, JSON.stringify({ port: 9123 }));
    let calls = 0;
    try {
      await expect(probeRunningComponentReady("web", {
        configEnv: { PI_WEB_CONFIG: configPath }, fetch: () => { calls++; return Promise.resolve(response); },
      })).resolves.toBe(false);
      expect(calls).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
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

describe("printPiWebVersionReport release checks", () => {
  let directory: string;
  let configEnv: NodeJS.ProcessEnv;
  const npmUrl = "https://registry.npmjs.org/%40jmfederico%2Fpi-web/latest";
  const output = (): string => vi.mocked(console.log).mock.calls.map((args) => args.join(" ")).join("\n");
  const localResponse = (): Response => Response.json({
    packageName: "@jmfederico/pi-web", generatedAt: "2026-08-01T00:00:00.000Z",
    components: { web: componentStatus(), sessiond: sessiondStatus() },
  });
  const reportFetch = (remote: typeof globalThis.fetch) => vi.fn<typeof globalThis.fetch>((input, init) =>
    (typeof input === "string" ? input : input instanceof URL ? input.href : input.url) === npmUrl
      ? remote(input, init) : Promise.resolve(localResponse()));

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-web-release-report-"));
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ port: 9123 }));
    configEnv = { PI_WEB_CONFIG: configPath };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("prints actual per-component engines without confusing package versions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      packageName: "@jmfederico/pi-web", generatedAt: "now",
      components: {
        web: componentStatus({ runtimeVersion: "1.202608.1", runtime: { name: "node", version: "22.9.0" } }),
        sessiond: sessiondStatus({ runtimeVersion: "1.202608.1", runtime: { name: "bun", version: "1.3.0" } }),
      },
    }));
    const result = await printPiWebVersionReport({ configEnv, env: {}, fetch });
    expect(result.web?.runtime).toEqual({ name: "node", version: "22.9.0" });
    expect(result.sessiond?.runtime).toEqual({ name: "bun", version: "1.3.0" });
    expect(output()).toContain("runtime: Node.js 22.9.0");
    expect(output()).toContain("runtime: Bun 1.3.0");
    expect(output()).toContain("running: 1.202608.1");
  });

  it.each([undefined, false])("keeps ordinary reports local (check=%s)", async (check) => {
    const remote = vi.fn<typeof globalThis.fetch>();
    const fetch = reportFetch(remote);
    const result = await printPiWebVersionReport({ configEnv, env: {}, fetch, ...(check === undefined ? {} : { check }) });
    expect(result.release).toBeUndefined();
    expect(remote).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(output()).toContain("Running services:");
    expect(output()).not.toContain("Latest npm release:");
  });

  it("prints and returns the latest npm release only on explicit check", async () => {
    const remote = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ version: "1.202612.4" }));
    const result = await printPiWebVersionReport({ check: true, configEnv, env: {}, fetch: reportFetch(remote) });
    expect(result.release).toEqual({ status: "available", latestVersion: "1.202612.4" });
    expect(result.web?.available).toBe(true);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0]?.[0]).toBe(npmUrl);
    expect(remote.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(output()).toContain("Latest npm release:\n✓ @jmfederico/pi-web: 1.202612.4");
  });

  it.each(["PI_WEB_SKIP_VERSION_CHECK", "PI_WEB_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_OFFLINE"])("respects %s even on explicit checks", async (key) => {
    const remote = vi.fn<typeof globalThis.fetch>();
    // Existing policy treats any nonempty value, including '0', as disabled.
    const result = await printPiWebVersionReport({ check: true, configEnv, env: { [key]: "0" }, fetch: reportFetch(remote) });
    expect(result.release).toEqual({ status: "skipped", reason: `remote version checks disabled by ${key}` });
    expect(remote).not.toHaveBeenCalled();
    expect(output()).toContain(`skipped: remote version checks disabled by ${key}`);
  });

  it("uses the invoking environment rather than the managed service config environment", async () => {
    vi.stubEnv("PI_WEB_OFFLINE", "1");
    const remote = vi.fn<typeof globalThis.fetch>();
    const result = await printPiWebVersionReport({ check: true, configEnv, fetch: reportFetch(remote) });
    expect(result.release?.status).toBe("skipped");
    expect(remote).not.toHaveBeenCalled();
  });

  it("permits empty policy settings", async () => {
    const result = await printPiWebVersionReport({
      check: true, configEnv, env: { PI_WEB_OFFLINE: "", PI_SKIP_VERSION_CHECK: "" },
      fetch: reportFetch(() => Promise.resolve(Response.json({ version: "1.202612.4" }))),
    });
    expect(result.release?.status).toBe("available");
  });

  it.each([
    ["HTTP error", () => Promise.resolve(new Response("unavailable", { status: 503 })), "npm registry returned HTTP 503"],
    ["missing version", () => Promise.resolve(Response.json({})), "npm registry response did not include a version"],
    ["blank version", () => Promise.resolve(Response.json({ version: "  " })), "npm registry response did not include a version"],
    ["network error", () => Promise.reject(new Error("connection refused")), "connection refused"],
  ] satisfies [string, typeof globalThis.fetch, string][])("makes %s observable without losing local reporting", async (_name, remote, error) => {
    const result = await printPiWebVersionReport({ check: true, configEnv, env: {}, fetch: reportFetch(remote) });
    expect(result.release).toEqual({ status: "error", error });
    expect(result.web?.available).toBe(true);
    expect(output()).toContain(`npm release check failed: ${error}`);
  });

  it("reports invalid JSON instead of claiming a successful check", async () => {
    const result = await printPiWebVersionReport({
      check: true, configEnv, env: {}, fetch: reportFetch(() => Promise.resolve(new Response("not json"))),
    });
    expect(result.release?.status).toBe("error");
    if (result.release?.status === "error") expect(result.release.error.length).toBeGreaterThan(0);
    expect(output()).toContain("npm release check failed:");
  });

  it.each(["request", "body"])("bounds a stalled %s to five seconds and aborts transport", async (stage) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const remote: typeof globalThis.fetch = (_input, init) => {
      signal = init?.signal;
      if (stage === "request") return new Promise<Response>(() => undefined);
      const response = Response.json({});
      vi.spyOn(response, "json").mockImplementation(() => new Promise(() => undefined));
      return Promise.resolve(response);
    };
    const pending = printPiWebVersionReport({ check: true, configEnv, env: {}, fetch: reportFetch(remote) });
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).release).toEqual({ status: "error", error: "npm registry check timed out after 5000 ms" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
