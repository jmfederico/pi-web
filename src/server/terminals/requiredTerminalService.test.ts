import { describe, expect, it, vi } from "vitest";
import { snapshotRequiredTerminalService, unavailableRequiredTerminalService } from "./requiredTerminalService.js";

const run = {
  id: "run-1",
  origin: "core",
  projectId: "project-1",
  workspaceId: "workspace-1",
  terminalId: "terminal-1",
  title: "Remove workspace",
  command: "true",
  status: "running" as const,
  createdAt: "now",
  metadata: {},
};

describe("required Terminal server composition port", () => {
  it("snapshots only close, command-run, and activity binding operations", () => {
    const closeForCwd = vi.fn();
    const runCommand = vi.fn(() => run);
    const bindActivitySink = vi.fn();
    const service = snapshotRequiredTerminalService({ closeForCwd, runCommand, bindActivitySink, extra: vi.fn() });

    service.closeForCwd("/repo");
    const options = {
      projectId: "project-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      origin: "core",
      title: "Remove workspace",
      command: "true",
      failureNotice: {
        message: "Workspace removal failed. See terminal output.",
        context: { projectId: "project-1", targetWorkspaceId: "workspace-2" },
      },
    };
    expect(service.runCommand(options)).toEqual(run);
    service.bindActivitySink({ updateTerminal: vi.fn(), removeTerminal: vi.fn() });

    expect(closeForCwd).toHaveBeenCalledWith("/repo");
    expect(runCommand).toHaveBeenCalledWith(options);
    expect(bindActivitySink).toHaveBeenCalledOnce();
    expect(service).not.toHaveProperty("legacyRoutes");
  });

  it("rejects malformed service and command-run contributions", () => {
    expect(() => snapshotRequiredTerminalService({})).toThrow("did not provide its composition service");
    const service = snapshotRequiredTerminalService({
      closeForCwd: vi.fn(),
      runCommand: () => ({ id: "incomplete" }),
      bindActivitySink: vi.fn(),
    });
    expect(() => service.runCommand({
      projectId: "project-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      origin: "core",
      title: "Remove workspace",
      command: "true",
    })).toThrow("invalid command run");
  });

  it("fails recovery commands before callers can report success", () => {
    const service = unavailableRequiredTerminalService();
    expect(() => { service.closeForCwd("/repo"); }).toThrow("unavailable in recovery safe start");
    expect(() => service.runCommand({
      projectId: "project-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      origin: "core",
      title: "Remove workspace",
      command: "true",
    })).toThrow("unavailable in recovery safe start");
  });
});
