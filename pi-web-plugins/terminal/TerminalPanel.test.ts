// @vitest-environment happy-dom

import type { JsonValue, WorkspaceBackend, WorkspaceBackendChannelOptions, WorkspacePanelContext, WorkspacePanelNavigationV1 } from "@jmfederico/pi-web/plugin-api";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalBrowserRuntime } from "./TerminalBrowserRuntime";
import { TerminalPanel, filterTerminalInput } from "./TerminalPanel";
import { TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES } from "./terminalProtocol";
import { InMemoryTerminalSelectionMemory } from "./terminalSelection";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Terminal panel lifecycle", () => {
  it("closes the paired channel and cancels retries, requests, observers, timers, and Xterm on disconnect", () => {
    vi.useFakeTimers();
    const panel = createTerminalPanel();
    const channelAbort = new AbortController();
    const loadAbort = new AbortController();
    const channel = { closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() };
    const reconnect = vi.fn();
    const resizeObserver = { disconnect: vi.fn() };
    const terminal = { dispose: vi.fn() };
    const commandPoll = window.setInterval(() => undefined, 1_000);
    const reconnectTimer = window.setTimeout(reconnect, 1_000);
    Reflect.set(panel, "channelAbort", channelAbort);
    Reflect.set(panel, "loadAbort", loadAbort);
    Reflect.set(panel, "channel", channel);
    Reflect.set(panel, "channelReconnectTimer", reconnectTimer);
    Reflect.set(panel, "commandRunPollTimer", commandPoll);
    Reflect.set(panel, "resizeObserver", resizeObserver);
    Reflect.set(panel, "terminal", terminal);

    document.body.append(panel);
    panel.remove();
    vi.advanceTimersByTime(2_000);

    expect(channelAbort.signal.aborted).toBe(true);
    expect(loadAbort.signal.aborted).toBe(true);
    expect(channel.close).toHaveBeenCalledWith("Terminal view disposed");
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("applies query-only history selection changes without an active-count change", () => {
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const firstContext = terminalContext({ navigation: terminalNavigation("terminal-1") });
    Reflect.set(panel, "context", firstContext);
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");
    Reflect.set(panel, "terminals", [terminalInfo("terminal-1"), terminalInfo("terminal-2")]);
    callPanelMethod(panel, "selectPreferredLoadedTerminal");
    expect(Reflect.get(panel, "selectedId")).toBe("terminal-1");
    expect(runtime.selection.latestTerminalId(runtime.selectionScope(firstContext))).toBe("terminal-1");

    callPanelMethod(panel, "selectTerminal", "terminal-2");
    callPanelMethod(panel, "willUpdate");
    expect(Reflect.get(panel, "selectedId")).toBe("terminal-2");

    Reflect.set(panel, "context", terminalContext({ navigation: terminalNavigation("terminal-2") }));
    callPanelMethod(panel, "willUpdate");

    expect(Reflect.get(panel, "selectedId")).toBe("terminal-2");
  });

  it("canonicalizes a queryless remembered selection before later history pushes", () => {
    const panel = createTerminalPanel();
    const memory = new InMemoryTerminalSelectionMemory();
    const runtime = new TerminalBrowserRuntime(memory);
    const setNavigation = vi.fn();
    const context = terminalContext({ navigation: { ...terminalNavigation(), set: setNavigation } });
    memory.rememberTerminal(runtime.selectionScope(context), "terminal-2");
    Reflect.set(panel, "context", context);
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");
    Reflect.set(panel, "terminals", [terminalInfo("terminal-1"), terminalInfo("terminal-2")]);

    callPanelMethod(panel, "selectPreferredLoadedTerminal", { replaceUrl: true });

    expect(Reflect.get(panel, "selectedId")).toBe("terminal-2");
    expect(setNavigation).toHaveBeenCalledWith("terminal", "terminal-2", { replace: true });
  });

  it("starts an empty panel only for an explicit one-shot open request", async () => {
    const passivePanel = createTerminalPanel();
    const passiveRequest = vi.fn((operation: string): Promise<JsonValue> => {
      void operation;
      return Promise.resolve([]);
    });
    Reflect.set(passivePanel, "context", terminalContext({ backend: terminalBackend(passiveRequest) }));
    Reflect.set(passivePanel, "runtime", new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory()));
    callPanelMethod(passivePanel, "willUpdate");

    await callAsyncPanelMethod(passivePanel, "loadTerminals");

    expect(passiveRequest.mock.calls.map(([operation]) => operation)).toEqual(["terminal.list", "terminal.list-runs"]);

    const explicitPanel = createTerminalPanel();
    const setNavigation = vi.fn();
    const explicitRequest = vi.fn((operation: string): Promise<JsonValue> =>
      Promise.resolve(operation === "terminal.create" ? terminalInfo("created-terminal") : []));
    Reflect.set(explicitPanel, "context", terminalContext({
      backend: terminalBackend(explicitRequest),
      navigation: { ...terminalNavigation(undefined, "open-1"), set: setNavigation },
    }));
    Reflect.set(explicitPanel, "runtime", new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory()));
    callPanelMethod(explicitPanel, "willUpdate");

    await callAsyncPanelMethod(explicitPanel, "loadTerminals");

    expect(explicitRequest.mock.calls.map(([operation]) => operation)).toEqual(["terminal.list", "terminal.list-runs", "terminal.create"]);
    expect(setNavigation).toHaveBeenCalledWith("start", undefined, { replace: true });
    expect(Reflect.get(explicitPanel, "selectedId")).toBe("created-terminal");
  });

  it("aborts and fences an in-flight create when authoritative workspace identity changes at the same path", async () => {
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const pendingCreate = deferred<JsonValue>();
    let createSignal: AbortSignal | undefined;
    const request = vi.fn((operation: string, _input: JsonValue, options?: { signal?: AbortSignal }): Promise<JsonValue> => {
      if (operation !== "terminal.create") return Promise.resolve([]);
      createSignal = options?.signal;
      return pendingCreate.promise;
    });
    const contextA = terminalContext({ backend: terminalBackend(request) });
    const setContextBNavigation = vi.fn();
    const contextB = terminalContext({
      workspace: { id: "workspace-2", projectId: "project-2", path: "/repo", label: "other", isMain: true },
      backend: terminalBackend(vi.fn(() => Promise.resolve([]))),
      navigation: { ...terminalNavigation(), set: setContextBNavigation },
    });
    Reflect.set(panel, "context", contextA);
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");

    const starting = callAsyncPanelMethod(panel, "startTerminal");
    await vi.waitFor(() => { expect(request).toHaveBeenCalledWith("terminal.create", expect.anything(), expect.anything()); });
    Reflect.set(panel, "context", contextB);
    callPanelMethod(panel, "willUpdate");

    expect(createSignal?.aborted).toBe(true);
    pendingCreate.resolve(terminalInfo("workspace-a-terminal"));
    await starting;
    expect(Reflect.get(panel, "terminals")).toEqual([]);
    expect(setContextBNavigation).not.toHaveBeenCalled();
  });

  it("tears down a live channel when a workspace keeps its id but moves path", () => {
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const context = terminalContext();
    Reflect.set(panel, "context", context);
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");

    const channelAbort = new AbortController();
    const channel = { closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() };
    const terminal = { dispose: vi.fn() };
    Reflect.set(panel, "channelAbort", channelAbort);
    Reflect.set(panel, "channel", channel);
    Reflect.set(panel, "terminal", terminal);
    const movedContext: WorkspacePanelContext = {
      ...context,
      workspace: { ...context.workspace, path: "/repo-moved" },
    };
    Reflect.set(panel, "context", movedContext);

    callPanelMethod(panel, "willUpdate");

    expect(channelAbort.signal.aborted).toBe(true);
    expect(channel.close).toHaveBeenCalledWith("Terminal view disposed");
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(Reflect.get(panel, "observedWorkspaceScope")).toBe(runtime.workspaceScope(movedContext));
  });

  it("backs off failed initial loads and remains retryable", async () => {
    vi.useFakeTimers();
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const request = vi.fn(() => Promise.reject(new Error("offline")));
    Reflect.set(panel, "context", terminalContext({ backend: terminalBackend(request) }));
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");
    Reflect.set(panel, "visible", true);

    await callAsyncPanelMethod(panel, "loadTerminals");
    expect(request).toHaveBeenCalledTimes(2);
    expect(Reflect.get(panel, "loadedWorkspaceScope")).toBeUndefined();
    expect(Reflect.get(panel, "consumedAutoStartRequest")).toBeUndefined();
    callPanelMethod(panel, "updated");
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(4);
    panel.disconnectedCallback();
  });

  it("does not rearm command polling when an in-flight refresh resolves after disconnect", async () => {
    vi.useFakeTimers();
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const pendingRuns = deferred<JsonValue>();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((_operation: string, _input: JsonValue, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal;
      return pendingRuns.promise;
    });
    Reflect.set(panel, "context", terminalContext({ backend: terminalBackend(request) }));
    Reflect.set(panel, "runtime", runtime);
    callPanelMethod(panel, "willUpdate");
    Reflect.set(panel, "commandRuns", [commandRun("running")]);

    const loading = callAsyncPanelMethod(panel, "loadCommandRuns");
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce(); });
    panel.disconnectedCallback();
    expect(requestSignal?.aborted).toBe(true);
    pendingRuns.resolve([commandRun("running")]);
    await loading;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(request).toHaveBeenCalledOnce();
    expect(Reflect.get(panel, "commandRunPollTimer")).toBeUndefined();
  });

  it("reloads after a normal close but retains output until an abnormal reconnect handshake succeeds", async () => {
    vi.useFakeTimers();
    const panel = createTerminalPanel();
    const terminal = { reset: vi.fn(), writeln: vi.fn(), dispose: vi.fn() };
    const reload = vi.fn(() => Promise.resolve());
    Reflect.set(panel, "visible", true);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "channelGeneration", 1);
    Reflect.set(panel, "context", terminalContext());
    Reflect.set(panel, "loadTerminals", reload);

    callPanelMethod(panel, "handleChannelClosed", 1, "terminal-1", terminal, { code: 1000, reason: "done", wasClean: true });
    await Promise.resolve();
    expect(reload).toHaveBeenCalledOnce();
    expect(terminal.reset).not.toHaveBeenCalled();

    callPanelMethod(panel, "handleChannelClosed", 1, "terminal-1", terminal, {
      code: 1011,
      reason: "Channel lifetime expired",
      wasClean: false,
      error: { code: "channel-lifetime", message: "Channel lifetime expired" },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.writeln).toHaveBeenCalledWith(expect.stringContaining("Channel lifetime expired"));
    panel.disconnectedCallback();
  });

  it("reattaches after a clean close when the authoritative terminal remains active", async () => {
    const panel = createTerminalPanel();
    const channel = { closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() };
    const openChannel = vi.fn(() => Promise.resolve(channel));
    const context = terminalContext({ backend: terminalBackend(vi.fn(() => Promise.resolve([])), openChannel) });
    const terminal = { reset: vi.fn(), write: vi.fn(), writeln: vi.fn(), dispose: vi.fn() };
    Reflect.set(panel, "context", context);
    Reflect.set(panel, "visible", true);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "terminals", [terminalInfo("terminal-1")]);
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "channelGeneration", 1);
    Reflect.set(panel, "loadTerminals", vi.fn(() => Promise.resolve()));

    callPanelMethod(panel, "handleChannelClosed", 1, "terminal-1", terminal, { code: 1000, reason: "done", wasClean: true });

    await vi.waitFor(() => { expect(openChannel).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => { expect(terminal.reset).toHaveBeenCalledOnce(); });
    panel.disconnectedCallback();
  });

  it("resets exactly once after a failed reconnect is replaced by a replaying channel", async () => {
    vi.useFakeTimers();
    const panel = createTerminalPanel();
    const channel = { closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() };
    let attempt = 0;
    const openChannel: NonNullable<WorkspaceBackend["openChannel"]> = vi.fn((operation: string, input: JsonValue, options: WorkspaceBackendChannelOptions) => {
      void operation;
      void input;
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("still offline"));
      options.onData({ type: "output", data: "replayed output", replay: true, replayComplete: true });
      return Promise.resolve(channel);
    });
    const context = terminalContext({ backend: terminalBackend(vi.fn(() => Promise.resolve([])), openChannel) });
    const terminal = { reset: vi.fn(), write: vi.fn(), writeln: vi.fn(), dispose: vi.fn() };
    Reflect.set(panel, "visible", true);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "channelGeneration", 1);
    Reflect.set(panel, "context", context);

    callPanelMethod(panel, "handleChannelClosed", 1, "terminal-1", terminal, {
      code: 1011,
      reason: "offline",
      wasClean: false,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(openChannel).toHaveBeenCalledOnce();
    expect(terminal.reset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => { expect(openChannel).toHaveBeenCalledTimes(2); });
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenCalledWith("replayed output", expect.any(Function));
    expect(terminal.reset.mock.invocationCallOrder[0]).toBeLessThan(terminal.write.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    panel.disconnectedCallback();
  });

  it("clears a stale connection error after a successful reattach", async () => {
    const panel = createTerminalPanel();
    const channel = { closed: new Promise<never>(() => undefined), send: vi.fn(), close: vi.fn() };
    const openChannel = vi.fn(() => Promise.resolve(channel));
    const context = terminalContext({ backend: terminalBackend(vi.fn(() => Promise.resolve([])), openChannel) });
    const terminal = { dispose: vi.fn() };
    Reflect.set(panel, "visible", true);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "connectionError", "Terminal connection closed: offline");

    callPanelMethod(panel, "connectChannel", context, "terminal-1", terminal, undefined);
    await vi.waitFor(() => { expect(openChannel).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => { expect(Reflect.get(panel, "connectionError")).toBeUndefined(); });
    panel.disconnectedCallback();
  });

  it("suppresses a complete multi-frame replay while allowing following live Xterm responses and input", async () => {
    const panel = createTerminalPanel();
    const terminal = new Terminal({ cols: 80, rows: 24 });
    const send = vi.fn();
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "channelGeneration", 7);
    Reflect.set(panel, "channel", { closed: new Promise<never>(() => undefined), send, close: vi.fn() });
    terminal.onData((data) => { callPanelMethod(panel, "handleTerminalData", terminal, data); });

    try {
      callPanelMethod(panel, "handleChannelFrame", 7, {
        type: "output",
        data: "first replay chunk",
        replay: true,
        replayComplete: false,
      }, "terminal-1", terminal);
      callPanelMethod(panel, "handleChannelFrame", 7, {
        type: "output",
        data: "\x1b[6n",
        replay: true,
        replayComplete: true,
      }, "terminal-1", terminal);
      callPanelMethod(panel, "handleChannelFrame", 7, {
        type: "output",
        data: "\x1b[6n",
        replay: false,
      }, "terminal-1", terminal);
      await new Promise<void>((resolve) => { terminal.write("", resolve); });

      const responseFrames: { type: "input"; data: string }[] = [];
      for (const call of send.mock.calls) {
        const frame: unknown = call[0];
        if (isInputFrame(frame)) responseFrames.push(frame);
      }
      expect(responseFrames).toHaveLength(1);
      const response = responseFrames[0]?.data ?? "";
      expect(response.startsWith("\x1b[")).toBe(true);
      expect(response.endsWith("R")).toBe(true);
      expect(response.slice(2, -1)).toMatch(/^\d+;\d+$/u);

      terminal.input("ordinary input", true);
      expect(send).toHaveBeenNthCalledWith(2, { type: "input", data: "ordinary input" });
    } finally {
      terminal.dispose();
    }
  });

  it("does not let a stale replay callback clear suppression for a replacement channel generation", () => {
    const panel = createTerminalPanel();
    const completions: (() => void)[] = [];
    const terminal = {
      write: vi.fn((_data: string, complete?: () => void) => { if (complete !== undefined) completions.push(complete); }),
    };
    const send = vi.fn();
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "channelGeneration", 1);
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "channel", { closed: new Promise<never>(() => undefined), send, close: vi.fn() });

    callPanelMethod(panel, "handleChannelFrame", 1, {
      type: "output",
      data: "old replay",
      replay: true,
      replayComplete: true,
    }, "terminal-1", terminal);
    Reflect.set(panel, "channelGeneration", 2);
    callPanelMethod(panel, "handleChannelFrame", 2, {
      type: "output",
      data: "replacement replay",
      replay: true,
      replayComplete: true,
    }, "terminal-1", terminal);

    completions[0]?.();
    callPanelMethod(panel, "handleTerminalData", terminal, "blocked while replaying");
    expect(send).not.toHaveBeenCalled();

    completions[1]?.();
    callPanelMethod(panel, "handleTerminalData", terminal, "ordinary input");
    expect(send).toHaveBeenCalledWith({ type: "input", data: "ordinary input" });
  });

  it("handles output, exit, and error frames and wires input plus resize frames", () => {
    const panel = createTerminalPanel();
    const runtime = new TerminalBrowserRuntime(new InMemoryTerminalSelectionMemory());
    const context = terminalContext();
    const terminal = { write: vi.fn(), writeln: vi.fn(), dispose: vi.fn() };
    const loadCommandRuns = vi.fn();
    Reflect.set(panel, "context", context);
    Reflect.set(panel, "runtime", runtime);
    Reflect.set(panel, "selectedId", "terminal-1");
    Reflect.set(panel, "terminals", [terminalInfo("terminal-1")]);
    Reflect.set(panel, "terminal", terminal);
    Reflect.set(panel, "loadCommandRuns", loadCommandRuns);

    callPanelMethod(panel, "handleChannelFrame", 0, { type: "output", data: "hello", replay: false }, "terminal-1", terminal);
    callPanelMethod(panel, "handleChannelFrame", 0, { type: "error", message: "pty failed" }, "terminal-1", terminal);
    callPanelMethod(panel, "handleChannelFrame", 0, { type: "exit", exitCode: 7 }, "terminal-1", terminal);

    expect(terminal.write).toHaveBeenCalledWith("hello");
    expect(terminal.writeln).toHaveBeenCalledWith(expect.stringContaining("pty failed"));
    expect(terminal.writeln).toHaveBeenCalledWith(expect.stringContaining("code 7"));
    expect(Reflect.get(panel, "terminals")).toEqual([expect.objectContaining({ id: "terminal-1", exited: true, exitCode: 7 })]);
    expect(loadCommandRuns).toHaveBeenCalledOnce();

    const send = vi.fn();
    Reflect.set(panel, "channel", { closed: new Promise<never>(() => undefined), send, close: vi.fn() });
    callPanelMethod(panel, "sendTerminalInput", `before\x1b[Iafter\r`);
    Reflect.set(panel, "fitAddon", { proposeDimensions: () => ({ cols: 80.9, rows: 24.8 }), fit: vi.fn() });
    callPanelMethod(panel, "fitAndNotify");
    expect(send).toHaveBeenNthCalledWith(1, { type: "input", data: "beforeafter\r" });
    expect(send).toHaveBeenNthCalledWith(2, { type: "resize", cols: 80, rows: 24 });

    const largePaste = `${"λ😀".repeat(24_000)}${"\u0000".repeat(4_000)}done`;
    callPanelMethod(panel, "sendTerminalInput", largePaste);
    const pasteFrames: unknown[] = [];
    for (const call of send.mock.calls.slice(2)) {
      const frame: unknown = call[0];
      pasteFrames.push(frame);
    }
    expect(pasteFrames.length).toBeGreaterThan(1);
    expect(pasteFrames.map((frame) => {
      if (!isInputFrame(frame)) throw new Error("Expected Terminal input frame");
      expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES);
      return frame.data;
    }).join("")).toBe(largePaste);
  });

  it("filters Xterm focus-reporting bytes without changing ordinary input", () => {
    expect(filterTerminalInput(`before\x1b[Iafter\x1b[O`)).toBe("beforeafter");
    expect(filterTerminalInput("npm test\r")).toBe("npm test\r");
  });
});

function isInputFrame(value: unknown): value is { type: "input"; data: string } {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === "input" && typeof Reflect.get(value, "data") === "string";
}

function createTerminalPanel(): TerminalPanel {
  if (customElements.get("test-terminal-panel") === undefined) customElements.define("test-terminal-panel", TerminalPanel);
  const element = document.createElement("test-terminal-panel");
  if (!(element instanceof TerminalPanel)) throw new Error("Expected TerminalPanel test element");
  return element;
}

function terminalContext(overrides: Partial<WorkspacePanelContext> = {}): WorkspacePanelContext {
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "workspace-1", projectId: "project-1", path: "/repo", label: "main", isMain: true },
    files: { readFile: vi.fn(), listFiles: vi.fn(), writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn() },
    backend: terminalBackend(
      vi.fn(() => Promise.resolve([])),
      vi.fn(() => new Promise<never>(() => undefined)),
    ),
    host: { requestRender: vi.fn() },
    prompt: { insertText: vi.fn(), getText: vi.fn(() => ""), getSelection: vi.fn(() => null) },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
    navigation: terminalNavigation(),
    ...overrides,
  };
}

function terminalBackend(
  request: WorkspaceBackend["request"],
  openChannel?: NonNullable<WorkspaceBackend["openChannel"]>,
): WorkspaceBackend {
  return {
    capabilityVersion: 1,
    request,
    ...(openChannel === undefined ? {} : { channelVersion: 1 as const, openChannel }),
  };
}

function terminalNavigation(terminalId?: string, autoStartRequest?: string): WorkspacePanelNavigationV1 {
  return {
    version: 1,
    contributionId: "terminal:workspace.terminal",
    query: {
      ...(terminalId === undefined ? {} : { terminal: terminalId }),
      ...(autoStartRequest === undefined ? {} : { start: autoStartRequest }),
    },
    set: vi.fn(),
  };
}

function terminalInfo(id: string): JsonValue & { id: string; cwd: string; name: string; createdAt: string; exited: boolean } {
  return { id, cwd: "/repo", name: id, createdAt: "now", exited: false };
}

function commandRun(status: "running" | "succeeded"): JsonValue & { status: "running" | "succeeded" } {
  return {
    id: "run-1",
    origin: "test",
    projectId: "project-1",
    workspaceId: "workspace-1",
    terminalId: "terminal-1",
    title: "Test",
    command: "true",
    status,
    createdAt: "now",
    metadata: {},
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function callPanelMethod(panel: TerminalPanel, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(panel, name);
  if (typeof method !== "function") throw new Error(`TerminalPanel.${name} is unavailable`);
  return Reflect.apply(method, panel, args);
}

async function callAsyncPanelMethod(panel: TerminalPanel, name: string, ...args: unknown[]): Promise<void> {
  await callPanelMethod(panel, name, ...args);
}
