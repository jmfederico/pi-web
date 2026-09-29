import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginPeer, TerminalCommandRun, Workspace } from "@jmfederico/pi-web/plugin-api";
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
  it("runs a command through the peer and opens its terminal when requested", async () => {
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(succeededRun));
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const navigateWorkspaceContribution = vi.fn();
    const terminal = new TerminalFacade().createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: peer(request),
      host: { navigateWorkspaceContribution },
    });

    const handle = await terminal.runCommand({ title: "Build", command: "npm run build", metadata: { source: "task" }, open: true });

    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["terminal.run", {
      origin: "actions",
      title: "Build",
      command: "npm run build",
      metadata: { source: "task" },
    }]);
    expect(request.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(navigateWorkspaceContribution).toHaveBeenCalledWith(workspace, {
      contributionId: "pi-web.terminal:workspace.terminal",
      navigationAliases: ["core:workspace.terminal"],
      query: { terminal: "t1", start: undefined },
    });
    await expect(handle.completed).resolves.toEqual(succeededRun);
  });

  it("polls scoped command runs through the same peer until completion", async () => {
    vi.useFakeTimers();
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(runningRun));
      if (operation === "terminal.get-run") return Promise.resolve(runJson(succeededRun));
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const facade = new TerminalFacade({ pollIntervalMs: 25 });
    const terminal = facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: peer(request),
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });
    await vi.advanceTimersByTimeAsync(25);

    await expect(handle.completed).resolves.toEqual(succeededRun);
    const getRunCall = request.mock.calls.find(([operation]) => operation === "terminal.get-run");
    expect(getRunCall?.slice(0, 2)).toEqual(["terminal.get-run", { runId: "run1" }]);
    expect(getRunCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
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
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: peer(request),
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
      registrationPluginId: "machine.remote.pi-web.terminal",
      workspace,
      peer: peer(vi.fn(() => Promise.resolve(null))),
      host: { navigateWorkspaceContribution },
    });

    terminal.open();
    terminal.open();
    terminal.open({ terminalId: "selected" });

    expect(navigateWorkspaceContribution.mock.calls).toEqual([
      [workspace, {
        contributionId: "machine.remote.pi-web.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { start: "1" },
      }],
      [workspace, {
        contributionId: "machine.remote.pi-web.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { start: "2" },
      }],
      [workspace, {
        contributionId: "machine.remote.pi-web.terminal:workspace.terminal",
        navigationAliases: ["core:workspace.terminal"],
        query: { terminal: "selected", start: undefined },
      }],
    ]);
  });

  it("lists command runs with only plugin-owned scoped filters", async () => {
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((): Promise<JsonValue> => Promise.resolve([runJson(runningRun)]));
    const controller = new AbortController();
    const facade = new TerminalFacade();

    await expect(facade.listCommandRuns({
      peer: peer(request),
      filter: { statuses: ["running"], metadata: { "pi.operation": "workspace.delete" } },
      signal: controller.signal,
    })).resolves.toEqual([runningRun]);

    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["terminal.list-runs", {
      statuses: ["running"],
      metadata: { "pi.operation": "workspace.delete" },
    }]);
    const requestSignal = request.mock.calls[0]?.[2]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal).not.toBe(controller.signal);
  });

  it("does not re-arm command polling when an in-flight response settles after disposal", async () => {
    vi.useFakeTimers();
    let resolveGetRun: (value: JsonValue) => void = () => undefined;
    const getRun = new Promise<JsonValue>((resolve) => { resolveGetRun = resolve; });
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((operation): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(runningRun));
      if (operation === "terminal.get-run") return getRun;
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const facade = new TerminalFacade({ pollIntervalMs: 25 });
    const terminal = facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: peer(request),
      host: { navigateWorkspaceContribution: vi.fn() },
    });
    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });
    await vi.advanceTimersByTimeAsync(25);
    expect(request.mock.calls.filter(([operation]) => operation === "terminal.get-run")).toHaveLength(1);

    facade.dispose();
    await expect(handle.completed).rejects.toMatchObject({ name: "AbortError" });
    resolveGetRun(runJson(runningRun));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    expect(request.mock.calls.filter(([operation]) => operation === "terminal.get-run")).toHaveLength(1);
  });

  it("aborts an in-flight command-run listing when disposed", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((_operation, _input, options): Promise<JsonValue> => new Promise((_resolve, reject) => {
      requestSignal = options?.signal;
      requestSignal?.addEventListener("abort", () => { reject(new DOMException("Listing aborted", "AbortError")); }, { once: true });
    }));
    const facade = new TerminalFacade();
    const listing = facade.listCommandRuns({ peer: peer(request) });
    await Promise.resolve();

    facade.dispose();

    expect(requestSignal?.aborted).toBe(true);
    await expect(listing).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels command polling and rejects retained helpers when disposed", async () => {
    const timer = globalThis.setTimeout(() => undefined, 60_000);
    const setTimer = vi.fn((handler: () => void, timeout: number) => {
      void handler;
      void timeout;
      return timer;
    });
    const clearTimer = vi.fn((id: ReturnType<typeof globalThis.setTimeout>) => { globalThis.clearTimeout(id); });
    const request = vi.fn((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.run") return Promise.resolve(runJson(runningRun));
      return Promise.reject(new Error(`unexpected operation ${operation}`));
    });
    const facade = new TerminalFacade({ pollIntervalMs: 25, setTimeout: setTimer, clearTimeout: clearTimer });
    const terminal = facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: peer(request),
      host: { navigateWorkspaceContribution: vi.fn() },
    });
    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });

    expect(setTimer).toHaveBeenCalledOnce();
    facade.dispose();

    await expect(handle.completed).rejects.toMatchObject({ name: "AbortError" });
    expect(clearTimer).toHaveBeenCalledWith(timer);
    expect(() => { terminal.open(); }).toThrow(expect.objectContaining({ name: "AbortError" }));
    await expect(terminal.runCommand({ title: "Again", command: "true" })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed when the peer request capability is absent", () => {
    const facade = new TerminalFacade();
    expect(() => facade.createWorkspaceTerminal({
      origin: "actions",
      registrationPluginId: "pi-web.terminal",
      workspace,
      // @ts-expect-error Exercise the runtime guard against a malformed host capability.
      peer: {},
      host: { navigateWorkspaceContribution: vi.fn() },
    })).toThrow("Required Terminal peer request capability is unavailable");
  });
});

function peer(request: NonNullable<PluginPeer["request"]>): PluginPeer {
  return { request };
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
