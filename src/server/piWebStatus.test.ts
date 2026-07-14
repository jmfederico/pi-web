import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { comparePackageVersions, getPiWebRuntime, getPiWebStatus, getPiWebVersionStatus, updateCommandFor } from "./piWebStatus.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import type { PiWebComponentStatus, PiWebRuntimeComponent } from "../shared/apiTypes.js";
import { PI_WEB_CAPABILITIES } from "../shared/capabilities.js";

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
    const daemon = daemonWithComponent({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202605.7",
      installedVersion: "1.202605.8",
      stale: true,
      available: true,
    });

    const status = await getPiWebVersionStatus(daemon);

    expect(status.packageName).toBe("@jmfederico/pi-web");
    expect(status.components.web.component).toBe("web");
    expect(status.components.sessiond.runtimeVersion).toBe("1.202605.7");
    expect(status).not.toHaveProperty("release");
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

      const status = await getPiWebVersionStatus(daemon, { activeAgentProfile: activeProfile("a", "alt-agent", agentDir) });

      expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: process.cwd(), scope: "user" });
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

  it("reports web-only capabilities from the web runtime", async () => {
    const daemon = daemonWithComponent({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202605.7",
      installedVersion: "1.202605.8",
      stale: true,
      available: true,
    });

    const runtime = await getPiWebRuntime(daemon);

    expect(runtime.components.web.capabilities).toEqual(expect.arrayContaining([PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, PI_WEB_CAPABILITIES.agentProfileConfig]));
    expect(runtime.components.sessiond.capabilities).not.toContain(PI_WEB_CAPABILITIES.piPackagesManage);
    expect(runtime.components.sessiond.capabilities).not.toContain(PI_WEB_CAPABILITIES.selectedMachineSettings);
    expect(runtime.components.sessiond.capabilities).not.toContain(PI_WEB_CAPABILITIES.agentProfileConfig);
    expect(runtime.capabilities).toEqual(expect.arrayContaining([PI_WEB_CAPABILITIES.piPackagesManage, PI_WEB_CAPABILITIES.selectedMachineSettings, PI_WEB_CAPABILITIES.agentProfileConfig]));
  });

  it("carries the daemon-owned active agent profile through the web runtime response", async () => {
    const activeAgentProfile = {
      schemaVersion: 1 as const,
      revision: `sha256:${"a".repeat(64)}`,
      command: "acme-agent",
      dir: "/opt/acme-agent/state",
      sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
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

  it("bypasses cached npm release data for a forced check", async () => {
    Reflect.deleteProperty(process.env, "PI_WEB_SKIP_VERSION_CHECK");
    process.env["PI_WEB_DOCKER_RUNTIME"] = "1";
    process.env["PI_WEB_DOCKER_MODE"] = "runtime";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(npmVersionResponse("1.202607.1"))
      .mockResolvedValueOnce(npmVersionResponse("1.202607.2"));
    const daemon = daemonWithComponent({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202607.0",
      installedVersion: "1.202607.0",
      stale: false,
      available: true,
      installation: { kind: "docker", dockerMode: "runtime" },
    });

    const first = await getPiWebStatus(daemon, { forceReleaseCheck: true });
    const cached = await getPiWebStatus(daemon);
    const forced = await getPiWebStatus(daemon, { forceReleaseCheck: true });

    expect(first.release.latestVersion).toBe("1.202607.1");
    expect(cached.release.latestVersion).toBe("1.202607.1");
    expect(forced.release.latestVersion).toBe("1.202607.2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports stale session daemon versions as messages", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    disableDockerRuntimeEnv();
    const daemon = daemonWithComponent({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202605.7",
      installedVersion: "1.202605.8",
      stale: true,
      available: true,
      installation: { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
    });

    const status = await getPiWebStatus(daemon, { forceReleaseCheck: true });

    expect(status.release.skipped).toBe(true);
    expect(status.components.sessiond.stale).toBe(true);
    expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user" });
    expect(status.messages.map((message) => message.id)).toContain("sessiond-stale");
  });

  it("suppresses Pi package update planning without an active companion command", async () => {
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
    const command = "/tmp/agent's/pi";
    const dir = "/tmp/profile's/state";
    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      {
        activeAgentProfile: activeProfile("a", command, dir),
        hasCommand: (candidate) => Promise.resolve(candidate === command),
      },
    );

    expect(updateCommand).toBe("PI_CODING_AGENT_DIR='/tmp/profile'\\''s/state' '/tmp/agent'\\''s/pi' update 'npm:@jmfederico/pi-web' && pi-web restart");
  });

  it.each([
    activeProfile("a", "acme-agent", "/opt/acme/state"),
    activeProfile("b", "pi", "relative/state"),
  ])("suppresses Pi-package updates when the active companion profile cannot be represented safely", async (profile) => {
    const hasCommand = vi.fn(() => Promise.resolve(true));

    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      { activeAgentProfile: profile, hasCommand },
    );

    expect(updateCommand).toBeUndefined();
    expect(hasCommand).not.toHaveBeenCalled();
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
      const daemon = daemonWithComponent(staleLocalSessiond());

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
    const daemon = daemonWithComponent({ ...staleLocalSessiond(), installation: { kind: "docker", path: "/srv/pi-web-docker", dockerMode: "runtime" } });

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
    const daemon = daemonWithComponent({ ...staleLocalSessiond(), installation: { kind: "docker", path: "/workspace/pi-web", dockerMode: "dev" } });

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
    const daemon = daemonWithComponent(staleLocalSessiond());

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
      const daemon = daemonWithComponent(staleLocalSessiond());

      const status = await getPiWebStatus(daemon);
      const staleMessage = status.messages.find((message) => message.id === "sessiond-stale");

      expect(status.commands.restart).toBeUndefined();
      expect(staleMessage?.command).toBeUndefined();
      expect(JSON.stringify(status)).not.toContain("pi-web restart");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function activeProfile(revisionCharacter: string, command: string, dir: string) {
  return {
    schemaVersion: 1 as const,
    revision: `sha256:${revisionCharacter.repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
  };
}

function npmVersionResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), { status: 200, headers: { "content-type": "application/json" } });
}

function daemonWithComponent(component: PiWebComponentStatus): SessionDaemonClient {
  const daemon = new SessionDaemonClient();
  vi.spyOn(daemon, "request").mockResolvedValue({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: component }),
  });
  return daemon;
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

function staleLocalSessiond(): PiWebComponentStatus {
  return {
    component: "sessiond",
    label: "Session daemon",
    runtimeVersion: "1.202605.7",
    installedVersion: "1.202605.8",
    stale: true,
    available: true,
    installation: { kind: "local", path: "/srv/dev/pi-web" },
  };
}

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pi-web-status-"));
}

async function installSystemdServiceFiles(home: string, names: string[]): Promise<void> {
  const dir = join(home, ".config", "systemd", "user");
  await mkdir(dir, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(dir, name), "")));
}

async function installConfiguredPiWebPackage(agentDir: string): Promise<void> {
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [process.cwd()] }, null, 2)}\n`, "utf8");
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
