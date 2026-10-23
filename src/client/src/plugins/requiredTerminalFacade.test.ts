import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { requiredTerminalUnavailableError, snapshotRequiredTerminalBrowserFacade } from "./requiredTerminalFacade";

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

const run = {
  id: "run-1",
  origin: "tasks",
  projectId: "project-1",
  workspaceId: "workspace-1",
  terminalId: "terminal-1",
  title: "Build",
  command: "npm run build",
  status: "succeeded" as const,
  exitCode: 0,
  createdAt: "now",
  completedAt: "later",
  metadata: {},
};

describe("required Terminal browser composition port", () => {
  it("snapshots the facade and validates command-run results", async () => {
    const open = vi.fn();
    const runCommand = vi.fn(() => Promise.resolve({ run, completed: Promise.resolve(run) }));
    const facade = snapshotRequiredTerminalBrowserFacade({
      version: 1,
      createWorkspaceTerminal: () => ({ open, runCommand }),
      listCommandRuns: () => Promise.resolve([run]),
      parseCommandRun: (value: unknown) => value,
    });
    const terminal = facade.createWorkspaceTerminal({
      origin: "tasks",
      registrationPluginId: "pi-web.terminal",
      workspace,
      peer: { request: vi.fn() },
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    terminal.open({ terminalId: "terminal-1" });
    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });

    expect(open).toHaveBeenCalledWith({ terminalId: "terminal-1" });
    expect(handle.run).toEqual(run);
    await expect(handle.completed).resolves.toEqual(run);
    await expect(facade.listCommandRuns({ peer: { request: vi.fn() } })).resolves.toEqual([run]);
  });

  it("preserves optional maintenance composition and rejects mixed scope identities", async () => {
    const maintenance = {
      id: "maintenance-run", scope: "maintenance", origin: "updates", terminalId: "maintenance-terminal",
      title: "Update", command: "pi-web update", status: "succeeded", createdAt: "now", metadata: {},
    };
    const runCommand = vi.fn(() => Promise.resolve({ run: maintenance, completed: Promise.resolve(maintenance) }));
    const facade = snapshotRequiredTerminalBrowserFacade({
      version: 1,
      createWorkspaceTerminal: vi.fn(),
      createMaintenanceTerminal: () => ({ open: vi.fn(), runCommand }),
      listCommandRuns: () => Promise.resolve([maintenance]),
      parseCommandRun: (value: unknown) => value,
    });
    const terminal = facade.createMaintenanceTerminal?.({ origin: "updates", machineId: "remote", registrationPluginId: "machine.remote.pi-web.terminal", peer: { request: vi.fn() }, host: { navigateApplicationContribution: vi.fn() } });
    expect(terminal).toBeDefined();
    const handle = await terminal?.runCommand({ title: "Update", command: "pi-web update" });
    expect(handle?.run).toEqual(maintenance);
    await expect(handle?.completed).resolves.toEqual(maintenance);
    expect(() => facade.parseCommandRun(maintenance)).toThrow("invalid command run");
    await expect(facade.listCommandRuns({ peer: { request: vi.fn() } })).rejects.toThrow("invalid command run");
    expect(() => facade.parseCommandRun({ ...maintenance, projectId: "unexpected" })).toThrow("invalid command run");
    expect(() => facade.parseCommandRun({ ...run, scope: "unknown" })).toThrow("invalid command run");
  });

  it.each(["workspace", "maintenance"] as const)("validates both initial and completed %s command handle scope", async (scope) => {
    const maintenance = { ...run, scope: "maintenance", projectId: undefined, workspaceId: undefined };
    const matchingRun = scope === "workspace" ? run : maintenance;
    const wrongRun = scope === "workspace" ? maintenance : run;
    let initial: unknown = wrongRun;
    let completed: unknown = matchingRun;
    const createTerminal = () => ({ open: vi.fn(), runCommand: () => Promise.resolve({ run: initial, completed: Promise.resolve(completed) }) });
    const facade = snapshotRequiredTerminalBrowserFacade({
      version: 1,
      createWorkspaceTerminal: createTerminal,
      createMaintenanceTerminal: createTerminal,
      listCommandRuns: () => Promise.resolve([]),
      parseCommandRun: (value: unknown) => value,
    });
    const common = { origin: "tasks", registrationPluginId: "pi-web.terminal", peer: { request: vi.fn() } };
    const terminal = scope === "workspace"
      ? facade.createWorkspaceTerminal({ ...common, workspace, host: { navigateWorkspaceContribution: vi.fn() } })
      : facade.createMaintenanceTerminal?.({ ...common, machineId: "local", host: { navigateApplicationContribution: () => true } });
    if (terminal === undefined) throw new Error("Missing maintenance terminal");
    const input = { title: "Build", command: "true" };
    await expect(terminal.runCommand(input)).rejects.toThrow("invalid command run");
    initial = matchingRun;
    completed = wrongRun;
    const handle = await terminal.runCommand(input);
    await expect(handle.completed).rejects.toThrow("invalid command run");
  });

  it("rejects missing facade methods and malformed command records", () => {
    expect(() => snapshotRequiredTerminalBrowserFacade({ version: 1 })).toThrow("did not provide facade v1");
    const facade = snapshotRequiredTerminalBrowserFacade({
      version: 1,
      createWorkspaceTerminal: () => ({ open: vi.fn(), runCommand: vi.fn() }),
      listCommandRuns: () => Promise.resolve([]),
      parseCommandRun: () => ({ id: "incomplete" }),
    });
    expect(() => facade.parseCommandRun({})).toThrow("invalid command run");
  });

  it("attributes pending or recovery unavailability to the selected machine", () => {
    expect(requiredTerminalUnavailableError("local").message).toContain("Required Terminal plugin is unavailable");
    expect(requiredTerminalUnavailableError("remote-1").message).toContain("remote-1");
  });
});
