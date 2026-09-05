import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue, WorkspaceBackend, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { InMemoryTerminalSelectionMemory } from "./terminalSelection";

afterEach(() => {
  vi.useRealTimers();
});

describe("Terminal browser runtime", () => {
  it("owns active-count refresh and badge state for each machine workspace", async () => {
    let now = 1_000;
    const request = vi.fn((operation: string): Promise<JsonValue> => Promise.resolve(operation === "terminal.list" ? [
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
    expect(request).toHaveBeenCalledWith("terminal.list", null, undefined);

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
    context.host.requestRender = () => { runtime.activeTerminalBadge(context); };

    await expect(runtime.refresh(context)).rejects.toThrow("offline");
    expect(runtime.activeTerminalBadge(context)).toBe("!");
    expect(request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2); });
    expect(runtime.activeTerminalBadge(context)).toBe(1);
  });

  it("keeps selection in plugin-owned memory and canonical contribution navigation", () => {
    const memory = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(memory);
    const set = vi.fn();
    const context = workspaceContext("local", vi.fn(), { set });

    runtime.selectTerminal(context, "terminal-2");

    expect(memory.latestTerminalId(runtime.selectionScope(context))).toBe("terminal-2");
    expect(set).toHaveBeenCalledWith("terminal", "terminal-2", undefined);
    expect(runtime.selectedTerminalId(context)).toBe("terminal-2");

    runtime.selectTerminal(context, undefined, { replace: true });
    expect(memory.latestTerminalId(runtime.selectionScope(context))).toBeUndefined();
    expect(set).toHaveBeenLastCalledWith("terminal", undefined, { replace: true });
  });

  it("separates authoritative runtime scope from legacy path-keyed selection", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const first = workspaceContext("local", vi.fn());
    const originalSecond = workspaceContext("local", vi.fn());
    const second: WorkspacePanelContext = {
      ...originalSecond,
      workspace: { ...originalSecond.workspace, id: "workspace-2", projectId: "project-2" },
    };

    expect(runtime.selectionScope(first)).toBe(runtime.selectionScope(second));
    expect(runtime.workspaceScope(first)).not.toBe(runtime.workspaceScope(second));
  });

  it("changes authoritative runtime scope when a workspace keeps its id but moves path", () => {
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const first = workspaceContext("local", vi.fn());
    const moved: WorkspacePanelContext = {
      ...first,
      workspace: { ...first.workspace, path: "/repo-moved" },
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

  it("fails closed when the required paired backend is absent", async () => {
    const runtime = new TerminalBrowserRuntime();
    const context = workspaceContext("local", vi.fn());
    Reflect.deleteProperty(context, "backend");

    await expect(runtime.refresh(context)).rejects.toThrow("Required Terminal paired backend is unavailable");
  });
});

function workspaceContext(
  machineId: string,
  request: WorkspaceBackend["request"],
  navigation: Partial<NonNullable<WorkspacePanelContext["navigation"]>> = {},
): WorkspacePanelContext {
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    backend: { capabilityVersion: 1, request },
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    navigation: {
      version: 1,
      contributionId: "terminal:workspace.terminal",
      query: navigation.query ?? {},
      set: navigation.set ?? vi.fn(),
    },
  };
}
