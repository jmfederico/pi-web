import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerPluginNoticeInput } from "@jmfederico/pi-web/server-plugin-api";
import { interactiveShellArgs, TerminalService, type TerminalActivitySink, type TerminalInfo, type TerminalWorkspaceScope } from "./terminalService";

describe("interactive shell arguments", () => {
  it.each([
    { shell: "bash", expected: ["-l"] },
    { shell: "/usr/local/bin/zsh", expected: ["-l"] },
    { shell: "/opt/homebrew/bin/fish", expected: ["-l"] },
    { shell: String.raw`C:\Program Files\Git\bin\bash.exe`, expected: ["-l"] },
    { shell: "/bin/dash", expected: [] },
    { shell: "pwsh", expected: [] },
    { shell: "powershell.exe", expected: [] },
    { shell: "cmd.exe", expected: [] },
  ])("uses login mode only for a supported shell: $shell", ({ shell, expected }) => {
    expect(interactiveShellArgs(shell)).toEqual(expected);
  });
});

// TerminalService spawns a POSIX shell (/bin/bash with -lc and commands like
// printf/true/exit). The terminal feature is not supported on native Windows,
// so these tests are skipped there rather than asserting Unix shell behavior.
describe.skipIf(process.platform === "win32")("TerminalService command runs", () => {
  it("closes all terminal records for a cwd", () => {
    const service = new TerminalService();
    try {
      const terminal = service.create(scope());
      let closed = 0;
      service.attach(scope(), terminal.id, {
        output: () => undefined,
        exit: () => undefined,
        closed: () => { closed += 1; },
      });

      service.closeForCwd(process.cwd());

      expect(closed).toBe(1);
      expect(service.get(scope(), terminal.id)).toBeUndefined();
      expect(service.list(scope())).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("closes all terminals only in the requested workspace when cwd values match", () => {
    const service = new TerminalService();
    const firstScope = scope();
    const secondScope = { ...firstScope, projectId: "p2", workspaceId: "w2" };
    try {
      const first = service.create(firstScope);
      const second = service.create(secondScope);
      let firstClosed = 0;
      service.attach(firstScope, first.id, {
        output: () => undefined,
        exit: () => undefined,
        closed: () => { firstClosed += 1; },
      });

      service.closeAll(firstScope);

      expect(firstClosed).toBe(1);
      expect(service.get(firstScope, first.id)).toBeUndefined();
      expect(service.get(secondScope, second.id)).toMatchObject({ id: second.id, cwd: secondScope.cwd });
    } finally {
      service.dispose();
    }
  });

  it("loads login-profile PATH entries in new interactive terminals", async () => {
    await withBashLoginProfile(async () => {
      const service = new TerminalService();
      try {
        const terminal = service.create(scope());
        const exit = terminalExit(service, terminal.id);

        service.write(scope(), terminal.id, `${LOGIN_PROFILE_COMMAND}\nexit\n`);

        expect(await exit).toContain(LOGIN_PROFILE_OUTPUT);
      } finally {
        service.dispose();
      }
    });
  });

  it("loads login-profile PATH entries in continued interactive terminals", async () => {
    await withBashLoginProfile(async () => {
      const service = new TerminalService();
      try {
        const run = service.runCommand({
          origin: "core",
          projectId: "p1",
          workspaceId: "w1",
          cwd: process.cwd(),
          title: "Done command",
          command: "true",
        });
        await terminalExit(service, run.terminalId);

        service.continue(scope(), run.terminalId);
        const shellReady = firstLiveTerminalOutput(service, run.terminalId);
        const exit = terminalExit(service, run.terminalId);
        await shellReady;
        service.write(scope(), run.terminalId, `${LOGIN_PROFILE_COMMAND}\nexit\n`);

        expect(await exit).toContain(LOGIN_PROFILE_OUTPUT);
      } finally {
        service.dispose();
      }
    });
  });

  describe("PI_WEB_TERMINAL propagation", () => {
    let originalPiWebTerminal: string | undefined;

    beforeEach(() => {
      originalPiWebTerminal = process.env["PI_WEB_TERMINAL"];
      process.env["PI_WEB_TERMINAL"] = "conflicting-parent-value";
    });

    afterEach(() => {
      if (originalPiWebTerminal === undefined) {
        delete process.env["PI_WEB_TERMINAL"];
      } else {
        process.env["PI_WEB_TERMINAL"] = originalPiWebTerminal;
      }
    });

    it("sets PI_WEB_TERMINAL for terminal commands", async () => {
      const service = new TerminalService();
      try {
        const frame = "__PI_WEB_RUN_ENV_7F3A9C__";
        const run = service.runCommand({
          origin: "core",
          projectId: "p1",
          workspaceId: "w1",
          cwd: process.cwd(),
          title: "Environment check",
          command: `printf '${frame}%s${frame}\\n' "$PI_WEB_TERMINAL"`,
        });

        expect(await terminalExit(service, run.terminalId)).toContain(`${frame}1${frame}`);
      } finally {
        service.dispose();
      }
    });

    it("sets PI_WEB_TERMINAL in a continued interactive shell", async () => {
      const service = new TerminalService();
      try {
        const run = service.runCommand({
          origin: "core",
          projectId: "p1",
          workspaceId: "w1",
          cwd: process.cwd(),
          title: "Done command",
          command: "true",
        });
        await terminalExit(service, run.terminalId);

        const continued = service.continue(scope(), run.terminalId);

        expect(continued).toMatchObject({ id: run.terminalId, exited: false });
        expect(continued.commandRunId).toBeUndefined();
        expect(service.get(scope(), run.terminalId)?.commandRunId).toBeUndefined();

        const frame = "__PI_WEB_CONTINUE_ENV_42D8B1__";
        const shellReady = firstLiveTerminalOutput(service, run.terminalId);
        const exit = terminalExit(service, run.terminalId);
        await shellReady;
        service.write(scope(), run.terminalId, `printf '${frame}%s${frame}\\n' "$PI_WEB_TERMINAL"\nexit\n`);

        const output = await exit;
        expect(output).toContain("[continued in interactive shell]");
        expect(output).toContain(`${frame}1${frame}`);
      } finally {
        service.dispose();
      }
    });
  });

  it("tracks dedicated terminal command runs through completion", async () => {
    const service = new TerminalService();
    try {
      const run = service.runCommand({
        origin: "core",
        projectId: "p1",
        workspaceId: "w1",
        cwd: process.cwd(),
        title: "Test command",
        command: "printf 'hello'",
        metadata: { "pi.operation": "test" },
      });

      expect(run).toMatchObject({ status: "running", origin: "core", projectId: "p1", workspaceId: "w1", metadata: { "pi.operation": "test" } });
      expect(service.get(scope(), run.terminalId)).toMatchObject({ commandRunId: run.id });
      expect(service.listCommandRuns({ metadata: { "pi.operation": "test" } })).toHaveLength(1);

      const output = await terminalExit(service, run.terminalId);

      expect(output).toContain("$ printf 'hello'");
      expect(output).toContain("hello");
      expect(service.getCommandRun(run.id)).toMatchObject({ status: "succeeded", exitCode: 0, terminalId: run.terminalId });
      expect(service.listCommandRuns({ statuses: ["succeeded"] }).map((candidate) => candidate.id)).toEqual([run.id]);
    } finally {
      service.dispose();
    }
  });

  it("marks failed command runs when the command exits non-zero", async () => {
    const service = new TerminalService();
    try {
      const run = service.runCommand({
        origin: "core",
        projectId: "p1",
        workspaceId: "w1",
        cwd: process.cwd(),
        title: "Failing command",
        command: "exit 7",
      });

      await terminalExit(service, run.terminalId);

      expect(service.getCommandRun(run.id)).toMatchObject({ status: "failed", exitCode: 7 });
    } finally {
      service.dispose();
    }
  });

  it("records one host-attributed intent when a command fails", async () => {
    const records: ServerPluginNoticeInput[] = [];
    const service = new TerminalService((input) => { records.push(input); });
    try {
      const run = service.runCommand({
        origin: "core",
        projectId: "p1",
        workspaceId: "w1",
        cwd: process.cwd(),
        title: "Remove workspace",
        command: "exit 7",
        failureNotice: {
          message: "Workspace removal failed. See terminal output.",
          context: { projectId: "p1", targetWorkspaceId: "target-workspace" },
        },
      });

      await terminalExit(service, run.terminalId);

      expect(run).not.toHaveProperty("failureNotice");
      expect(service.getCommandRun(run.id)).not.toHaveProperty("failureNotice");
      expect(records).toEqual([{
        severity: "error",
        message: "Workspace removal failed. See terminal output.",
        context: {
          commandRunId: run.id,
          projectId: "p1",
          targetWorkspaceId: "target-workspace",
        },
      }]);
    } finally {
      service.dispose();
    }
  });

  it("does not record a failure intent for a successful command", async () => {
    const records: ServerPluginNoticeInput[] = [];
    const service = new TerminalService((input) => { records.push(input); });
    try {
      const run = service.runCommand({
        origin: "core",
        projectId: "p1",
        workspaceId: "w1",
        cwd: process.cwd(),
        title: "Remove workspace",
        command: "true",
        failureNotice: {
          message: "Workspace removal failed. See terminal output.",
          context: { projectId: "p1", targetWorkspaceId: "target-workspace" },
        },
      });

      await terminalExit(service, run.terminalId);

      expect(service.getCommandRun(run.id)).toMatchObject({ status: "succeeded", exitCode: 0 });
      expect(records).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("publishes workspace activity updates across the terminal lifecycle", async () => {
    const workspaceActivity = createWorkspaceActivityRecorder();
    const service = new TerminalService();
    service.bindActivitySink(workspaceActivity);
    const cwd = process.cwd();
    try {
      const run = service.runCommand({
        origin: "core",
        projectId: "p1",
        workspaceId: "w1",
        cwd,
        title: "Lifecycle command",
        command: "true",
      });
      expect(requireTerminal(service, run.terminalId).exited).toBe(false);
      expect(workspaceActivity.updated).toEqual([{ id: run.terminalId, cwd, exited: false }]);

      await terminalExit(service, run.terminalId);
      expect(requireTerminal(service, run.terminalId).exited).toBe(true);

      expect(workspaceActivity.updated).toEqual([
        { id: run.terminalId, cwd, exited: false },
        { id: run.terminalId, cwd, exited: true },
      ]);

      service.close(scope(), run.terminalId);

      expect(workspaceActivity.removed).toEqual([{ terminalId: run.terminalId, cwd }]);
    } finally {
      service.dispose();
    }
  });
});

interface WorkspaceActivityRecorder extends TerminalActivitySink {
  readonly updated: TerminalActivityUpdate[];
  readonly removed: TerminalActivityRemoval[];
}

type TerminalActivityUpdate = Pick<TerminalInfo, "id" | "cwd" | "exited">;

interface TerminalActivityRemoval {
  terminalId: string;
  cwd: string | undefined;
}

function createWorkspaceActivityRecorder(): WorkspaceActivityRecorder {
  const updated: TerminalActivityUpdate[] = [];
  const removed: TerminalActivityRemoval[] = [];
  return {
    updated,
    removed,
    updateTerminal: (terminal) => {
      updated.push({ id: terminal.id, cwd: terminal.cwd, exited: terminal.exited });
    },
    removeTerminal: (terminalId, cwd) => {
      removed.push({ terminalId, cwd });
    },
  };
}

function requireTerminal(service: TerminalService, terminalId: string): TerminalInfo {
  const terminal = service.get(scope(), terminalId);
  if (terminal === undefined) throw new Error(`Expected terminal ${terminalId} to exist`);
  return terminal;
}

const LOGIN_PROFILE_COMMAND = "pi-web-test-login-profile-command";
const LOGIN_PROFILE_OUTPUT = "__PI_WEB_LOGIN_PROFILE_PATH_COMMAND__";

async function withBashLoginProfile(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "pi-web-terminal-home-"));
  const profileBin = join(home, "profile-bin");
  await mkdir(profileBin);
  const commandPath = join(profileBin, LOGIN_PROFILE_COMMAND);
  await writeFile(commandPath, `#!/bin/sh\nprintf '%s\\n' '${LOGIN_PROFILE_OUTPUT}'\n`);
  await chmod(commandPath, 0o755);
  await writeFile(join(home, ".bash_profile"), `export PATH="$HOME/profile-bin:$PATH"\n`);

  const originalHome = process.env["HOME"];
  const originalShell = process.env["SHELL"];
  process.env["HOME"] = home;
  process.env["SHELL"] = "/bin/bash";
  try {
    await run();
  } finally {
    restoreEnv("HOME", originalHome);
    restoreEnv("SHELL", originalShell);
    await rm(home, { recursive: true, force: true });
  }
}

function restoreEnv(key: "HOME" | "SHELL", value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

function firstLiveTerminalOutput(service: TerminalService, terminalId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let detach = (): void => undefined;
    const finish = (callback: () => void): void => {
      detach();
      callback();
    };
    try {
      detach = service.attach(scope(), terminalId, {
        output: (_data, replay) => {
          if (!replay) finish(resolve);
        },
        exit: () => { finish(() => { reject(new Error("Continued terminal exited before its shell became ready")); }); },
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function terminalExit(service: TerminalService, terminalId: string): Promise<string> {
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    try {
      service.attach(scope(), terminalId, {
        output: (data) => { output.push(data); },
        exit: () => { resolve(output.join("")); },
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function scope(cwd = process.cwd()): TerminalWorkspaceScope {
  return { projectId: "p1", workspaceId: "w1", cwd };
}
