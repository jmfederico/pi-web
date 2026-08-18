import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandWithVersionCheck,
  doctorExitCode,
  expectedRunningComponents,
  generalDoctorChecks,
  isCliEntrypoint,
  launchdRuntimeDetails,
  managedServiceProbeEnvironment,
  nodeVersionCheck,
  regularFileExists,
  runReadinessCliCommand,
  serviceBackendForPlatform,
  sessionDaemonRestartPlan,
  type ReadinessCliCommandDependencies,
} from "./cli.js";
import { piWebConfigPath } from "./config.js";
import type { InstalledNativeServiceDefinition } from "./nativeServices/serviceDoctor.js";
import type { NativeServiceId } from "./nativeServices/servicePlan.js";

const originalShell = process.env["SHELL"];
const originalPiWebConfig = process.env["PI_WEB_CONFIG"];

afterEach(() => {
  if (originalShell === undefined) {
    delete process.env["SHELL"];
  } else {
    process.env["SHELL"] = originalShell;
  }
  if (originalPiWebConfig === undefined) {
    delete process.env["PI_WEB_CONFIG"];
  } else {
    process.env["PI_WEB_CONFIG"] = originalPiWebConfig;
  }
});

describe("commandWithVersionCheck", () => {
  it("emits a POSIX subshell group for bash", () => {
    process.env["SHELL"] = "/bin/bash";
    expect(commandWithVersionCheck("npm")).toBe("command -v 'npm' && ('npm' --version 2>&1 || true)");
  });

  it("emits a POSIX subshell group for zsh", () => {
    process.env["SHELL"] = "/bin/zsh";
    expect(commandWithVersionCheck("pi")).toBe("command -v 'pi' && ('pi' --version 2>&1 || true)");
  });

  it("uses fish begin/end grouping instead of a POSIX subshell", () => {
    process.env["SHELL"] = "/usr/local/bin/fish";
    const command = commandWithVersionCheck("npm");
    expect(command).toBe("command -v 'npm' && begin; 'npm' --version 2>&1 || true; end");
    expect(command).not.toContain("(");
  });

  it("shell-quotes command words", () => {
    process.env["SHELL"] = "/bin/bash";
    expect(commandWithVersionCheck("/tmp/agent's/acme-agent")).toBe("command -v '/tmp/agent'\\''s/acme-agent' && ('/tmp/agent'\\''s/acme-agent' --version 2>&1 || true)");
  });
});

describe("nodeVersionCheck", () => {
  it("checks the complete supported Node version with the resolved executable", () => {
    process.env["SHELL"] = "/bin/bash";

    const command = nodeVersionCheck();

    expect(command).toContain("22.19.0");
    expect(command).toContain("process.versions.node");
    expect(command).toContain("\"$pi_web_probe_executable\"");
  });
});

describe("generalDoctorChecks", () => {
  it("probes node and npm, then a hardcoded pi on PATH", () => {
    process.env["SHELL"] = "/bin/bash";

    const checks = generalDoctorChecks();
    const piCheck = checks.find(([label]) => label.endsWith("can find pi"));

    expect(checks.map(([label]) => label)).toHaveLength(3);
    expect(piCheck?.[1].at(-1)).toBe(commandWithVersionCheck("pi"));
  });
});

describe("native-service doctor CLI contracts", () => {
  it("uses native services only on supported platforms", () => {
    expect(serviceBackendForPlatform("linux")).toEqual({ kind: "systemd", label: "systemd user services" });
    expect(serviceBackendForPlatform("darwin")).toEqual({ kind: "launchd", label: "LaunchAgents" });
    expect(serviceBackendForPlatform("win32")).toBeUndefined();
  });

  it("fails doctor for general, native-plan, node-pty, or running-component failures", () => {
    expect(doctorExitCode(true, true, true, true)).toBe(0);
    expect(doctorExitCode(false, true, true, true)).toBe(1);
    expect(doctorExitCode(true, false, true, true)).toBe(1);
    expect(doctorExitCode(true, true, false, true)).toBe(1);
    expect(doctorExitCode(true, true, true, false)).toBe(1);
  });

  it("accepts only regular files as bundled entrypoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-entrypoint-test-"));
    try {
      const file = join(dir, "entrypoint.js");
      writeFileSync(file, "export {};\n");
      expect(regularFileExists(file)).toBe(true);
      expect(regularFileExists(dir)).toBe(false);
      expect(regularFileExists(join(dir, "missing.js"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces launchd last exit code 127 in service status", () => {
    expect(launchdRuntimeDetails("state = exited\nlast exit code = 127\n")).toEqual({
      state: "exited",
      detail: "exited (last exit code 127)",
      pid: undefined,
    });
  });
});

describe("managedServiceProbeEnvironment", () => {
  const backend = { kind: "systemd", label: "systemd user services" } as const;
  const installedDefinitions: InstalledNativeServiceDefinition[] = [{
    id: "web",
    contents: [
      "[Service]",
      'Environment="PI_WEB_CONFIG=/managed/config.json"',
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n"),
  }];

  it("copies a persisted config into the probe environment without mutating caller state", () => {
    const callerEnvironment: NodeJS.ProcessEnv = { PI_WEB_CONFIG: "", PI_WEB_PORT: "9000" };

    const result = managedServiceProbeEnvironment(backend, installedDefinitions, callerEnvironment);

    expect(result).toEqual({
      ok: true,
      value: { PI_WEB_CONFIG: "/managed/config.json", PI_WEB_PORT: "9000" },
    });
    expect(callerEnvironment).toEqual({ PI_WEB_CONFIG: "", PI_WEB_PORT: "9000" });
  });

  it("keeps an explicit caller environment without parsing installed definitions", () => {
    const callerEnvironment: NodeJS.ProcessEnv = { PI_WEB_CONFIG: "/caller/config.json" };

    const result = managedServiceProbeEnvironment(
      backend,
      [{ id: "web", contents: "malformed" }],
      callerEnvironment,
    );

    expect(result).toEqual({ ok: true, value: callerEnvironment });
  });

  it("ignores an inherited caller config while selecting the installed config", () => {
    const callerEnvironment: NodeJS.ProcessEnv = { PI_WEB_PORT: "9000" };
    Object.setPrototypeOf(callerEnvironment, { PI_WEB_CONFIG: "/inherited/config.json" });

    const result = managedServiceProbeEnvironment(backend, installedDefinitions, callerEnvironment);

    expect(result).toEqual({
      ok: true,
      value: { PI_WEB_CONFIG: "/managed/config.json", PI_WEB_PORT: "9000" },
    });
    expect(Object.hasOwn(callerEnvironment, "PI_WEB_CONFIG")).toBe(false);
  });

  it("shadows an inherited caller config when installed definitions select the default", () => {
    const callerEnvironment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/managed-default" };
    Object.setPrototypeOf(callerEnvironment, { PI_WEB_CONFIG: "/inherited/config.json" });

    const result = managedServiceProbeEnvironment(backend, [{
      id: "web",
      contents: [
        "[Service]",
        'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
      ].join("\n"),
    }], callerEnvironment);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).not.toBe(callerEnvironment);
    expect(Object.hasOwn(result.value, "PI_WEB_CONFIG")).toBe(true);
    expect(result.value["PI_WEB_CONFIG"]).toBe("");
    expect(piWebConfigPath(result.value)).toBe(join("/managed-default", "pi-web", "config.json"));
    expect(piWebConfigPath(callerEnvironment)).toBe(resolve("/inherited/config.json"));
    expect(Object.hasOwn(callerEnvironment, "PI_WEB_CONFIG")).toBe(false);
  });

  it("retains ambient/default semantics when there are no installed definitions", () => {
    const callerEnvironment: NodeJS.ProcessEnv = { PI_WEB_HOST: "127.0.0.1" };
    Object.setPrototypeOf(callerEnvironment, { PI_WEB_CONFIG: "/ambient/config.json" });

    expect(managedServiceProbeEnvironment(backend, [], callerEnvironment)).toEqual({
      ok: true,
      value: callerEnvironment,
    });
    expect(piWebConfigPath(callerEnvironment)).toBe(resolve("/ambient/config.json"));
  });
});

describe("readiness CLI command orchestration", () => {
  const backend = { kind: "systemd", label: "systemd user services" } as const;
  const definitions: InstalledNativeServiceDefinition[] = [{
    id: "web",
    contents: [
      "[Service]",
      'Environment="PI_WEB_CONFIG=/managed/config.json"',
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n"),
  }];
  const defaultConfigDefinitions: InstalledNativeServiceDefinition[] = [{
    id: "web",
    contents: [
      "[Service]",
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n"),
  }];

  function dependencies(environment: NodeJS.ProcessEnv = {}): ReadinessCliCommandDependencies {
    return {
      environment,
      currentBackend: vi.fn(() => backend),
      requireBackend: vi.fn(() => backend),
      installedServiceIds: vi.fn(() => new Set<NativeServiceId>(["web"])),
      inspectDefinitions: vi.fn(() => ({ ok: true, value: definitions } as const)),
      runLifecycle: vi.fn(() => Promise.resolve()),
      runDoctor: vi.fn(() => Promise.resolve()),
      printVersion: vi.fn(() => Promise.resolve()),
    };
  }

  it.each(["start", "restart"] as const)("passes installed config through actual %s readiness wiring", async (command) => {
    const environment: NodeJS.ProcessEnv = { PI_WEB_CONFIG: "", PI_WEB_PORT: "9000" };
    const deps = dependencies(environment);

    await runReadinessCliCommand(command, deps);

    expect(deps.inspectDefinitions).toHaveBeenCalledWith(backend, ["web"], command);
    expect(deps.runLifecycle).toHaveBeenCalledWith(backend, command, {
      PI_WEB_CONFIG: "/managed/config.json",
      PI_WEB_PORT: "9000",
    });
    expect(environment).toEqual({ PI_WEB_CONFIG: "", PI_WEB_PORT: "9000" });
  });

  it("short-circuits installed inspection for an explicit lifecycle override", async () => {
    const environment: NodeJS.ProcessEnv = { PI_WEB_CONFIG: "/caller/config.json" };
    const deps = dependencies(environment);

    await runReadinessCliCommand("restart", deps);

    expect(deps.inspectDefinitions).not.toHaveBeenCalled();
    expect(deps.runLifecycle).toHaveBeenCalledWith(backend, "restart", environment);
  });

  it("does not treat an inherited lifecycle config as an explicit override", async () => {
    const environment: NodeJS.ProcessEnv = { PI_WEB_PORT: "9000" };
    Object.setPrototypeOf(environment, { PI_WEB_CONFIG: "/inherited/config.json" });
    const deps = dependencies(environment);

    await runReadinessCliCommand("restart", deps);

    expect(deps.inspectDefinitions).toHaveBeenCalledWith(backend, ["web"], "restart");
    expect(deps.runLifecycle).toHaveBeenCalledWith(backend, "restart", {
      PI_WEB_CONFIG: "/managed/config.json",
      PI_WEB_PORT: "9000",
    });
  });

  it.each(["start", "restart"] as const)(
    "resolves the managed default instead of an inherited config through %s readiness wiring",
    async (command) => {
      const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/managed-default" };
      Object.setPrototypeOf(environment, { PI_WEB_CONFIG: "/inherited/config.json" });
      const deps = dependencies(environment);
      vi.mocked(deps.inspectDefinitions).mockReturnValue({ ok: true, value: defaultConfigDefinitions });

      await runReadinessCliCommand(command, deps);

      const probeEnvironment = vi.mocked(deps.runLifecycle).mock.calls[0]?.[2];
      if (probeEnvironment === undefined) throw new Error("lifecycle probe environment was not provided");
      expect(piWebConfigPath(probeEnvironment)).toBe(join("/managed-default", "pi-web", "config.json"));
      expect(piWebConfigPath(environment)).toBe(resolve("/inherited/config.json"));
      expect(Object.hasOwn(environment, "PI_WEB_CONFIG")).toBe(false);
    },
  );

  it("makes launchd inspection action-aware so restart can repair stale loaded state", async () => {
    const launchdBackend = { kind: "launchd", label: "LaunchAgents" } as const;
    const launchdDefinitions: InstalledNativeServiceDefinition[] = [{
      id: "web",
      contents: `<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pi-web.web</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/env</string>\n    <string>/bin/zsh</string>\n    <string>-lc</string>\n    <string>exec true</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PI_WEB_CONFIG</key>\n    <string>/managed/config.json</string>\n  </dict>\n</dict>\n</plist>\n`,
    }];
    const inspect = vi.fn<ReadinessCliCommandDependencies["inspectDefinitions"]>(
      (_backend, _ids, purpose) => purpose === "restart"
        ? { ok: true as const, value: launchdDefinitions }
        : { ok: false as const, message: "loaded LaunchAgent config is stale" },
    );

    const start = dependencies({});
    vi.mocked(start.requireBackend).mockReturnValue(launchdBackend);
    start.inspectDefinitions = inspect;
    await expect(runReadinessCliCommand("start", start)).rejects.toThrow("loaded LaunchAgent config is stale");
    expect(inspect).toHaveBeenLastCalledWith(launchdBackend, ["web"], "start");
    expect(start.runLifecycle).not.toHaveBeenCalled();

    const restart = dependencies({});
    vi.mocked(restart.requireBackend).mockReturnValue(launchdBackend);
    restart.inspectDefinitions = inspect;
    await runReadinessCliCommand("restart", restart);
    expect(inspect).toHaveBeenLastCalledWith(launchdBackend, ["web"], "restart");
    expect(restart.runLifecycle).toHaveBeenCalledWith(launchdBackend, "restart", {
      PI_WEB_CONFIG: "/managed/config.json",
    });
  });

  it("stops lifecycle mutation when managed definition inspection fails", async () => {
    const deps = dependencies({});
    vi.mocked(deps.inspectDefinitions).mockReturnValue({ ok: false, message: "effective drop-ins are active" });

    await expect(runReadinessCliCommand("start", deps)).rejects.toThrow("effective drop-ins are active");

    expect(deps.runLifecycle).not.toHaveBeenCalled();
  });

  it("retains ambient lifecycle behavior when no native service is installed", async () => {
    const environment: NodeJS.ProcessEnv = { PI_WEB_PORT: "9000" };
    const deps = dependencies(environment);
    vi.mocked(deps.installedServiceIds).mockReturnValue(new Set());

    await runReadinessCliCommand("start", deps);

    expect(deps.inspectDefinitions).not.toHaveBeenCalled();
    expect(deps.runLifecycle).toHaveBeenCalledWith(backend, "start", environment);
  });

  it("passes managed config into doctor's running-version probe", async () => {
    const deps = dependencies({});

    await runReadinessCliCommand("doctor", deps);

    expect(deps.inspectDefinitions).toHaveBeenCalledWith(backend, ["web"], "doctor");
    expect(deps.runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      backend,
      versionReportOptions: { configEnv: { PI_WEB_CONFIG: "/managed/config.json" } },
    }));
  });

  it("resolves the managed default instead of an inherited config through doctor wiring", async () => {
    const environment: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: "/managed-default" };
    Object.setPrototypeOf(environment, { PI_WEB_CONFIG: "/inherited/config.json" });
    const deps = dependencies(environment);
    vi.mocked(deps.inspectDefinitions).mockReturnValue({ ok: true, value: defaultConfigDefinitions });

    await runReadinessCliCommand("doctor", deps);

    const context = vi.mocked(deps.runDoctor).mock.calls[0]?.[0];
    const probeEnvironment = context?.versionReportOptions.configEnv;
    if (probeEnvironment === undefined) throw new Error("doctor probe environment was not provided");
    expect(piWebConfigPath(probeEnvironment)).toBe(join("/managed-default", "pi-web", "config.json"));
    expect(piWebConfigPath(environment)).toBe(resolve("/inherited/config.json"));
    expect(Object.hasOwn(environment, "PI_WEB_CONFIG")).toBe(false);
  });

  it("propagates managed inspection failures into doctor's web probe", async () => {
    const deps = dependencies({});
    vi.mocked(deps.inspectDefinitions).mockReturnValue({ ok: false, message: "effective drop-ins are active" });

    await runReadinessCliCommand("doctor", deps);

    expect(deps.runDoctor).toHaveBeenCalledOnce();
    const context = vi.mocked(deps.runDoctor).mock.calls[0]?.[0];
    expect(context?.versionReportOptions.webEndpointError).toContain("effective drop-ins are active");
    expect(context?.managedInspectionFailed).toBe(true);
  });

  it("keeps manual and Docker doctor probes on ambient config semantics", async () => {
    const manualEnvironment: NodeJS.ProcessEnv = { PI_WEB_CONFIG: "/manual/config.json" };
    const manual = dependencies(manualEnvironment);
    vi.mocked(manual.currentBackend).mockReturnValue(undefined);

    await runReadinessCliCommand("doctor", manual);

    expect(manual.installedServiceIds).not.toHaveBeenCalled();
    expect(manual.inspectDefinitions).not.toHaveBeenCalled();
    expect(manual.runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      backend: undefined,
      versionReportOptions: { configEnv: manualEnvironment },
    }));

    const dockerEnvironment: NodeJS.ProcessEnv = { PI_WEB_DOCKER_RUNTIME: "1", PI_WEB_CONFIG: "/docker/config.json" };
    const docker = dependencies(dockerEnvironment);

    await runReadinessCliCommand("doctor", docker);

    expect(docker.inspectDefinitions).not.toHaveBeenCalled();
    expect(docker.runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      backend,
      versionReportOptions: { configEnv: dockerEnvironment },
    }));
  });

  it("does not let an inherited Docker marker bypass managed doctor inspection", async () => {
    const environment: NodeJS.ProcessEnv = {};
    Object.setPrototypeOf(environment, { PI_WEB_DOCKER_RUNTIME: "1" });
    const deps = dependencies(environment);

    await runReadinessCliCommand("doctor", deps);

    expect(deps.inspectDefinitions).toHaveBeenCalledWith(backend, ["web"], "doctor");
    expect(deps.runDoctor).toHaveBeenCalledWith(expect.objectContaining({
      backend,
      versionReportOptions: { configEnv: { PI_WEB_CONFIG: "/managed/config.json" } },
    }));
  });

  it("dispatches standalone version with no managed selection or config options", async () => {
    const deps = dependencies({ PI_WEB_CONFIG: "/ambient/config.json" });

    await runReadinessCliCommand("version", deps);

    expect(deps.printVersion).toHaveBeenCalledWith();
    expect(deps.currentBackend).not.toHaveBeenCalled();
    expect(deps.requireBackend).not.toHaveBeenCalled();
    expect(deps.installedServiceIds).not.toHaveBeenCalled();
    expect(deps.inspectDefinitions).not.toHaveBeenCalled();
    expect(deps.runDoctor).not.toHaveBeenCalled();
    expect(deps.runLifecycle).not.toHaveBeenCalled();
  });
});

describe("expectedRunningComponents", () => {
  it("expects nothing when no services are installed outside Docker", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(), {})).toEqual([]);
  });

  it("expects web and sessiond for a production install", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(["sessiond", "web"]), {})).toEqual(["web", "sessiond"]);
  });

  it("expects web and sessiond for a development install", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(["sessiond", "uiDev"]), {})).toEqual(["web", "sessiond"]);
  });

  it("expects only the components whose services are installed", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(["sessiond"]), {})).toEqual(["sessiond"]);
    expect(expectedRunningComponents(new Set<NativeServiceId>(["web"]), {})).toEqual(["web"]);
    expect(expectedRunningComponents(new Set<NativeServiceId>(["uiDev"]), {})).toEqual(["web"]);
  });

  it("expects both components for a Docker runtime regardless of native service files", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(), { PI_WEB_DOCKER_RUNTIME: "1" })).toEqual(["web", "sessiond"]);
    expect(expectedRunningComponents(new Set<NativeServiceId>(["sessiond"]), { PI_WEB_DOCKER_RUNTIME: "1", PI_WEB_DOCKER_MODE: "dev" })).toEqual(["web", "sessiond"]);
  });

  it("treats a falsy Docker runtime marker as no Docker runtime", () => {
    expect(expectedRunningComponents(new Set<NativeServiceId>(), { PI_WEB_DOCKER_RUNTIME: "0" })).toEqual([]);
  });
});

describe("server plugin recovery restart planning", () => {
  it("uses the Docker control command inside runtime and development containers", () => {
    const runCommand = vi.fn();
    const plan = sessionDaemonRestartPlan({
      env: { PI_WEB_DOCKER_RUNTIME: "1", PI_WEB_DOCKER_MODE: "dev" },
      platform: "linux",
      runCommand,
    });

    expect(plan).toMatchObject({
      kind: "automatic",
      command: "pi-web-docker --dev restart-sessiond",
    });
    plan.perform?.();
    expect(runCommand).toHaveBeenCalledWith("pi-web-docker", ["--dev", "restart-sessiond"]);
  });

  it("uses the installed native sessiond service without contacting it", () => {
    const runCommand = vi.fn();
    const plan = sessionDaemonRestartPlan({
      env: {},
      platform: "linux",
      serviceFileExists: () => true,
      runCommand,
    });

    expect(plan).toMatchObject({
      kind: "automatic",
      command: "systemctl --user restart pi-web-sessiond.service",
    });
    plan.perform?.();
    expect(runCommand).toHaveBeenCalledWith("systemctl", ["--user", "restart", "pi-web-sessiond.service"]);
  });

  it("uses the installed launchd session daemon target", () => {
    const runCommand = vi.fn();
    const plan = sessionDaemonRestartPlan({
      env: {},
      platform: "darwin",
      serviceFileExists: () => true,
      runCommand,
      uid: 501,
    });

    expect(plan).toMatchObject({
      kind: "automatic",
      command: "launchctl kickstart -k gui/501/com.pi-web.sessiond",
    });
    plan.perform?.();
    expect(runCommand).toHaveBeenCalledWith("launchctl", ["kickstart", "-k", "gui/501/com.pi-web.sessiond"]);
  });

  it("does not restart an installed daemon when --config may target another process", () => {
    const plan = sessionDaemonRestartPlan({
      env: {},
      platform: "linux",
      configPath: "/tmp/alternate-pi-web.json",
      explicitConfigPath: true,
      serviceFileExists: () => true,
    });

    expect(plan.kind).toBe("manual");
    expect(plan.guidance).toContain('PI_WEB_CONFIG="/tmp/alternate-pi-web.json"');
    expect(plan.perform).toBeUndefined();
  });

  it("prints manual process guidance when no managed service is installed", () => {
    const plan = sessionDaemonRestartPlan({
      env: {},
      platform: "linux",
      serviceFileExists: () => false,
    });

    expect(plan.kind).toBe("manual");
    expect(plan.guidance).toContain("npm run start:sessiond");
  });
});

describe("isCliEntrypoint", () => {
  it("matches direct execution paths", () => {
    expect(isCliEntrypoint("/tmp/pi-web-cli.js", "/tmp/pi-web-cli.js")).toBe(true);
  });

  it("matches npm-style symlinked bin entrypoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-cli-test-"));
    try {
      const target = join(dir, "dist", "cli.js");
      const symlink = join(dir, "bin", "pi-web");
      mkdirSync(join(dir, "dist"));
      mkdirSync(join(dir, "bin"));
      writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
      symlinkSync(target, symlink);

      expect(isCliEntrypoint(symlink, target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match unrelated paths", () => {
    expect(isCliEntrypoint("/tmp/pi-web", "/tmp/other-pi-web")).toBe(false);
  });
});
