import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ProviderRemoveContext,
  ProviderWorkspace,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { TerminalCommandRun, WorkspaceListing } from "../../shared/apiTypes.js";
import type { ServerPluginProviderContribution } from "../plugins/serverPluginRuntime.js";
import type { Project } from "../types.js";
import type { RunTerminalCommandOptions } from "../terminals/terminalService.js";
import {
  WorkspaceProviderRegistry,
  type WorkspaceProviderRemovalTarget,
} from "./workspaceProviderRegistry.js";
import {
  WorkspaceRemovalService,
  type WorkspaceRemovalProvider,
  type WorkspaceRemovalTerminalHost,
} from "./workspaceRemovalService.js";
import {
  worktreePreRemoveHookPath,
  type WorktreePreRemoveHookProbe,
} from "./worktreePreRemoveHook.js";

const project: Project = {
  id: "project-1",
  name: "Roadmap",
  path: hostPath("/repo"),
  createdAt: "2026-07-27T00:00:00.000Z",
};

/**
 * Registry-driven flows resolve every project/provider path into the host's
 * absolute form, so those fixture paths must use the resolved platform form.
 */
function hostPath(path: string): string {
  return resolve(path);
}

describe("WorkspaceRemovalService", () => {
  it("runs a neutral provider's non-file-deleting plan after every validation and preserves host metadata", async () => {
    const calls: string[] = [];
    let preparedContext: ProviderRemoveContext | undefined;
    const provider: WorkspaceProvider = {
      probe: () => { calls.push("probe"); return Promise.resolve("claim"); },
      list: () => {
        calls.push("list");
        return Promise.resolve([
          providerWorkspace("main", hostPath("/repo"), true),
          providerWorkspace("roadmap", hostPath("/board-views/roadmap"), false, {
            data: { viewId: "private-roadmap" },
            removal: {
              actionLabel: "Disconnect view",
              confirmation: "Disconnect the Roadmap view without deleting board files?",
            },
          }),
        ]);
      },
      prepareRemove: (context) => {
        calls.push("prepare");
        preparedContext = context;
        if (readPrivateViewId(context.workspace.data) !== "private-roadmap") {
          throw new Error("private view identity missing");
        }
        return Promise.resolve({
          title: "Disconnect board view: Roadmap",
          command: "boardctl view disconnect roadmap --keep-files",
        });
      },
    };
    const registry = registryFor(provider);
    const resolution = await registry.resolve(project);
    const target = resolution.workspaces.find(({ path }) => path === hostPath("/board-views/roadmap"));
    const commandWorkspace = resolution.workspaces.find(({ isMain }) => isMain);
    if (target === undefined || commandWorkspace === undefined) throw new Error("Expected neutral removable workspace");
    expect(target.removal).toMatchObject({
      actionLabel: "Disconnect view",
      confirmation: "Disconnect the Roadmap view without deleting board files?",
    });
    expect(target.removal?.precondition).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    const terminals = terminalHost(calls);
    const removals = new WorkspaceRemovalService(registry, terminals);

    const run = await removals.remove(project, target.id, removalPrecondition(target));

    expect(calls).toEqual(["probe", "list", "probe", "list", "prepare", "close", "run"]);
    expect(preparedContext).toMatchObject({
      project: { id: project.id, path: project.path },
      workspace: {
        path: hostPath("/board-views/roadmap"),
        data: { viewId: "private-roadmap" },
        removal: {
          actionLabel: "Disconnect view",
          confirmation: "Disconnect the Roadmap view without deleting board files?",
        },
      },
    });
    expect(preparedContext?.workspace.removal).toEqual({
      actionLabel: "Disconnect view",
      confirmation: "Disconnect the Roadmap view without deleting board files?",
    });
    expect(preparedContext?.signal.aborted).toBe(true);
    expect(terminals.closedCwds).toEqual([hostPath("/board-views/roadmap")]);
    expect(terminals.runOptions).toEqual([{
      origin: "core",
      projectId: project.id,
      workspaceId: commandWorkspace.id,
      cwd: hostPath("/repo"),
      title: "Disconnect board view: Roadmap",
      command: "boardctl view disconnect roadmap --keep-files",
      metadata: {
        "pi.operation": "workspace.delete",
        "target.workspaceId": target.id,
        "target.workspacePath": hostPath("/board-views/roadmap"),
      },
    }]);
    expect(run).toMatchObject({
      title: "Disconnect board view: Roadmap",
      command: "boardctl view disconnect roadmap --keep-files",
      workspaceId: terminals.runOptions[0]?.workspaceId,
    });
  });

  it.each([
    {
      name: "main workspace",
      project,
      target: hostWorkspace("target", "/linked", true),
      others: [hostWorkspace("command", "/repo", false)],
      message: "main workspace cannot be removed",
    },
    {
      name: "filesystem root",
      project,
      target: hostWorkspace("target", "/", false),
      others: [hostWorkspace("command", "/repo", true)],
      message: "filesystem root cannot be removed",
    },
    {
      name: "registered project itself",
      project,
      target: hostWorkspace("target", "/repo", false),
      others: [hostWorkspace("command", "/other", true)],
      message: "registered project itself",
    },
    {
      name: "ancestor of the registered project",
      project: { ...project, path: "/repo/packages/app" },
      target: hostWorkspace("target", "/repo", false),
      others: [hostWorkspace("command", "/other", true)],
      message: "containing the registered project",
    },
  ])("rejects a provider-advertised $name before provider or terminal side effects", async ({ project: input, target, others, message }) => {
    const prepare = vi.fn(() => Promise.resolve({ title: "Unsafe", command: "unsafe" }));
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [target, ...others],
      prepare,
    }), terminals);

    await expect(removals.remove(input, target.id, removalPrecondition(target))).rejects.toThrow(message);

    expect(prepare).not.toHaveBeenCalled();
    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("requires the current owner and a safe non-target command workspace", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const prepare = vi.fn(() => Promise.resolve({ title: "Remove", command: "neutral remove" }));
    const terminals = terminalHost();
    const wrongOwner = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "other",
      target,
      workspaces: [target, hostWorkspace("main", "/repo", true)],
      prepare,
    }), terminals);

    await expect(wrongOwner.remove(project, target.id, removalPrecondition(target))).rejects.toThrow("owner is no longer current");

    const noCommand = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [target, { ...hostWorkspace("foreign", "/foreign", true), projectId: "other-project" }],
      prepare,
    }), terminals);
    await expect(noCommand.remove(project, target.id, removalPrecondition(target))).rejects.toThrow("non-target command workspace is required");

    expect(prepare).not.toHaveBeenCalled();
    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("does not close terminals or create a command run when provider validation fails", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => Promise.reject(new Error("workspace has unsubmitted changes")),
    }), terminals);

    await expect(removals.remove(project, target.id, removalPrecondition(target))).rejects.toThrow("workspace has unsubmitted changes");

    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("rejects a stale host-issued confirmation before provider or terminal side effects", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const prepare = vi.fn(() => Promise.resolve({ title: "Remove", command: "neutral remove" }));
    const terminals = terminalHost();
    const resolveRemoval = vi.fn(() => Promise.resolve({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare,
    }));
    const removals = new WorkspaceRemovalService({ resolveRemoval }, terminals);

    await expect(removals.remove(project, target.id, "stale-confirmation")).rejects.toMatchObject({
      statusCode: 409,
      message: "Workspace removal confirmation is stale; review the current workspace and confirm again",
    });

    expect(resolveRemoval).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("single-flights matching confirmations and keeps the operation alive for a remaining waiter", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const prepare = vi.fn(() => Promise.resolve({ title: "Remove", command: "neutral remove" }));
    const current: WorkspaceProviderRemovalTarget = {
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare,
    };
    let releaseResolution: ((value: WorkspaceProviderRemovalTarget) => void) | undefined;
    let operationSignal: AbortSignal | undefined;
    const resolveRemoval = vi.fn((_project: Project, _workspaceId: string, signal: AbortSignal) => {
      operationSignal = signal;
      return new Promise<WorkspaceProviderRemovalTarget>((resolvePromise) => {
        releaseResolution = resolvePromise;
      });
    });
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService({ resolveRemoval }, terminals);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = removals.remove(project, target.id, removalPrecondition(target), firstController.signal);
    const second = removals.remove(project, target.id, removalPrecondition(target), secondController.signal);
    await vi.waitFor(() => { expect(resolveRemoval).toHaveBeenCalledOnce(); });
    await expect(removals.remove(project, target.id, "another-confirmation")).rejects.toMatchObject({
      statusCode: 409,
      message: "Workspace removal is already in progress with a different confirmation",
    });

    const firstExpectation = expect(first).rejects.toMatchObject({ name: "AbortError" });
    firstController.abort(new DOMException("First caller left", "AbortError"));
    await firstExpectation;
    expect(operationSignal?.aborted).toBe(false);

    releaseResolution?.(current);
    await expect(second).resolves.toMatchObject({ id: "run-1", command: "neutral remove" });

    expect(prepare).toHaveBeenCalledOnce();
    expect(terminals.closedCwds).toEqual(["/linked"]);
    expect(terminals.runOptions).toHaveLength(1);
  });

  it("uses one aggregate deadline across resolution and planning and guards late completion", async () => {
    vi.useFakeTimers();
    try {
      const target = hostWorkspace("target", "/linked", false);
      let operationSignal: AbortSignal | undefined;
      let releasePlan: ((value: { title: string; command: string }) => void) | undefined;
      const prepare = vi.fn(() => new Promise<{ title: string; command: string }>((resolvePromise) => {
        releasePlan = resolvePromise;
      }));
      const resolveRemoval = vi.fn((_project: Project, _workspaceId: string, signal: AbortSignal) => {
        operationSignal = signal;
        return new Promise<WorkspaceProviderRemovalTarget>((resolvePromise) => {
          setTimeout(() => {
            resolvePromise({
              ownerPluginId: "neutral",
              target,
              workspaces: [hostWorkspace("main", "/repo", true), target],
              prepare,
            });
          }, 20);
        });
      });
      const terminals = terminalHost();
      const removals = new WorkspaceRemovalService({ resolveRemoval }, terminals, { timeoutMs: 25 });

      const pending = removals.remove(project, target.id, removalPrecondition(target));
      const expectation = expect(pending).rejects.toMatchObject({
        statusCode: 504,
        message: "Workspace removal timed out after 25ms",
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(prepare).toHaveBeenCalledOnce();
      expect(operationSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(5);
      await expectation;
      expect(operationSignal?.aborted).toBe(true);
      expect(terminals.closedCwds).toEqual([]);
      expect(terminals.runOptions).toEqual([]);

      releasePlan?.({ title: "Too late", command: "must not run" });
      await Promise.resolve();
      await Promise.resolve();
      expect(terminals.closedCwds).toEqual([]);
      expect(terminals.runOptions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("chains an executable repo pre-remove hook before the provider's removal command", async () => {
    const target = hostWorkspace("target", "/repo/wt 'x'", false);
    const calls: string[] = [];
    const terminals = terminalHost(calls);
    const probedPaths: string[] = [];
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => { calls.push("prepare"); return Promise.resolve({ title: "Remove", command: "neutral remove" }); },
    }), terminals, { preRemoveHook: hookProbe(probedPaths, true) });

    await removals.remove(project, target.id, removalPrecondition(target));

    const hookPath = worktreePreRemoveHookPath("/repo");
    expect(probedPaths).toEqual([hookPath]);
    // `&&` is the fail-closed guarantee: a non-zero hook exit blocks the removal.
    expect(terminals.runOptions[0]?.command).toBe(`'${hookPath}' '/repo/wt '\\''x'\\''' && neutral remove`);
    expect(calls).toEqual(["prepare", "close", "run"]);
  });

  it("leaves the provider's removal command unchanged when no hook is executable", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const terminals = terminalHost();
    const probedPaths: string[] = [];
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => Promise.resolve({ title: "Remove", command: "neutral remove" }),
    }), terminals, { preRemoveHook: hookProbe(probedPaths, false) });

    await removals.remove(project, target.id, removalPrecondition(target));

    expect(probedPaths).toEqual([worktreePreRemoveHookPath("/repo")]);
    expect(terminals.runOptions[0]?.command).toBe("neutral remove");
  });

  it("fails before closing terminals when the hook probe hits an unexpected filesystem error", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const terminals = terminalHost();
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => Promise.resolve({ title: "Remove", command: "neutral remove" }),
    }), terminals, {
      preRemoveHook: { isExecutable: () => Promise.reject(Object.assign(new Error("probe I/O error"), { code: "EIO" })) },
    });

    await expect(removals.remove(project, target.id, removalPrecondition(target))).rejects.toMatchObject({
      statusCode: 500,
      message: "Failed to inspect the workspace pre-remove hook: probe I/O error",
    });

    expect(terminals.closedCwds).toEqual([]);
    expect(terminals.runOptions).toEqual([]);
  });

  it("closes target terminals before command creation and never starts after cleanup failure", async () => {
    const target = hostWorkspace("target", "/linked", false);
    const calls: string[] = [];
    const terminals = terminalHost(calls, new Error("cleanup failed"));
    const removals = new WorkspaceRemovalService(removalProvider({
      ownerPluginId: "neutral",
      target,
      workspaces: [hostWorkspace("main", "/repo", true), target],
      prepare: () => { calls.push("prepare"); return Promise.resolve({ title: "Remove", command: "neutral remove" }); },
    }), terminals);

    await expect(removals.remove(project, target.id, removalPrecondition(target))).rejects.toThrow("Failed to close workspace terminals: cleanup failed");

    expect(calls).toEqual(["prepare", "close"]);
    expect(terminals.runOptions).toEqual([]);
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

function providerWorkspace(
  key: string,
  path: string,
  isMain: boolean,
  extras: Partial<ProviderWorkspace> = {},
): ProviderWorkspace {
  return { key, path, label: key === "roadmap" ? "Roadmap" : key, isMain, ...extras };
}

function hostWorkspace(id: string, path: string, isMain: boolean): WorkspaceListing {
  return {
    id,
    projectId: project.id,
    path,
    label: id,
    isMain,
    provider: { pluginId: "neutral", capabilities: { request: false, remove: true } },
    removal: {
      actionLabel: "Disconnect",
      confirmation: "Disconnect this workspace?",
      precondition: `removal-${id}`,
    },
  };
}

function removalProvider(target: WorkspaceProviderRemovalTarget): WorkspaceRemovalProvider {
  return { resolveRemoval: () => Promise.resolve(target) };
}

function hookProbe(probedPaths: string[], executable: boolean): WorktreePreRemoveHookProbe {
  return {
    isExecutable(path) {
      probedPaths.push(path);
      return Promise.resolve(executable);
    },
  };
}

function removalPrecondition(workspace: WorkspaceListing): string {
  const precondition = workspace.removal?.precondition;
  if (precondition === undefined) throw new Error("Expected removal precondition");
  return precondition;
}

function terminalHost(calls: string[] = [], closeFailure?: Error): WorkspaceRemovalTerminalHost & {
  closedCwds: string[];
  runOptions: RunTerminalCommandOptions[];
} {
  const closedCwds: string[] = [];
  const runOptions: RunTerminalCommandOptions[] = [];
  return {
    closedCwds,
    runOptions,
    closeForCwd(cwd) {
      calls.push("close");
      if (closeFailure !== undefined) throw closeFailure;
      closedCwds.push(cwd);
    },
    runCommand(options) {
      calls.push("run");
      runOptions.push(options);
      return commandRun(options);
    },
  };
}

function commandRun(options: RunTerminalCommandOptions): TerminalCommandRun {
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
}

function requireStringMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected command metadata");
  const entries = Object.entries(value);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    throw new Error("Expected string command metadata");
  }
  return Object.fromEntries(entries);
}

function readPrivateViewId(value: ProviderWorkspace["data"]): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const viewId: unknown = Reflect.get(value, "viewId");
  return typeof viewId === "string" ? viewId : undefined;
}
