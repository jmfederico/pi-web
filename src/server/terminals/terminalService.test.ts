import { describe, expect, it } from "vitest";
import type { RealtimeEvent, TerminalInfo } from "../../shared/apiTypes.js";
import type { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { TerminalService } from "./terminalService";

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

  it("continues an exited command-run terminal as an interactive shell", async () => {
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
      expect(await terminalReplay(service, run.terminalId)).toContain("[continued in interactive shell]");
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

function terminalReplay(service: TerminalService, terminalId: string): Promise<string> {
  let output = "";
  const detach = service.attach(terminalId, {
    output: (data) => { output += data; },
    exit: () => undefined,
  });
  detach();
  return Promise.resolve(output);
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
