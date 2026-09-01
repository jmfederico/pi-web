import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JsonValue,
  PairedPluginChannelOpenContext,
  PairedPluginRequestContext,
  WorkspaceProvider,
} from "../../server-plugin-api.js";
import type { Project } from "../types.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import type {
  ServerPluginPairedBackendContribution,
  ServerPluginProviderContribution,
} from "./serverPluginRuntime.js";
import {
  eligiblePluginBackendContributions,
  PluginBackendRegistry,
} from "./pluginBackendRegistry.js";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: resolve("/repo"),
  createdAt: "2026-08-01T00:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PluginBackendRegistry", () => {
  it("dispatches a non-provider plugin against a host-resolved provider workspace", async () => {
    let observed: PairedPluginRequestContext | undefined;
    const workspaces = providerRegistry([providerContribution("git", {
      fallback: true,
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{
        key: "worktree",
        path: join(project.path, "worktree"),
        label: "feature/paired",
        isMain: true,
        data: { privateHead: "secret" },
        publicMetadata: { branch: "feature/paired" },
      }]),
    })]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected provider workspace");
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("terminal", (context) => {
        observed = context;
        return {
          workspaceId: context.workspace.id,
          owner: context.workspace.provider?.pluginId ?? null,
          input: context.input,
        };
      })],
      workspaces,
    });

    await expect(registry.request({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.list",
      input: { includeExited: false },
    })).resolves.toEqual({
      workspaceId,
      owner: "git",
      input: { includeExited: false },
    });

    if (observed === undefined) throw new Error("Expected paired backend context");
    expect(observed.project).toEqual({ id: project.id, name: project.name, path: project.path });
    expect(observed.workspace).toMatchObject({
      id: workspaceId,
      projectId: project.id,
      path: join(project.path, "worktree"),
      label: "feature/paired",
      provider: {
        pluginId: "git",
        capabilities: { request: false, remove: false },
        metadata: { branch: "feature/paired" },
      },
    });
    expect(observed.workspace).not.toHaveProperty("data");
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.project)).toBe(true);
    expect(Object.isFrozen(observed.workspace)).toBe(true);
    expect(Object.isFrozen(observed.workspace.provider)).toBe(true);
    expect(Object.isFrozen(observed.workspace.provider?.metadata)).toBe(true);
    expect(Object.isFrozen(observed.input)).toBe(true);
    expect(observed.signal.aborted).toBe(true);
  });

  it("dispatches a paired backend for the kernel folder workspace", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("notes", ({ workspace }) => ({
        path: workspace.path,
        provider: workspace.provider?.pluginId ?? null,
      }))],
      workspaces,
    });

    await expect(registry.request({
      pluginId: "notes",
      moduleRevision: "notes-r1",
      project,
      workspaceId,
      operation: "notes.summary",
      input: null,
    })).resolves.toEqual({ path: project.path, provider: null });
  });

  it("preserves the legacy owner-only provider request fallback", async () => {
    const request = vi.fn<NonNullable<WorkspaceProvider["request"]>>(({ workspace, operation }) => Promise.resolve({
      privateData: workspace.data ?? null,
      operation,
    }));
    const workspaces = providerRegistry([providerContribution("git", {
      probe: () => Promise.resolve("claim"),
      list: () => Promise.resolve([{
        key: "main",
        path: project.path,
        label: "main",
        isMain: true,
        data: { head: "abc123" },
      }]),
      request,
    })]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected provider workspace");
    const registry = new PluginBackendRegistry({ contributions: [], workspaces });

    await expect(registry.request({
      pluginId: "git",
      moduleRevision: "git-r1",
      project,
      workspaceId,
      operation: "git.status",
      input: null,
    })).resolves.toEqual({ privateData: { head: "abc123" }, operation: "git.status" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("attributes stale revisions, missing workspaces, and invalid JSON boundaries", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("notes", ({ operation }) => {
        if (operation === "notes.fail") throw new Error("backend exploded");
        return operation === "notes.invalid-result" ? Number.NaN : null;
      })],
      workspaces,
    });
    const base = { pluginId: "notes", moduleRevision: "notes-r1", project, workspaceId };

    await expect(registry.request({ ...base, moduleRevision: "old", operation: "notes.list", input: null }))
      .rejects.toMatchObject({ code: "stale-plugin-revision", statusCode: 409 });
    await expect(registry.request({ ...base, workspaceId: "missing", operation: "notes.list", input: null }))
      .rejects.toMatchObject({ code: "workspace-not-found", statusCode: 404 });
    await expect(registry.request({ ...base, operation: "notes.list", input: { invalid: Number.NaN } }))
      .rejects.toMatchObject({ code: "invalid-input", statusCode: 400 });
    await expect(registry.request({ ...base, operation: "notes.invalid-result", input: null }))
      .rejects.toMatchObject({ code: "invalid-result", statusCode: 502 });
    const failed = await registry.request({ ...base, operation: "notes.fail", input: null }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "request-failed", statusCode: 502 });
    expect(failed).toBeInstanceOf(Error);
    if (!(failed instanceof Error)) throw new Error("Expected attributed backend failure");
    expect(failed.message).toContain("backend exploded");

    const invalidScope = new PluginBackendRegistry({
      contributions: [backendContribution("notes", () => null)],
      workspaces: {
        resolve: () => Promise.resolve({
          status: "folder",
          projectId: project.id,
          workspaces: [{
            id: workspaceId,
            projectId: "another-project",
            path: project.path,
            label: "Project",
            isMain: true,
          }],
          diagnostics: [],
        }),
        request: () => Promise.resolve(null),
      },
    });
    await expect(invalidScope.request({ ...base, operation: "notes.list", input: null }))
      .rejects.toMatchObject({ code: "invalid-scope", statusCode: 502 });
  });

  it("bounds direct callbacks and aborts their operation signal", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("notes", ({ signal }) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("fixture aborted", { cause: reason }));
        }, { once: true });
      }))],
      workspaces,
      callbackTimeoutMs: 50,
      dispatchTimeoutMs: 100,
    });

    const pending = registry.request({
      pluginId: "notes",
      moduleRevision: "notes-r1",
      project,
      workspaceId,
      operation: "notes.wait",
      input: null,
    });
    const assertion = expect(pending).rejects.toMatchObject({ code: "request-timeout", statusCode: 504 });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("propagates caller cancellation into the direct callback with attribution", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise; });
    let observedSignal: AbortSignal | undefined;
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("notes", ({ signal }) => new Promise((_resolve, rejectPromise) => {
        observedSignal = signal;
        resolveStarted?.();
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("fixture aborted", { cause: reason }));
        }, { once: true });
      }))],
      workspaces,
    });
    const pending = registry.request({
      pluginId: "notes",
      moduleRevision: "notes-r1",
      project,
      workspaceId,
      operation: "notes.wait",
      input: null,
    }, controller.signal);

    await started;
    controller.abort(new DOMException("Browser disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ code: "request-cancelled", statusCode: 499 });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("cancels workspace authority resolution before a direct callback starts", async () => {
    const controller = new AbortController();
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise; });
    let probeSignal: AbortSignal | undefined;
    const workspaces = providerRegistry([providerContribution("git", {
      probe: (_project, signal) => new Promise((_resolve, rejectPromise) => {
        probeSignal = signal;
        resolveStarted?.();
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          rejectPromise(reason instanceof Error ? reason : new Error("probe aborted", { cause: reason }));
        }, { once: true });
      }),
      list: () => Promise.resolve([]),
    })]);
    const request = vi.fn(() => null);
    const registry = new PluginBackendRegistry({
      contributions: [backendContribution("notes", request)],
      workspaces,
    });
    const pending = registry.request({
      pluginId: "notes",
      moduleRevision: "notes-r1",
      project,
      workspaceId: "unresolved",
      operation: "notes.wait",
      input: null,
    }, controller.signal);

    await started;
    controller.abort(new DOMException("Browser disconnected", "AbortError"));

    await expect(pending).rejects.toMatchObject({ code: "request-cancelled", statusCode: 499 });
    expect(probeSignal?.aborted).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("opens a scoped duplex channel, bounds callbacks, and cleans up exactly once", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    let openContext: PairedPluginChannelOpenContext | undefined;
    let closeSignal: AbortSignal | undefined;
    const receive = vi.fn((data: JsonValue, signal: AbortSignal) => {
      expect(data).toEqual({ type: "input", value: "hello" });
      expect(signal.aborted).toBe(false);
    });
    const close = vi.fn((context: { code: number; reason: string; signal: AbortSignal }) => {
      closeSignal = context.signal;
    });
    const transport = channelTransport();
    const registry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", (context) => {
        openContext = context;
        context.send({ type: "output", value: "ready" });
        return { receive, close };
      })],
      workspaces,
    });

    const session = await registry.openChannel({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: { terminalId: "t1" },
    }, transport.value);

    if (openContext === undefined) throw new Error("Expected channel context");
    expect(openContext.workspace).toMatchObject({ id: workspaceId, projectId: project.id, path: project.path });
    expect(Object.isFrozen(openContext)).toBe(true);
    expect(Object.isFrozen(openContext.input)).toBe(true);
    expect(openContext.signal.aborted).toBe(false);
    expect(transport.sent).toEqual([{ type: "output", value: "ready" }]);
    await session.receive({ type: "input", value: "hello" });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0]?.[1].aborted).toBe(true);

    await Promise.all([session.close(1000, "done"), session.close(1001, "ignored")]);
    expect(openContext.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: 1000, reason: "done" }));
    expect(closeSignal?.aborted).toBe(true);
    expect(registry.activeChannelCount()).toBe(0);
  });

  it("releases admission and closes the transport when a plugin completes its channel", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    let complete: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { complete = resolve; });
    const close = vi.fn();
    const transport = channelTransport();
    const registry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => ({ closed, receive: () => undefined, close }))],
      workspaces,
    });

    await registry.openChannel({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    }, transport.value);
    expect(registry.activeChannelCount()).toBe(1);

    complete?.();

    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    expect(close).toHaveBeenCalledOnce();
    expect(transport.errors).toEqual([]);
    expect(transport.closes).toEqual([{ code: 1000, reason: "Plugin completed channel" }]);
  });

  it("enforces channel revision, workspace, and admission bounds with reusable release", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const registry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => ({ receive: () => undefined }))],
      workspaces,
      channelMaxTotal: 1,
      channelMaxPerPlugin: 1,
      channelMaxPerPluginWorkspace: 1,
    });
    const request = {
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    };

    await expect(registry.openChannel({ ...request, moduleRevision: "old" }, channelTransport().value))
      .rejects.toMatchObject({ code: "stale-plugin-revision", closeCode: 1008 });
    await expect(registry.openChannel({ ...request, workspaceId: "missing" }, channelTransport().value))
      .rejects.toMatchObject({ code: "workspace-not-found", closeCode: 1008 });

    const routeAdmission = registry.reserveChannel({ pluginId: "terminal", projectId: project.id, workspaceId });
    await expect(registry.openChannel(
      { ...request, project: { ...project, id: "other-project" } },
      channelTransport().value,
      undefined,
      routeAdmission,
    )).rejects.toMatchObject({ code: "admission-denied", closeCode: 1013 });
    expect(registry.activeChannelCount()).toBe(1);
    routeAdmission.release();
    expect(registry.activeChannelCount()).toBe(0);

    const first = await registry.openChannel(request, channelTransport().value);
    await expect(registry.openChannel(request, channelTransport().value))
      .rejects.toMatchObject({ code: "admission-denied", closeCode: 1013 });
    await first.close();
    const replacement = await registry.openChannel(request, channelTransport().value);
    expect(registry.activeChannelCount()).toBe(1);
    await registry.closeAll();
    await replacement.close();
    expect(registry.activeChannelCount()).toBe(0);
  });

  it("times out receive callbacks and cleans up channels that resolve after an open timeout", async () => {
    vi.useFakeTimers();
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    let receiveSignal: AbortSignal | undefined;
    const receiveRegistry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => ({
        receive: (_data, signal) => new Promise((_resolve, rejectPromise) => {
          receiveSignal = signal;
          signal.addEventListener("abort", () => {
            const reason: unknown = signal.reason;
            rejectPromise(reason instanceof Error ? reason : new Error("Receive aborted", { cause: reason }));
          }, { once: true });
        }),
      }))],
      workspaces,
      channelCallbackTimeoutMs: 50,
    });
    const receiveSession = await receiveRegistry.openChannel({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    }, channelTransport().value);
    const receiving = receiveSession.receive({ type: "input" });
    const receiveAssertion = expect(receiving).rejects.toMatchObject({ code: "receive-timeout", closeCode: 1011 });
    await vi.advanceTimersByTimeAsync(50);
    await receiveAssertion;
    expect(receiveSignal?.aborted).toBe(true);
    await receiveSession.close();

    let resolveOpen: ((channel: { receive(): void; close(): void }) => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise; });
    const lateClose = vi.fn();
    const openRegistry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => new Promise((resolvePromise) => {
        resolveOpen = resolvePromise;
        resolveStarted?.();
      }))],
      workspaces,
      channelOpenTimeoutMs: 50,
    });
    const opening = openRegistry.openChannel({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    }, channelTransport().value);
    await started;
    const openAssertion = expect(opening).rejects.toMatchObject({ code: "open-timeout", closeCode: 1011 });
    await vi.advanceTimersByTimeAsync(50);
    await openAssertion;
    resolveOpen?.({ receive: () => undefined, close: lateClose });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClose).toHaveBeenCalledOnce();
  });

  it("aborts in-flight opens and rejects new admissions during shutdown", async () => {
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    let resolveOpen: ((channel: { receive(): void; close(): void }) => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolvePromise) => { resolveStarted = resolvePromise; });
    const lateClose = vi.fn();
    const registry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => new Promise((resolvePromise) => {
        resolveOpen = resolvePromise;
        resolveStarted?.();
      }))],
      workspaces,
    });
    const request = {
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    };
    const opening = registry.openChannel(request, channelTransport().value);
    await started;

    const shuttingDown = registry.closeAll();
    await expect(opening).rejects.toMatchObject({ code: "shutdown", closeCode: 1012 });
    await shuttingDown;
    await expect(registry.openChannel(request, channelTransport().value)).rejects.toMatchObject({ code: "shutdown" });
    resolveOpen?.({ receive: () => undefined, close: lateClose });
    await vi.waitFor(() => { expect(lateClose).toHaveBeenCalledOnce(); });
  });

  it("expires channel lifetimes and releases admission after plugin cleanup", async () => {
    vi.useFakeTimers();
    const workspaces = providerRegistry([]);
    const workspaceId = (await workspaces.resolve(project)).workspaces[0]?.id;
    if (workspaceId === undefined) throw new Error("Expected folder workspace");
    const close = vi.fn();
    const transport = channelTransport();
    const registry = new PluginBackendRegistry({
      contributions: [channelContribution("terminal", () => ({ receive: () => undefined, close }))],
      workspaces,
      channelLifetimeMs: 50,
    });
    await registry.openChannel({
      pluginId: "terminal",
      moduleRevision: "terminal-r1",
      project,
      workspaceId,
      operation: "terminal.attach",
      input: null,
    }, transport.value);

    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => { expect(registry.activeChannelCount()).toBe(0); });
    expect(close).toHaveBeenCalledOnce();
    expect(transport.errors).toEqual([expect.objectContaining({ code: "lifetime-expired" })]);
    expect(transport.closes).toEqual([expect.objectContaining({ code: 1001 })]);
  });

  it("excludes unhealthy direct contributions while keeping degraded ones", () => {
    const contributions = [
      backendContribution("degraded", () => null),
      backendContribution("healthy", () => null),
      backendContribution("unhealthy", () => null),
    ];

    expect(eligiblePluginBackendContributions(contributions, [
      { pluginId: "degraded", health: { status: "degraded" } },
      { pluginId: "healthy", health: { status: "healthy" } },
      { pluginId: "unhealthy", health: { status: "unhealthy" } },
    ]).map(({ pluginId }) => pluginId)).toEqual(["degraded", "healthy"]);
  });
});

function providerRegistry(contributions: readonly ServerPluginProviderContribution[]): WorkspaceProviderRegistry {
  return new WorkspaceProviderRegistry({
    contributions,
    logger: { warn: vi.fn() },
    pathInspector: () => true,
  });
}

function providerContribution(pluginId: string, provider: WorkspaceProvider): ServerPluginProviderContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "fixture",
    scope: "local",
    moduleRevision: `${pluginId}-r1`,
    provider,
  };
}

function backendContribution(
  pluginId: string,
  request: ServerPluginPairedBackendContribution["backend"]["request"],
): ServerPluginPairedBackendContribution {
  return {
    pluginId,
    pluginName: pluginId,
    packageRoot: `/plugins/${pluginId}`,
    source: "fixture",
    scope: "local",
    moduleRevision: `${pluginId}-r1`,
    backend: Object.freeze({ version: 1, request }),
  };
}

function channelContribution(
  pluginId: string,
  openChannel: NonNullable<ServerPluginPairedBackendContribution["backend"]["openChannel"]>,
): ServerPluginPairedBackendContribution {
  return {
    ...backendContribution(pluginId, () => null),
    backend: Object.freeze({ version: 1, request: () => null, openChannel }),
  };
}

function channelTransport() {
  const sent: JsonValue[] = [];
  const errors: { code: string; message: string }[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    sent,
    errors,
    closes,
    value: {
      send: (data: JsonValue) => { sent.push(data); },
      sendError: (code: string, message: string) => { errors.push({ code, message }); },
      close: (code: number, reason: string) => { closes.push({ code, reason }); },
    },
  };
}
