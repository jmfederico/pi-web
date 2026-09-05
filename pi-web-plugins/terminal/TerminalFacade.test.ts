import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, TerminalCommandRun, Workspace, WorkspaceBackend } from "@jmfederico/pi-web/plugin-api";
import { TerminalFacade } from "./TerminalFacade";

const workspace: Workspace = {
  id: "w1",
  projectId: "p1",
  path: "/repo",
  label: "repo",
  isMain: true,
};

const runningRun: TerminalCommandRun = {
  id: "run1",
  origin: "actions",
  projectId: "p1",
  workspaceId: "w1",
  terminalId: "t1",
  title: "Build",
  command: "npm run build",
  status: "running",
  createdAt: "2026-05-25T00:00:00.000Z",
  metadata: {},
};

const succeededRun: TerminalCommandRun = {
  ...runningRun,
  status: "succeeded",
  exitCode: 0,
  completedAt: "2026-05-25T00:00:01.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Terminal facade", () => {
  it("runs a command through the paired backend and opens its terminal when requested", async () => {
    const request = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(succeededRun));
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const navigateWorkspaceContribution = vi.fn();
    const terminal = new TerminalFacade().createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "terminal",
      workspace,
      backend: backend(request),
      host: { navigateWorkspaceContribution },
    });

    const handle = await terminal.runCommand({ title: "Build", command: "npm run build", metadata: { source: "task" }, open: true });

    expect(request).toHaveBeenCalledWith("terminal.run", {
      origin: "actions",
      title: "Build",
      command: "npm run build",
      metadata: { source: "task" },
    }, undefined);
    expect(navigateWorkspaceContribution).toHaveBeenCalledWith(workspace, {
      contributionId: "terminal:workspace.terminal",
      navigationAliases: ["core:workspace.terminal"],
      query: { terminal: "t1", start: undefined },
    });
    await expect(handle.completed).resolves.toEqual(succeededRun);
  });

  it("polls scoped command runs through the same backend until completion", async () => {
    vi.useFakeTimers();
    const request = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(runningRun));
      if (operation === "terminal.get-run") return Promise.resolve(runJson(succeededRun));
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const facade = new TerminalFacade({ pollIntervalMs: 25 });
    const terminal = facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "terminal",
      workspace,
      backend: backend(request),
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });
    await vi.advanceTimersByTimeAsync(25);

    await expect(handle.completed).resolves.toEqual(succeededRun);
    expect(request).toHaveBeenCalledWith("terminal.get-run", { runId: "run1" }, undefined);
  });

  it("rejects completion when a known command run disappears instead of polling forever", async () => {
    vi.useFakeTimers();
    const request = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(runningRun));
      if (operation === "terminal.get-run") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const terminal = new TerminalFacade({ pollIntervalMs: 25 }).createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "terminal",
      workspace,
      backend: backend(request),
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });
    const completion = expect(handle.completed).rejects.toThrow("run1 is no longer available");
    await vi.advanceTimersByTimeAsync(25);
    await completion;
    expect(request.mock.calls.filter(([operation]) => operation === "terminal.get-run")).toHaveLength(1);
  });

  it("owns explicit-open start sequencing and Terminal navigation query semantics", () => {
    const navigateWorkspaceContribution = vi.fn();
    const terminal = new TerminalFacade().createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "machine.remote.terminal",
      workspace,
      backend: backend(vi.fn(() => Promise.resolve(null))),
      host: { navigateWorkspaceContribution },
    });

    terminal.open();
    terminal.open();
    terminal.open({ terminalId: "selected" });

    expect(navigateWorkspaceContribution.mock.calls).toEqual([
      [workspace, {
        contributionId: "machine.remote.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { start: "1" },
      }],
      [workspace, {
        contributionId: "machine.remote.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { start: "2" },
      }],
      [workspace, {
        contributionId: "machine.remote.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { terminal: "selected", start: undefined },
      }],
    ]);
  });

  it("lists command runs with only plugin-owned scoped filters", async () => {
    const request = vi.fn((): Promise<JsonValue> => Promise.resolve([runJson(runningRun)]));
    const controller = new AbortController();
    const facade = new TerminalFacade();

    await expect(facade.listCommandRuns({
      backend: backend(request),
      filter: { statuses: ["running"], metadata: { "pi.operation": "workspace.delete" } },
      signal: controller.signal,
    })).resolves.toEqual([runningRun]);

    expect(request).toHaveBeenCalledWith("terminal.list-runs", {
      statuses: ["running"],
      metadata: { "pi.operation": "workspace.delete" },
    }, { signal: controller.signal });
  });

  it("fails closed when the paired request capability is absent", () => {
    const facade = new TerminalFacade();
    expect(() => facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "terminal",
      workspace,
      backend: { request: () => Promise.resolve(null) },
      host: { navigateWorkspaceContribution: vi.fn() },
    })).toThrow("Required Terminal paired backend capability v1 is unavailable");
  });
});

function backend(request: WorkspaceBackend["request"]): WorkspaceBackend {
  return { capabilityVersion: 1, request };
}

function runJson(run: TerminalCommandRun): JsonValue {
  return {
    id: run.id,
    origin: run.origin,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    terminalId: run.terminalId,
    title: run.title,
    command: run.command,
    status: run.status,
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    metadata: { ...run.metadata },
  };
}
