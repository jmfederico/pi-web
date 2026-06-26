import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { comparePackageVersions, getPiWebStatus, getPiWebVersionStatus, updateCommandFor } from "./piWebStatus.js";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import type { PiWebComponentStatus, PiWebRuntimeComponent } from "../shared/apiTypes.js";

const originalSkipVersionCheck = process.env["PI_WEB_SKIP_VERSION_CHECK"];
const originalHome = process.env["HOME"];

afterEach(() => {
  restoreEnv("PI_WEB_SKIP_VERSION_CHECK", originalSkipVersionCheck);
  restoreEnv("HOME", originalHome);
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

      const status = await getPiWebVersionStatus(daemon, { agentCommand: "omp", agentDir });

      expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: process.cwd(), scope: "user" });
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reports stale session daemon versions as messages", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    const daemon = daemonWithComponent({
      component: "sessiond",
      label: "Session daemon",
      runtimeVersion: "1.202605.7",
      installedVersion: "1.202605.8",
      stale: true,
      available: true,
      installation: { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
    });

    const status = await getPiWebStatus(daemon);

    expect(status.release.skipped).toBe(true);
    expect(status.components.sessiond.stale).toBe(true);
    expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user" });
    expect(status.messages.map((message) => message.id)).toContain("sessiond-stale");
  });

  it("shell-quotes pi-package agent update commands", async () => {
    const updateCommand = await updateCommandFor(
      { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
      "pi-web restart",
      {
        agentCommand: "/tmp/agent's/omp",
        hasCommand: (command) => Promise.resolve(command === "/tmp/agent's/omp"),
      },
    );

    expect(updateCommand).toBe("'/tmp/agent'\\''s/omp' update 'npm:@jmfederico/pi-web' && pi-web restart");
  });

  it("suggests native systemd commands for local development services", async () => {
    if (process.platform !== "linux") return;
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    const home = await tempHome();
    try {
      process.env["HOME"] = home;
      await installSystemdServiceFiles(home, ["pi-web-sessiond.service", "pi-web-ui-dev.service"]);
      const daemon = daemonWithComponent(staleLocalSessiond());

      const status = await getPiWebStatus(daemon);

      expect(status.commands.restart).toBe("systemd-run --user --collect --unit=pi-web-restart -- systemctl --user restart pi-web-ui-dev.service pi-web-sessiond.service");
      expect(status.commands.restartWeb).toBe("systemd-run --user --collect --unit=pi-web-restart-web -- systemctl --user restart pi-web-ui-dev.service");
      expect(status.commands.restartSessiond).toBe("systemd-run --user --collect --unit=pi-web-restart-sessiond -- systemctl --user restart pi-web-sessiond.service");
      expect(status.messages.find((message) => message.id === "sessiond-stale")?.command).toBe("systemd-run --user --collect --unit=pi-web-restart-sessiond -- systemctl --user restart pi-web-sessiond.service");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("omits local restart commands when no native service command is known", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
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


function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}
