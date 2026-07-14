import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentCommandForChecks,
  commandWithVersionCheck,
  doctorExitCode,
  isCliEntrypoint,
  launchdRuntimeDetails,
  regularFileExists,
  serviceBackendForPlatform,
} from "./cli.js";

const originalShell = process.env["SHELL"];
const originalPiWebConfig = process.env["PI_WEB_CONFIG"];
const originalPiWebAgentCommand = process.env["PI_WEB_AGENT_COMMAND"];

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
  if (originalPiWebAgentCommand === undefined) {
    delete process.env["PI_WEB_AGENT_COMMAND"];
  } else {
    process.env["PI_WEB_AGENT_COMMAND"] = originalPiWebAgentCommand;
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

describe("agentCommandForChecks", () => {
  it("reads the configured agent command for doctor checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-cli-test-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, `${JSON.stringify({ agent: { command: "acme-agent", dir: "/opt/acme-agent/state" } })}\n`);
      process.env["PI_WEB_CONFIG"] = configPath;
      delete process.env["PI_WEB_AGENT_COMMAND"];

      expect(agentCommandForChecks()).toBe("acme-agent");
      expect(agentCommandForChecks({
        PI_WEB_CONFIG: configPath,
        PI_WEB_AGENT_COMMAND: "environment-agent",
        PI_WEB_AGENT_DIR: join(dir, "environment-agent-state"),
      })).toBe("environment-agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("native-service doctor CLI contracts", () => {
  it("uses native services only on supported platforms", () => {
    expect(serviceBackendForPlatform("linux")).toEqual({ kind: "systemd", label: "systemd user services" });
    expect(serviceBackendForPlatform("darwin")).toEqual({ kind: "launchd", label: "LaunchAgents" });
    expect(serviceBackendForPlatform("win32")).toBeUndefined();
  });

  it("fails doctor for general, native-plan, or node-pty failures", () => {
    expect(doctorExitCode(true, true, true)).toBe(0);
    expect(doctorExitCode(false, true, true)).toBe(1);
    expect(doctorExitCode(true, false, true)).toBe(1);
    expect(doctorExitCode(true, true, false)).toBe(1);
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
