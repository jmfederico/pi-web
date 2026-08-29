import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION as PI_CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";
import { comparePackageVersions, getPiWebRuntime, getPiWebStatus, getPiWebVersionStatus, updateCommandFor } from "./piWebStatus.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import type { PiWebRuntimeComponent } from "../shared/apiTypes.js";

const originalSkipVersionCheck = process.env["PI_WEB_SKIP_VERSION_CHECK"];
const originalHome = process.env["HOME"];
const originalPath = process.env["PATH"];
const originalDockerRuntime = process.env["PI_WEB_DOCKER_RUNTIME"];
const originalDockerMode = process.env["PI_WEB_DOCKER_MODE"];
const originalDockerInstallDir = process.env["PI_WEB_DOCKER_INSTALL_DIR"];
const originalDockerDevRepoRoot = process.env["PI_WEB_DOCKER_DEV_REPO_ROOT"];
const originalAgentDir = process.env["PI_WEB_AGENT_DIR"];

afterEach(() => {
  restoreEnv("PI_WEB_SKIP_VERSION_CHECK", originalSkipVersionCheck);
  restoreEnv("HOME", originalHome);
  restoreEnv("PATH", originalPath);
  restoreEnv("PI_WEB_DOCKER_RUNTIME", originalDockerRuntime);
  restoreEnv("PI_WEB_DOCKER_MODE", originalDockerMode);
  restoreEnv("PI_WEB_DOCKER_INSTALL_DIR", originalDockerInstallDir);
  restoreEnv("PI_WEB_DOCKER_DEV_REPO_ROOT", originalDockerDevRepoRoot);
  restoreEnv("PI_WEB_AGENT_DIR", originalAgentDir);
  vi.restoreAllMocks();
});

describe("PI WEB status", () => {
  it("compares semver-shaped CalVer versions", () => {
    expect(comparePackageVersions("1.202605.9", "1.202605.8")).toBeGreaterThan(0);
    expect(comparePackageVersions("1.202605.8", "1.202605.8")).toBe(0);
    expect(comparePackageVersions("1.202605.7", "1.202605.8")).toBeLessThan(0);
  });

  it("returns installed and running version components without release metadata", async () => {
    const daemon = daemonWithRuntime(runningSessiondRuntime("1.202605.7"));

    const status = await getPiWebVersionStatus(daemon);

    expect(status.packageName).toBe("@jmfederico/pi-web");
    expect(status.components.web.component).toBe("web");
    expect(status.components.sessiond.runtimeVersion).toBe("1.202605.7");
    expect(status).not.toHaveProperty("release");
  });

  it("reports the loaded Pi version for each component, preferring the daemon report", async () => {
    const daemon = daemonWithRuntime({ ...runningSessiondRuntime(), piVersion: "0.83.0" });

    const status = await getPiWebVersionStatus(daemon);
    const runtime = await getPiWebRuntime(daemon);

    expect(status.components.web.piVersion).toBe(PI_CODING_AGENT_VERSION);
    expect(status.components.sessiond.piVersion).toBe("0.83.0");
    expect(runtime.components.web.piVersion).toBe(PI_CODING_AGENT_VERSION);
    expect(runtime.components.sessiond.piVersion).toBe("0.83.0");
  });

  it("falls back to this process's Pi version when the daemon predates Pi version reporting", async () => {
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const status = await getPiWebVersionStatus(daemon);

    expect(status.components.sessiond.piVersion).toBe(PI_CODING_AGENT_VERSION);
  });

  it("detects session daemon package installs from the configured agent dir for runtime responses", async () => {
    disableDockerRuntimeEnv();
    const agentDir = await tempHome();
    try {
      await installConfiguredPiWebPackage(agentDir);
      const daemon = daemonWithRuntime({
        component: "sessiond",
        label: "Session daemon",
        runtimeVersion: "1.202605.7",
        available: true,
        capabilities: [],
      });

      const status = await getPiWebVersionStatus(daemon, { activeAgentProfile: activeProfile(agentDir) });

      expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: process.cwd(), scope: "user" });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a local checkout local when a configured Pi package is vendored inside it", async () => {
    disableDockerRuntimeEnv();
    const agentDir = await tempHome();
    try {
      await installConfiguredPiWebPackage(agentDir, join(process.cwd(), "dist", "pi-packages", "relays"));
      const daemon = daemonWithRuntime({
        component: "sessiond",
        label: "Session daemon",
        runtimeVersion: "1.202605.7",
        available: true,
        capabilities: [],
      });

      const status = await getPiWebVersionStatus(daemon, { activeAgentProfile: activeProfile(agentDir) });

      expect(status.components.web.installation?.kind).not.toBe("pi-package");
      expect(status.components.sessiond.installation?.kind).not.toBe("pi-package");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not fall back to the web process environment when no active profile is available", async () => {
    disableDockerRuntimeEnv();
    const agentDir = await tempHome();
    try {
      await installConfiguredPiWebPackage(agentDir);
      process.env["PI_WEB_AGENT_DIR"] = agentDir;
      const daemon = daemonWithRuntime({
        component: "sessiond",
        label: "Session daemon",
        runtimeVersion: "1.202605.7",
        available: true,
        capabilities: [],
      });

      const status = await getPiWebVersionStatus(daemon);

      expect(status.components.web.installation?.kind).not.toBe("pi-package");
      expect(status.components.sessiond.installation?.kind).not.toBe("pi-package");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("advertises plugin lifecycle as a web-owned effective capability", async () => {
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const runtime = await getPiWebRuntime(daemon);

    expect(runtime.components.web.capabilities).toEqual(["plugins.lifecycle"]);
    expect(runtime.components.sessiond.capabilities).toEqual([]);
    expect(runtime.capabilities).toEqual(["plugins.lifecycle"]);
  });

  it("carries the daemon-owned active agent profile through the web runtime response", async () => {
    const activeAgentProfile = {
      schemaVersion: 2 as const,
      dir: "/opt/pi/state",
    };
    const daemon = daemonWithRuntime({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202605.7",
      available: true,
      capabilities: [],
      activeAgentProfile,
    });

    const runtime = await getPiWebRuntime(daemon);

    expect(runtime.components.sessiond.activeAgentProfile).toEqual(activeAgentProfile);
    expect(runtime.components.web.activeAgentProfile).toBeUndefined();
  });

  it("reports web-process deprecated agent inputs through the runtime response", async () => {
    const deprecatedAgentInputs = [
      { source: "environment" as const, name: "PI_WEB_AGENT_DIR", replacement: "PI_CODING_AGENT_DIR" },
      { source: "config" as const, name: "agent.dir", replacement: "PI_CODING_AGENT_DIR" },
    ];
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const runtime = await getPiWebRuntime(daemon, {
      loadConfig: () => ({ path: "/tmp/config.json", exists: true, config: {}, deprecatedAgentInputs }),
    });

    expect(runtime.components.web.deprecatedAgentInputs).toEqual(deprecatedAgentInputs);
    expect(runtime.components.sessiond.deprecatedAgentInputs).toBeUndefined();
  });

  it("carries daemon-reported deprecated agent inputs through the session daemon component", async () => {
    const deprecatedAgentInputs = [
      { source: "environment" as const, name: "PI_WEB_AGENT_SESSION_DIR", replacement: "PI_CODING_AGENT_SESSION_DIR" },
      { source: "config" as const, name: "agent.command" },
    ];
    const daemon = daemonWithRuntime({ ...runningSessiondRuntime(), deprecatedAgentInputs });

    const runtime = await getPiWebRuntime(daemon, {
      loadConfig: () => ({ path: "/tmp/config.json", exists: false, config: {}, deprecatedAgentInputs: [] }),
    });

    expect(runtime.components.sessiond.deprecatedAgentInputs).toEqual(deprecatedAgentInputs);
  });

  it("omits the deprecated-input report when neither component detects anything", async () => {
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const runtime = await getPiWebRuntime(daemon, {
      loadConfig: () => ({ path: "/tmp/config.json", exists: false, config: {}, deprecatedAgentInputs: [] }),
    });

    expect(runtime.components.web).not.toHaveProperty("deprecatedAgentInputs");
    expect(runtime.components.sessiond).not.toHaveProperty("deprecatedAgentInputs");
  });

  it("keeps the web runtime component well-formed when the config file cannot be loaded", async () => {
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const runtime = await getPiWebRuntime(daemon, {
      loadConfig: () => { throw new Error("PI WEB config agent.dir must be a host-absolute path or start with ~: /tmp/config.json"); },
    });

    expect(runtime.components.web.available).toBe(true);
    expect(runtime.components.web.capabilities).toEqual(["plugins.lifecycle"]);
    expect(runtime.components.web.runtimeVersion).toBeDefined();
    expect(runtime.components.web).not.toHaveProperty("deprecatedAgentInputs");
    expect(runtime.components.web.error).toContain("Could not check for deprecated agent configuration inputs");
    expect(runtime.components.web.error).toContain("agent.dir must be a host-absolute path");
    expect(runtime.components.sessiond.available).toBe(true);
    expect(runtime.capabilities).toEqual(["plugins.lifecycle"]);
  });

  it("bypasses cached npm release data for a forced check", async () => {
    Reflect.deleteProperty(process.env, "PI_WEB_SKIP_VERSION_CHECK");
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEB_DOCKER_MODE"] = "runtime";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(npmVersionResponse("1.202607.1"))
      .mockResolvedValueOnce(npmVersionResponse("1.202607.2"));
    const daemon = daemonWithRuntime(runningSessiondRuntime("1.202607.0"));

    const first = await getPiWebStatus(daemon, { forceReleaseCheck: true });
    const cached = await getPiWebStatus(daemon);
    const forced = await getPiWebStatus(daemon, { forceReleaseCheck: true });

    expect(first.release.latestVersion).toBe("1.202607.1");
    expect(cached.release.latestVersion).toBe("1.202607.1");
    expect(forced.release.latestVersion).toBe("1.202607.2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the session daemon unavailable without falling back to the legacy health payload", async () => {
    const daemon = new SessionDaemonClient();
    const request = vi.spyOn(daemon, "request").mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: {
          component: "sessiond",
          label: "Session daemon",
          runtimeVersion: "1.202605.7",
          stale: false,
          available: true,
        },
      }),
    });

    const status = await getPiWebVersionStatus(daemon);
    const runtime = await getPiWebRuntime(daemon);

    expect(status.components.sessiond.available).toBe(false);
    expect(status.components.sessiond.error).toBe("runtime response did not include valid runtime information");
    expect(runtime.components.sessiond.available).toBe(false);
    expect(runtime.components.sessiond.error).toBe("runtime response did not include valid runtime information");
    expect(request.mock.calls.map(([, path]) => path)).not.toContain("/health");
  });

  it("surfaces the session daemon as unavailable with the upstream error when the runtime check fails", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    disableDockerRuntimeEnv();
    const home = await tempHome();
    try {
      process.env["HOME"] = home;
      const daemon = new SessionDaemonClient();
      vi.spyOn(daemon, "request").mockResolvedValue({
        statusCode: 500,
        headers: { "content-type": "application/json" },
        body: "",
      });

      const status = await getPiWebStatus(daemon);

      expect(status.components.sessiond.available).toBe(false);
      expect(status.components.sessiond.error).toBe("runtime check returned HTTP 500");
      expect(status.messages.map((message) => message.id)).toContain("sessiond-unavailable");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a session daemon running an older version than the installed package as stale", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    disableDockerRuntimeEnv();
    const home = await tempHome();
    try {
      process.env["HOME"] = home;
      const installedVersion = await installedPackageVersion();
      const daemon = daemonWithRuntime(runningSessiondRuntime("1.202605.7"));

      const status = await getPiWebStatus(daemon);

      expect(status.components.sessiond.stale).toBe(true);
      expect(status.components.sessiond.runtimeVersion).toBe("1.202605.7");
      expect(status.components.sessiond.installedVersion).toBe(installedVersion);
      expect(status.messages.find((message) => message.id === "sessiond-stale")).toEqual({
        id: "sessiond-stale",
        severity: "warning",
        title: "Session daemon restart needed",
        body: `The session daemon is running 1.202605.7, but ${installedVersion} is installed. Restart the session daemon service or process to use the installed version.`,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("suppresses Pi package update planning without an active state profile", async () => {
    const hasCommand = vi.fn(() => Promise.resolve(true));

    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      { activeAgentProfile: undefined, hasCommand },
    );

    expect(updateCommand).toBeUndefined();
    expect(hasCommand).not.toHaveBeenCalled();
  });

  it("preserves and shell-quotes the active state profile in Pi-package update commands", async () => {
    const dir = "/tmp/profile's/state";
    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      {
        activeAgentProfile: activeProfile(dir),
        hasCommand: (candidate) => Promise.resolve(candidate === "pi"),
      },
    );

    expect(updateCommand).toBe("PI_CODING_AGENT_DIR='/tmp/profile'\\''s/state' pi update 'npm:@jmfederico/pi-web' && pi-web restart");
  });

  it("scopes node-pty script approval in npm-global update commands", async () => {
    const updateCommand = await updateCommandFor(
      { kind: "npm-global", path: "/opt/npm/@jmfederico/pi-web" },
      "pi-web restart",
      { activeAgentProfile: undefined, hasCommand: () => Promise.resolve(true) },
    );

    expect(updateCommand).toBe("npm install -g @jmfederico/pi-web --allow-scripts=node-pty && pi-web restart");
  });

  it("suppresses npm-global update commands when npm is unavailable", async () => {
    const updateCommand = await updateCommandFor(
      { kind: "npm-global", path: "/opt/npm/@jmfederico/pi-web" },
      "pi-web restart",
      { activeAgentProfile: undefined, hasCommand: () => Promise.resolve(false) },
    );

    expect(updateCommand).toBeUndefined();
  });

  it("suppresses Pi-package updates when the active state profile cannot be represented safely", async () => {
    const hasCommand = vi.fn(() => Promise.resolve(true));

    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      { activeAgentProfile: activeProfile("relative/state"), hasCommand },
    );

    expect(updateCommand).toBeUndefined();
    expect(hasCommand).not.toHaveBeenCalled();
  });

  it("suppresses Pi-package updates when the pi command is not on PATH", async () => {
    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      { activeAgentProfile: activeProfile("/opt/pi/state"), hasCommand: () => Promise.resolve(false) },
    );

    expect(updateCommand).toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")("suggests native systemd commands for local development services", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    disableDockerRuntimeEnv();
    const home = await tempHome();
    const binDir = await tempHome();
    try {
      process.env["HOME"] = home;
      await installExecutable(binDir, "systemctl");
      process.env["PATH"] = `${binDir}:${process.env["PATH"] ?? ""}`;
      await installSystemdServiceFiles(home, ["pi-web-sessiond.service", "pi-web-ui-dev.service"]);
      const daemon = daemonWithRuntime(runningSessiondRuntime());

      const status = await getPiWebStatus(daemon);

      expect(status.commands.restart).toBe("systemd-run --user --collect --unit=pi-web-restart -- systemctl --user restart pi-web-ui-dev.service pi-web-sessiond.service");
      expect(status.commands.restartWeb).toBe("systemd-run --user --collect --unit=pi-web-restart-web -- systemctl --user restart pi-web-ui-dev.service");
      expect(status.commands.restartSessiond).toBe("systemd-run --user --collect --unit=pi-web-restart-sessiond -- systemctl --user restart pi-web-sessiond.service");
      expect(status.messages.find((message) => message.id === "sessiond-stale")?.command).toBe("systemd-run --user --collect --unit=pi-web-restart-sessiond -- systemctl --user restart pi-web-sessiond.service");
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(binDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("suggests Docker commands when running inside the Docker runtime", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEB_DOCKER_MODE"] = "runtime";
    process.env["PI_WEB_DOCKER_INSTALL_DIR"] = "/srv/pi-web-docker";
    process.env["PATH"] = "";
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const status = await getPiWebStatus(daemon);

    expect(status.components.web.installation).toEqual({ kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" });
    expect(status.commands).toEqual({
      update: "pi-web-docker update",
      restart: "pi-web-docker restart",
      restartWeb: "pi-web-docker restart-web",
      restartSessiond: "pi-web-docker restart-sessiond",
      status: "pi-web-docker status",
    });
    expect(JSON.stringify(status)).not.toContain("npm install -g");
    expect(JSON.stringify(status)).not.toContain("pi-web restart");
  });

  it("suggests explicit Docker development commands when running inside the Docker dev runtime", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEB_DOCKER_MODE"] = "dev";
    process.env["PI_WEB_DOCKER_DEV_REPO_ROOT"] = "/workspace/pi-web";
    process.env["PATH"] = "";
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const status = await getPiWebStatus(daemon);

    expect(status.commands).toEqual({
      update: "pi-web-docker --dev update",
      restart: "pi-web-docker --dev restart",
      restartWeb: "pi-web-docker --dev restart-web",
      restartSessiond: "pi-web-docker --dev restart-sessiond",
      status: "pi-web-docker --dev status",
    });
  });

  it("infers explicit Docker development commands from the generated dev root when mode is omitted", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    Reflect.deleteProperty(process.env, "PI_WEB_DOCKER_MODE");
    process.env["PI_WEB_DOCKER_DEV_REPO_ROOT"] = "/workspace/pi-web";
    process.env["PATH"] = "";
    const daemon = daemonWithRuntime(runningSessiondRuntime());

    const status = await getPiWebStatus(daemon);

    expect(status.components.web.installation).toEqual({ kind: "docker", path: "/workspace/pi-web", dockerMode: "dev" });
    expect(status.commands.update).toBe("pi-web-docker --dev update");
    expect(status.commands.status).toBe("pi-web-docker --dev status");
  });

  it("omits local restart commands when no native service command is known", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    disableDockerRuntimeEnv();
    const home = await tempHome();
    try {
      process.env["HOME"] = home;
      const daemon = daemonWithRuntime(runningSessiondRuntime(await installedPackageVersion()));

      const status = await getPiWebStatus(daemon);

      expect(status.commands.restart).toBeUndefined();
      expect(status.messages.some((message) => message.id === "sessiond-stale")).toBe(false);
      expect(JSON.stringify(status)).not.toContain("pi-web restart");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function activeProfile(dir: string) {
  return {
    schemaVersion: 2 as const,
    dir,
  };
}

function npmVersionResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), { status: 200, headers: { "content-type": "application/json" } });
}

function runningSessiondRuntime(runtimeVersion = "1.202605.7"): PiWebRuntimeComponent {
  return {
    component: "sessiond",
    label: "Session daemon",
    runtimeVersion,
    available: true,
    capabilities: [],
  };
}

function daemonWithRuntime(component: PiWebRuntimeComponent): SessionDaemonClient {
  const daemon = new SessionDaemonClient();
  vi.spyOn(daemon, "request").mockResolvedValue({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(component),
  });
  return daemon;
}

async function installedPackageVersion(): Promise<string> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const info: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(info) || typeof info["version"] !== "string" || info["version"] === "") {
    throw new Error("package.json did not include a usable version");
  }
  return info["version"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pi-web-status-"));
}

async function installSystemdServiceFiles(home: string, names: string[]): Promise<void> {
  const dir = join(home, ".config", "systemd", "user");
  await mkdir(dir, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(dir, name), "")));
}

async function installConfiguredPiWebPackage(agentDir: string, packagePath: string = process.cwd()): Promise<void> {
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [packagePath] }, null, 2)}\n`, "utf8");
}

async function installExecutable(dir: string, name: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
}

function disableDockerRuntimeEnv(): void {
  process.env["PI_WEB_DOCKER_RUNTIME"] = "0";
  Reflect.deleteProperty(process.env, "PI_WEB_DOCKER_MODE");
  Reflect.deleteProperty(process.env, "PI_WEB_DOCKER_INSTALL_DIR");
  Reflect.deleteProperty(process.env, "PI_WEB_DOCKER_DEV_REPO_ROOT");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
