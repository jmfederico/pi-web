import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, PluginPeer, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { TerminalContext, WorkspaceTerminalBinding } from "./TerminalContext";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { InMemoryTerminalSelectionMemory, SessionStorageTerminalSelectionMemory, maintenanceTerminalSelectionScope } from "./terminalSelection";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Terminal browser runtime", () => {
  it("isolates maintenance identity and selection from workspaces and other machines", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const workspace = workspaceContext("remote-1", vi.fn());
    const maintenance = { machine: workspace.machine, host: workspace.host };
    const otherMachine = { ...maintenance, machine: { ...maintenance.machine, id: "remote-2" } };
    runtime.selectTerminal(workspace, "workspace-shell");
    runtime.selectTerminal(maintenance, "maintenance-shell");
    expect(runtime.workspaceScope(maintenance)).not.toBe(runtime.workspaceScope(workspace));
    expect(runtime.selectedTerminalId(maintenance)).toBe("maintenance-shell");
    expect(runtime.selectedTerminalId(workspace)).toBe("workspace-shell");
    expect(runtime.selectedTerminalId(otherMachine)).toBeUndefined();
    expect(runtime.routedTerminalId(maintenance)).toBeUndefined();
    runtime.dispose();
  });

  it("restores remembered maintenance selection from session storage", () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    };
    const runtime = new TerminalBrowserRuntime(new SessionStorageTerminalSelectionMemory(storage));
    const workspace = workspaceContext("remote-1", vi.fn());
    const maintenance = { machine: workspace.machine, host: workspace.host };
    new SessionStorageTerminalSelectionMemory(storage).rememberTerminal(maintenanceTerminalSelectionScope("remote-1"), "command-terminal");
    expect(runtime.selectedTerminalId(maintenance)).toBe("command-terminal");
    runtime.dispose();
  });

  it("lists and counts workspace plus maintenance terminals without mixing peers", async () => {
    const workspaceRequest = vi.fn((): Promise<JsonValue> => Promise.resolve([
      { id: "workspace", scope: "workspace", projectId: "project-1", workspaceId: "workspace-1", cwd: "/repo", name: "Shell", createdAt: "now", exited: false },
    ]));
    const maintenanceRequest = vi.fn((): Promise<JsonValue> => Promise.resolve([
      { id: "maintenance", scope: "maintenance", cwd: "/maintenance", name: "Update", createdAt: "now", exited: false },
    ]));
    const context = { ...workspaceContext("remote-1", workspaceRequest), maintenance: { scope: "maintenance" as const, peer: { request: maintenanceRequest } } };
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    expect((await runtime.listTerminals(context)).map(({ id, scope }) => [id, scope])).toEqual([
      ["workspace", "workspace"], ["maintenance", "maintenance"],
    ]);
    await runtime.refresh(context);
    expect(runtime.activeTerminalBadge(context)).toBe(2);
    const machineContext = { machine: context.machine, host: context.host, maintenance: context.maintenance };
    expect((await runtime.listTerminals(machineContext)).map(({ id }) => id)).toEqual(["maintenance"]);
    expect(workspaceRequest).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });

  it("keeps a selected maintenance terminal across workspace switches until a workspace selection wins", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const workspace = workspaceContext("remote-1", vi.fn());
    const first = { ...workspace, maintenance: { scope: "maintenance" as const, peer: { request: vi.fn() } } };
    runtime.selectTerminal(first, "maintenance", { scope: "maintenance" });
    const second = { ...first, workspace: { ...first.workspace, workspace: { ...first.workspace.workspace, id: "other", path: "/other" } } };
    expect(runtime.selectedTerminalId(second)).toBe("maintenance");
    runtime.selectTerminal(second, "workspace", { scope: "workspace" });
    expect(runtime.selectedTerminalId(second)).toBe("workspace");
    expect(runtime.selectedTerminalId({ ...second, machine: { ...second.machine, id: "other-machine" } })).toBeUndefined();
    runtime.dispose();
  });

  it("prioritizes an explicit facade maintenance open over a routed workspace selection until accepted", () => {
    const selection = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(selection);
    const workspace = workspaceContext("remote-1", vi.fn());
    const context = { ...workspace, maintenance: { scope: "maintenance" as const, peer: { request: vi.fn() } }, workspace: { ...workspace.workspace, navigation: { version: 1 as const, contributionId: "terminal", query: { terminal: "workspace" }, set: vi.fn() } } };
    runtime.requestMaintenanceTerminal(context.machine.id, "maintenance");
    expect(runtime.selectedTerminalId(context)).toBe("maintenance");
    expect(runtime.selectedTerminalId(context)).toBe("maintenance");
    runtime.selectTerminal(context, "maintenance", { scope: "maintenance" });
    expect(runtime.selectedTerminalId(context)).toBe("maintenance");
    runtime.dispose();
  });

  it("rejects a maintenance item returned through workspace authority", async () => {
    const context = workspaceContext("remote-1", vi.fn((): Promise<JsonValue> => Promise.resolve([
      { id: "maintenance", scope: "maintenance", cwd: "/maintenance", name: "Update", createdAt: "now", exited: false },
    ])));
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    await expect(runtime.listTerminals(context)).rejects.toThrow("scope does not match workspace binding");
    runtime.dispose();
  });

  it("owns active-count refresh and badge state for each machine workspace", async () => {
    let now = 1_000;
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((operation: string): Promise<JsonValue> => Promise.resolve(operation === "terminal.list" ? [
      { id: "active", cwd: "/repo", name: "Shell", createdAt: "now", exited: false },
      { id: "exited", cwd: "/repo", name: "Build", createdAt: "now", exited: true, exitCode: 0 },
    ] : []));
    const context = workspaceContext("remote-1", request);
    let renderRequests = 0;
    context.host.requestRender = () => { renderRequests += 1; };
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory(), () => now);

    expect(runtime.activeTerminalBadge(context)).toBeUndefined();
    await vi.waitFor(() => { expect(renderRequests).toBe(1); });
    expect(runtime.activeTerminalBadge(context)).toBe(1);
    expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["terminal.list", null]);
    expect(request.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);

    now += 999;
    expect(runtime.activeTerminalBadge(context)).toBe(1);
    expect(request).toHaveBeenCalledOnce();
    now += 1;
    runtime.activeTerminalBadge(context);
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2); });
  });

  it("backs off badge refresh failures instead of retrying on every render", async () => {
    let now = 1_000;
    const request = vi.fn(() => Promise.reject(new Error("offline")));
    const context = workspaceContext("remote-1", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory(), () => now);

    runtime.activeTerminalBadge(context);
    await expect(runtime.refresh(context)).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledOnce();
    runtime.activeTerminalBadge(context);
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();

    now += 5_000;
    runtime.activeTerminalBadge(context);
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2); });
  });

  it("schedules failed badge recovery without a caller manually reinvoking the badge", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const request = vi.fn((): Promise<JsonValue> => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve([{ id: "active", cwd: "/repo", name: "Shell", createdAt: "now", exited: false }]);
    });
    const context = workspaceContext("remote-1", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());

    await expect(runtime.refresh(context)).rejects.toThrow("offline");
    expect(runtime.activeTerminalBadge(context)).toBe("!");
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2); });
    expect(runtime.activeTerminalBadge(context)).toBe(1);
  });

  it("cancels in-flight refreshes and scheduled badge work when disposed", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn<NonNullable<PluginPeer["request"]>>((_operation, _input, options): Promise<JsonValue> => new Promise((_resolve, reject) => {
      const signal = options?.signal;
      requestSignal = signal;
      signal?.addEventListener("abort", () => {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error("Terminal refresh aborted"));
      }, { once: true });
    }));
    const timer = globalThis.setTimeout(() => undefined, 60_000);
    const setTimer = vi.fn((handler: () => void, timeout: number) => {
      void handler;
      void timeout;
      return timer;
    });
    const clearTimer = vi.fn((id: ReturnType<typeof globalThis.setTimeout>) => { globalThis.clearTimeout(id); });
    const context = workspaceContext("remote-1", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory(), () => 1_000, setTimer, clearTimer);
    runtime.activeTerminalBadge(context);
    const refresh = runtime.refresh(context);
    runtime.updateTerminals(context, [{ id: "active", cwd: "/repo", name: "Shell", createdAt: "now", exited: false }]);

    expect(setTimer).toHaveBeenCalledOnce();
    runtime.dispose();

    expect(requestSignal?.aborted).toBe(true);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.activeTerminalBadge(context)).toBeUndefined();
    await expect(runtime.refresh(context)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("polls directly without rendering unchanged counts, including recovery from an error", async () => {
    const request = vi.fn<NonNullable<PluginPeer["request"]>>().mockResolvedValue([]);
    const context = workspaceContext("local", request);
    const requestRender = vi.fn();
    context.host.requestRender = requestRender;
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    runtime.activeTerminalBadge(context);
    await runtime.refresh(context);
    requestRender.mockClear();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(requestRender).not.toHaveBeenCalled();

    request.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.activeTerminalBadge(context)).toBe("!");
    expect(requestRender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestRender).toHaveBeenCalledTimes(1);

    request.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(runtime.activeTerminalBadge(context)).toBeUndefined();
  });

  it("preserves failure backoff when a hidden badge is read before becoming visible", async () => {
    const visibility = { hidden: false };
    vi.stubGlobal("document", visibility);
    const request = vi.fn(() => Promise.reject(new Error("offline")));
    const context = workspaceContext("local", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    runtime.activeTerminalBadge(context);
    await expect(runtime.refresh(context)).rejects.toThrow("offline");
    visibility.hidden = true;
    runtime.activeTerminalBadge(context);
    visibility.hidden = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not start polling from passive updates or refreshes", async () => {
    const request = vi.fn((): Promise<JsonValue> => Promise.resolve([]));
    const context = workspaceContext("local", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    await runtime.refresh(context);
    runtime.updateTerminals(context, []);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("does not rearm a stale workspace after in-flight %s", async (outcome) => {
    let complete!: (value: JsonValue) => void;
    let fail!: (error: Error) => void;
    const oldRequest = vi.fn(() => new Promise<JsonValue>((resolve, reject) => { complete = resolve; fail = reject; }));
    const nextRequest = vi.fn((): Promise<JsonValue> => Promise.resolve([]));
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    runtime.activeTerminalBadge(workspaceContext("local", oldRequest));
    runtime.activeTerminalBadge(workspaceContext("remote", nextRequest));
    if (outcome === "success") complete([]);
    else fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(oldRequest).toHaveBeenCalledOnce();
    expect(nextRequest).toHaveBeenCalledTimes(4);
    runtime.dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(nextRequest).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure"])("ignores late in-flight %s after permanent disposal", async (outcome) => {
    let complete!: (value: JsonValue) => void;
    let fail!: (error: Error) => void;
    const request = vi.fn<NonNullable<PluginPeer["request"]>>(() => new Promise<JsonValue>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    }));
    const context = workspaceContext("local", request);
    const requestRender = vi.fn();
    context.host.requestRender = requestRender;
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    runtime.activeTerminalBadge(context);
    const invalidation = runtime.invalidate(context);
    const settled = outcome === "failure"
      ? expect(invalidation).rejects.toThrow("offline")
      : expect(invalidation).resolves.toBeUndefined();

    runtime.dispose();
    runtime.dispose();
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    if (outcome === "success") complete([]);
    else fail(new Error("offline"));
    await settled;
    runtime.updateTerminals(context, []);
    expect(runtime.activeTerminalBadge(context)).toBeUndefined();
    await expect(runtime.refresh(context)).rejects.toMatchObject({ name: "AbortError" });
    await expect(runtime.invalidate(context)).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses requests while hidden and stops a retained activation after navigation", async () => {
    const location = { href: "https://example.test/?workspace=first" };
    const visibility = { hidden: false };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("document", visibility);
    const request = vi.fn((): Promise<JsonValue> => Promise.resolve([]));
    const context = workspaceContext("local", request);
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    runtime.activeTerminalBadge(context);
    await runtime.refresh(context);
    visibility.hidden = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request).toHaveBeenCalledOnce();
    visibility.hidden = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    location.href = "https://example.test/?workspace=second";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    runtime.activeTerminalBadge(context);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps selection in plugin-owned memory and publishes canonical navigation first", () => {
    const memory = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(memory);
    const rememberedAtPublication: (string | undefined)[] = [];
    const set = vi.fn();
    const context = workspaceContext("local", vi.fn(), { set });
    set.mockImplementation(() => { rememberedAtPublication.push(memory.latestTerminalId(runtime.selectionScope(context))); });

    runtime.selectTerminal(context, "terminal-2");

    expect(rememberedAtPublication).toEqual([undefined]);
    expect(memory.latestTerminalId(runtime.selectionScope(context))).toBe("terminal-2");
    expect(set).toHaveBeenCalledWith("terminal", "terminal-2", undefined);
    expect(runtime.selectedTerminalId(context)).toBe("terminal-2");

    runtime.selectTerminal(context, undefined, { replace: true });
    expect(rememberedAtPublication).toEqual([undefined, "terminal-2"]);
    expect(memory.latestTerminalId(runtime.selectionScope(context))).toBeUndefined();
    expect(set).toHaveBeenLastCalledWith("terminal", undefined, { replace: true });
  });

  it("does not update plugin selection when the host rejects stale navigation", () => {
    const memory = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(memory);
    const requestRender = vi.fn();
    const context = workspaceContext("local", vi.fn(), { set: vi.fn(() => false) });
    context.host.requestRender = requestRender;
    memory.rememberTerminal(runtime.selectionScope(context), "terminal-old");

    expect(runtime.selectTerminal(context, "terminal-stale")).toBe(false);

    expect(memory.latestTerminalId(runtime.selectionScope(context))).toBe("terminal-old");
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("separates authoritative runtime scope from legacy path-keyed selection", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const first = workspaceContext("local", vi.fn());
    const originalSecond = workspaceContext("local", vi.fn());
    const second: TerminalContext = {
      ...originalSecond,
      workspace: { ...originalSecond.workspace, workspace: { ...originalSecond.workspace.workspace, id: "workspace-2", projectId: "project-2" } },
    };

    expect(runtime.selectionScope(first)).toBe(runtime.selectionScope(second));
    expect(runtime.workspaceScope(first)).not.toBe(runtime.workspaceScope(second));
  });

  it("changes authoritative runtime scope when a workspace keeps its id but moves path", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const first = workspaceContext("local", vi.fn());
    const moved: TerminalContext = {
      ...first,
      workspace: { ...first.workspace, workspace: { ...first.workspace.workspace, path: "/repo-moved" } },
    };

    expect(runtime.workspaceScope(first)).not.toBe(runtime.workspaceScope(moved));
  });

  it("requests a render after invalidation when the badge count is unchanged", async () => {
    const request = vi.fn((): Promise<JsonValue> => Promise.resolve([
      { id: "active", cwd: "/repo", name: "Shell", createdAt: "now", exited: false },
    ]));
    const context = workspaceContext("local", request);
    const requestRender = vi.fn();
    context.host.requestRender = requestRender;
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());

    await runtime.refresh(context);
    const rendersAfterRefresh = requestRender.mock.calls.length;
    await runtime.invalidate(context);

    expect(requestRender).toHaveBeenCalledTimes(rendersAfterRefresh + 1);
  });

  it("prefers restored aliased navigation over remembered selection", () => {
    const memory = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(memory);
    const context = workspaceContext("remote-1", vi.fn(), { query: { terminal: "deep-link" } });
    memory.rememberTerminal(runtime.selectionScope(context), "remembered");

    expect(runtime.selectedTerminalId(context)).toBe("deep-link");
  });

  it("fails closed when the required peer is absent", async () => {
    const runtime = new TerminalBrowserRuntime();
    const context = workspaceContext("local", vi.fn());
    Reflect.deleteProperty(context, "workspace");

    await expect(runtime.refresh(context)).rejects.toThrow("Required Terminal peer is unavailable");
  });
});

function workspaceContext(
  machineId: string,
  request: NonNullable<PluginPeer["request"]>,
  navigation: Partial<NonNullable<WorkspacePanelContext["navigation"]>> = {},
): TerminalContext & { workspace: WorkspaceTerminalBinding } {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    host: { requestRender: vi.fn() },
    workspace: {
      scope: "workspace",
      workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
      peer: { request },
      navigation: {
        version: 1,
        contributionId: "pi-web.terminal:workspace.terminal",
        query: navigation.query ?? {},
        set: navigation.set ?? vi.fn(),
      },
    },
  };
}
