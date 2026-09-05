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
      registrationPluginId: "terminal",
      workspace,
      backend: { capabilityVersion: 1, request: vi.fn() },
      host: { navigateWorkspaceContribution: vi.fn() },
    });

    terminal.open({ terminalId: "terminal-1" });
    const handle = await terminal.runCommand({ title: "Build", command: "npm run build" });

    expect(open).toHaveBeenCalledWith({ terminalId: "terminal-1" });
    expect(handle.run).toEqual(run);
    await expect(handle.completed).resolves.toEqual(run);
    await expect(facade.listCommandRuns({ backend: { capabilityVersion: 1, request: vi.fn() } })).resolves.toEqual([run]);
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
