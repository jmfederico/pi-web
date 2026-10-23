import { describe, expect, it, vi } from "vitest";
import type { PtyHandlers, PtyProvider, PtySpawnOptions } from "./ptyProvider.js";
import { TerminalService } from "./terminalService.js";

function fakeProvider() {
  const processes: { options: PtySpawnOptions; handlers: PtyHandlers; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const provider: PtyProvider = {
    kind: "node",
    spawn(options, handlers) {
      const child = { options, handlers, write: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
      processes.push(child);
      return child;
    },
  };
  return { provider, processes };
}
const scope = { projectId: "p", workspaceId: "w", cwd: "/fake/project" };
const command = { ...scope, origin: "test", title: "Command", command: "printf done" };

describe("TerminalService with an injected PTY provider", () => {
  it("replays output before exit, releases natural exits, and ignores stale callbacks after continue", () => {
    const fake = fakeProvider();
    const service = new TerminalService(fake.provider);
    try {
      const run = service.runCommand(command);
      const first = fake.processes[0];
      if (first === undefined) throw new Error("Expected spawned command");
      first.handlers.output("final output");
      first.handlers.exit(0);
      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(service.getCommandRun(run.id)).toMatchObject({ status: "succeeded", exitCode: 0 });
      const events: string[] = [];
      service.attach(scope, run.terminalId, {
        output(data, replay) { events.push(`${replay ? "replay" : "live"}:${data}`); },
        exit(code) { events.push(`exit:${String(code)}`); },
      });
      expect(events).toEqual(["replay:final output", "exit:0"]);
      service.continue(scope, run.terminalId);
      const second = fake.processes[1];
      if (second === undefined) throw new Error("Expected continued shell");
      expect(second.options.env["PI_WEB_TERMINAL"]).toBe("1");
      first.handlers.output("stale");
      first.handlers.exit(9);
      expect(service.get(scope, run.terminalId)).toMatchObject({ exited: false });
      expect(events.join("")).not.toContain("stale");
      second.handlers.output("new output");
      second.handlers.exit(3);
      expect(events.at(-2)).toBe("live:new output");
      expect(events.at(-1)).toBe("exit:3");
      expect(service.getCommandRun(run.id)).toMatchObject({ status: "succeeded", exitCode: 0 });
    } finally { service.dispose(); }
  });

  it.each(["close", "dispose"] as const)("%s finalizes running commands even without a provider exit and suppresses late notices", (action) => {
    const fake = fakeProvider();
    const notice = vi.fn();
    const service = new TerminalService(fake.provider, notice);
    const run = service.runCommand({ ...command, failureNotice: { message: "Failed", context: {} } });
    const first = fake.processes[0];
    if (first === undefined) throw new Error("Expected spawned command");
    const closed = vi.fn();
    const exit = vi.fn();
    service.attach(scope, run.terminalId, { output: vi.fn(), exit, closed });
    if (action === "close") service.close(scope, run.terminalId);
    else service.dispose();
    first.handlers.exit(0);
    first.handlers.output("late");
    service.dispose();
    expect(service.getCommandRun(run.id)?.status).toBe("failed");
    expect(typeof service.getCommandRun(run.id)?.completedAt).toBe("string");
    expect(service.getCommandRun(run.id)?.exitCode).toBeUndefined();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(service.list(scope)).toEqual([]);
    expect(() => service.create(scope)).toThrow("stopped");
  });

  it("preserves the exited record and command association when continue cannot spawn", () => {
    const fake = fakeProvider();
    const service = new TerminalService(fake.provider);
    try {
      const run = service.runCommand(command);
      fake.processes[0]?.handlers.exit(7);
      fake.provider.spawn = () => { throw new Error("spawn failed"); };
      expect(() => service.continue(scope, run.terminalId)).toThrow("spawn failed");
      expect(service.get(scope, run.terminalId)).toMatchObject({ exited: true, exitCode: 7, commandRunId: run.id });
    } finally { service.dispose(); }
  });

  it("rolls back failed creation and handles synchronous initial output/exit without losing replay", () => {
    const dispose = vi.fn();
    const provider: PtyProvider = {
      kind: "node",
      spawn(_options, handlers) {
        handlers.output("immediate");
        handlers.exit(0);
        return { write: vi.fn(), resize: vi.fn(), dispose };
      },
    };
    const service = new TerminalService(provider);
    try {
      const run = service.runCommand(command);
      expect(run.status).toBe("succeeded");
      expect(dispose).toHaveBeenCalledTimes(1);
      const output = vi.fn();
      service.attach(scope, run.terminalId, { output, exit: vi.fn() });
      expect(output).toHaveBeenCalledWith("immediate", true);
      provider.spawn = () => { throw new Error("bad cwd"); };
      expect(() => service.runCommand(command)).toThrow("bad cwd");
      expect(service.list(scope)).toHaveLength(1);
      expect(service.listCommandRuns()).toHaveLength(1);
    } finally { service.dispose(); }
  });

  it("forwards writes, cancellation and floored sizes, and attempts all cleanup even if one handle fails", () => {
    const fake = fakeProvider();
    const service = new TerminalService(fake.provider);
    const run = service.runCommand(command);
    service.create(scope);
    const first = fake.processes[0];
    const second = fake.processes[1];
    if (first === undefined || second === undefined) throw new Error("Expected two PTYs");
    service.write(scope, run.terminalId, "input");
    service.resize(scope, run.terminalId, 90.7, 25.9);
    service.cancelCommandRun(run.id);
    expect(first.write.mock.calls).toEqual([["input"], ["\x03"]]);
    expect(first.resize).toHaveBeenCalledWith(90, 25);
    first.dispose.mockImplementation(() => { throw new Error("close failed"); });
    expect(() => { service.dispose(); }).toThrow(AggregateError);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(service.list(scope)).toEqual([]);
    service.dispose();
  });
});
