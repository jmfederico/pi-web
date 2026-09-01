import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCreateContext, WorkspaceProvider } from "../../server-plugin-api.js";
import type { TerminalCommandRun } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { RunTerminalCommandOptions } from "../terminals/terminalService.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "./workspaceProviderRegistry.js";
import {
  WorkspaceCreationError,
  WorkspaceCreationService,
  type WorkspaceCreationTerminalHost,
} from "./workspaceCreationService.js";

const project: Project = {
  id: "project-1",
  name: "Roadmap",
  path: resolve("/repo"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceCreationService", () => {
  it("runs the owner's plan in the main workspace and records creation metadata", async () => {
    const parentPath = await temporaryDirectory();
    let prepared: ProviderCreateContext | undefined;
    const terminals = recordingTerminals();
    const service = new WorkspaceCreationService(
      registryFor({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([{ key: "main", path: resolve("/repo"), label: "main", isMain: true }]),
        prepareCreate: (context) => {
          prepared = context;
          return Promise.resolve({ title: "Create workspace: spike", command: "boardctl view add spike" });
        },
      }),
      terminals,
    );

    const run = await service.create(project, { parentPath, name: "  spike  " });

    expect(prepared).toMatchObject({ parentPath, name: "spike" });
    expect(run.status).toBe("running");
    expect(terminals.calls[0]).toMatchObject({
      origin: "core",
      projectId: "project-1",
      cwd: resolve("/repo"),
      title: "Create workspace: spike",
      command: "boardctl view add spike",
      metadata: { "pi.operation": "workspace.create", "created.workspaceName": "spike" },
    });
  });

  it("rejects names that could escape the chosen directory before any provider runs", async () => {
    const parentPath = await temporaryDirectory();
    const prepareCreate = vi.fn();
    const service = new WorkspaceCreationService(
      registryFor({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([{ key: "main", path: resolve("/repo"), label: "main", isMain: true }]),
        prepareCreate,
      }),
      recordingTerminals(),
    );

    await expect(service.create(project, { parentPath, name: "../escape" }))
      .rejects.toThrow(WorkspaceCreationError);
    expect(prepareCreate).not.toHaveBeenCalled();
  });

  it("fails when the chosen location is not a directory", async () => {
    const parentPath = await temporaryDirectory();
    const file = join(parentPath, "notes.txt");
    await writeFile(file, "notes\n", "utf8");
    const service = new WorkspaceCreationService(
      registryFor({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([{ key: "main", path: resolve("/repo"), label: "main", isMain: true }]),
        prepareCreate: () => Promise.resolve({ title: "Create", command: "true" }),
      }),
      recordingTerminals(),
    );

    await expect(service.create(project, { parentPath: file, name: "spike" }))
      .rejects.toThrow(/not a directory/u);
  });

  it("reports owners that do not support creation", async () => {
    const parentPath = await temporaryDirectory();
    const service = new WorkspaceCreationService(
      registryFor({
        probe: () => Promise.resolve("claim"),
        list: () => Promise.resolve([{ key: "main", path: resolve("/repo"), label: "main", isMain: true }]),
      }),
      recordingTerminals(),
    );

    await expect(service.create(project, { parentPath, name: "spike" }))
      .rejects.toThrow(/does not support workspace creation/u);
  });
});

function registryFor(provider: WorkspaceProvider): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions: [contribution("neutral", provider)],
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function contribution(pluginId: string, provider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "test fixture",
    scope: "local",
    moduleRevision: "1",
    provider,
  };
}

function recordingTerminals(): WorkspaceCreationTerminalHost & { calls: RunTerminalCommandOptions[] } {
  const calls: RunTerminalCommandOptions[] = [];
  return {
    calls,
    runCommand(options: RunTerminalCommandOptions): TerminalCommandRun {
      calls.push(options);
      return {
        id: "run-1",
        origin: options.origin,
        projectId: options.projectId,
        workspaceId: options.workspaceId,
        terminalId: "terminal-1",
        title: options.title,
        command: options.command,
        status: "running",
        createdAt: "2026-07-27T00:00:00.000Z",
        metadata: requireStringMetadata(options.metadata),
      };
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-web-workspace-creation-"));
  temporaryRoots.push(path);
  return path;
}

function requireStringMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected command metadata");
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Expected string command metadata");
  }
  return Object.fromEntries(entries);
}
