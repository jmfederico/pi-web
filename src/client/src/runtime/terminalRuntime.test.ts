import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunTerminalCommandInput, TerminalCommandRun, TerminalCommandRunFilter, Workspace } from "../api";
import { createTerminalCommandRunsRuntime } from "./terminalRuntime";

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  path: "/repo",
  label: "repo",
  isMain: true,
  isGitRepo: true,
  isGitWorktree: true,
};

const runningRun: TerminalCommandRun = {
  id: "run1",
  origin: "plugin",
  projectId: "p1",
  workspaceId: "w1",
  terminalId: "t1",
  title: "Build",
  command: "npm run build",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: {},
};

const succeededRun: TerminalCommandRun = { ...runningRun, status: "succeeded", exitCode: 0, completedAt: "2026-05-25T00:00:01.000Z" };

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal runtime", () => {
  it("starts commands with the assigned origin and opens the returned terminal when requested", async () => {
    const openTerminal = vi.fn();
    const api = {
      runTerminalCommand: vi.fn((origin: string, input: RunTerminalCommandInput) => {
        void origin;
        void input;
        return Promise.resolve(succeededRun);
      }),
      listCommandRuns: vi.fn(),
      getCommandRun: vi.fn(),
    };
    const runtime = createTerminalCommandRunsRuntime("actions", { api, openTerminal });

    const handle = await runtime.runCommand({ workspace, title: "Build", command: "npm run build", open: true });

    expect(api.runTerminalCommand).toHaveBeenCalledWith("actions", { workspace, title: "Build", command: "npm run build", open: true });
    expect(openTerminal).toHaveBeenCalledWith(workspace, { terminalId: "t1" });
    await expect(handle.completed).resolves.toEqual(succeededRun);
  });

  it("passes through command-run lookup helpers and open requests", async () => {
    const filter: TerminalCommandRunFilter = {
      projectId: "p1",
      workspaceId: "w1",
      statuses: ["running"],
      metadata: { "pi.operation": "test" },
    };
    const runs = [runningRun, succeededRun];
    const openTerminal = vi.fn();
    const api = {
      runTerminalCommand: vi.fn(),
      listCommandRuns: vi.fn(() => Promise.resolve(runs)),
      getCommandRun: vi.fn(() => Promise.resolve(succeededRun)),
    };
    const runtime = createTerminalCommandRunsRuntime("core", { api, openTerminal });

    await expect(runtime.listCommandRuns(filter)).resolves.toEqual(runs);
    await expect(runtime.getCommandRun("run1")).resolves.toEqual(succeededRun);
    runtime.open({ terminalId: "t2" });

    expect(api.listCommandRuns).toHaveBeenCalledWith(filter);
    expect(api.getCommandRun).toHaveBeenCalledWith("run1");
    expect(openTerminal).toHaveBeenCalledWith(undefined, { terminalId: "t2" });
    expect(api.runTerminalCommand).not.toHaveBeenCalled();
  });

  it("polls command-run records until completion", async () => {
    vi.useFakeTimers();
    const api = {
      runTerminalCommand: vi.fn(() => Promise.resolve(runningRun)),
      listCommandRuns: vi.fn(),
      getCommandRun: vi.fn(() => Promise.resolve(succeededRun)),
    };
    const runtime = createTerminalCommandRunsRuntime("core", {
      api,
      openTerminal: vi.fn(),
      pollIntervalMs: 25,
      setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
      clearTimeout: (id) => { globalThis.clearTimeout(id); },
    });

    const handle = await runtime.runCommand({ workspace, title: "Build", command: "npm run build" });
    await vi.advanceTimersByTimeAsync(25);

    await expect(handle.completed).resolves.toEqual(succeededRun);
    expect(api.getCommandRun).toHaveBeenCalledWith("run1");
  });

  it("rejects completion polling failures and clears the scheduled timer", async () => {
    const pollError = new Error("poll failed");
    const timerId = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(timerId);
    const scheduledPolls: (() => void)[] = [];
    const clearTimeout = vi.fn();
    const api = {
      runTerminalCommand: vi.fn(() => Promise.resolve(runningRun)),
      listCommandRuns: vi.fn(),
      getCommandRun: vi.fn(() => Promise.reject(pollError)),
    };
    const runtime = createTerminalCommandRunsRuntime("core", {
      api,
      openTerminal: vi.fn(),
      pollIntervalMs: 25,
      setTimeout: (handler) => {
        scheduledPolls.push(handler);
        return timerId;
      },
      clearTimeout,
    });

    const handle = await runtime.runCommand({ workspace, title: "Build", command: "npm run build" });
    const poll = scheduledPolls[0];
    expect(poll).toBeDefined();
    poll?.();

    await expect(handle.completed).rejects.toBe(pollError);
    expect(api.getCommandRun).toHaveBeenCalledWith("run1");
    expect(scheduledPolls).toHaveLength(1);
    expect(clearTimeout).toHaveBeenCalledWith(timerId);
  });
});
