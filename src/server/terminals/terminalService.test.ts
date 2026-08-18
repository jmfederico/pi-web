import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RealtimeEvent, TerminalInfo } from "../../shared/apiTypes.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { interactiveShellArgs, TerminalService } from "./terminalService";

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
      const terminal = service.create({ cwd: process.cwd() });

      service.closeForCwd(process.cwd());

      expect(service.get(terminal.id)).toBeUndefined();
      expect(service.list(process.cwd())).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("loads login-profile PATH entries in new interactive terminals", async () => {
    await withBashLoginProfile(async () => {
      const service = new TerminalService();
      try {
        const terminal = service.create({ cwd: process.cwd() });
        const exit = terminalExit(service, terminal.id);

        service.write(terminal.id, `${LOGIN_PROFILE_COMMAND}\nexit\n`);

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

        service.continue(run.terminalId);
        const exit = terminalExit(service, run.terminalId);
        service.write(run.terminalId, `${LOGIN_PROFILE_COMMAND}\nexit\n`);

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

        const continued = service.continue(run.terminalId);

        expect(continued).toMatchObject({ id: run.terminalId, exited: false });
        expect(continued.commandRunId).toBeUndefined();
        expect(service.get(run.terminalId)?.commandRunId).toBeUndefined();

        const frame = "__PI_WEB_CONTINUE_ENV_42D8B1__";
        const exit = terminalExit(service, run.terminalId);
        service.write(run.terminalId, `printf '${frame}%s${frame}\\n' "$PI_WEB_TERMINAL"\nexit\n`);

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
      expect(service.get(run.terminalId)).toMatchObject({ commandRunId: run.id });
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

  it("publishes terminal lifecycle events and workspace activity updates", async () => {
    const events = new RecordingEventHub();
    const workspaceActivity = createWorkspaceActivityRecorder();
    const service = new TerminalService(events, workspaceActivity);
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
      const runningTerminal = requireTerminal(service, run.terminalId);

      expect(workspaceActivity.updated).toEqual([{ id: run.terminalId, cwd, exited: false }]);
      expect(events.events).toEqual([{ type: "terminal.created", terminal: runningTerminal }]);

      await terminalExit(service, run.terminalId);
      const exitedTerminal = requireTerminal(service, run.terminalId);

      expect(workspaceActivity.updated).toEqual([
        { id: run.terminalId, cwd, exited: false },
        { id: run.terminalId, cwd, exited: true },
      ]);
      expect(events.events).toEqual([
        { type: "terminal.created", terminal: runningTerminal },
        { type: "terminal.exited", terminal: exitedTerminal },
      ]);

      service.close(run.terminalId);

      expect(workspaceActivity.removed).toEqual([{ terminalId: run.terminalId, cwd }]);
      expect(events.events).toEqual([
        { type: "terminal.created", terminal: runningTerminal },
        { type: "terminal.exited", terminal: exitedTerminal },
        { type: "terminal.closed", terminalId: run.terminalId, cwd },
      ]);
    } finally {
      service.dispose();
    }
  });
});

class RecordingEventHub extends SessionEventHub {
  readonly events: RealtimeEvent[] = [];

  override publishRealtime(event: RealtimeEvent): void {
    this.events.push(event);
  }
}

interface WorkspaceActivityRecorder extends Pick<WorkspaceActivityService, "updateTerminal" | "removeTerminal"> {
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
  const terminal = service.get(terminalId);
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

function terminalExit(service: TerminalService, terminalId: string): Promise<string> {
  const output: string[] = [];
  return new Promise((resolve, reject) => {
    try {
      service.attach(terminalId, {
        output: (data) => { output.push(data); },
        exit: () => { resolve(output.join("")); },
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
