import { describe, expect, it, vi } from "vitest";
import type { JsonValue, WorkspaceBackend, WorkspaceBackendChannel } from "@jmfederico/pi-web/plugin-api";
import { TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES, TerminalBackendClient, parseTerminalCommandRun, parseTerminalServerFrame, terminalChannelFailureMessage, terminalInputFrames } from "./terminalProtocol";

const terminal = {
  id: "terminal-1",
  cwd: "/repo",
  name: "Shell",
  createdAt: "2026-08-01T00:00:00.000Z",
  exited: false,
};

const run = {
  id: "run-1",
  origin: "tasks",
  projectId: "project-1",
  workspaceId: "workspace-1",
  terminalId: "terminal-1",
  title: "Build",
  command: "npm run build",
  status: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
  metadata: { source: "task" },
};

describe("Terminal paired-backend protocol", () => {
  it("maps list/create/close/continue and command operations without host scope fields", async () => {
    const request = vi.fn<WorkspaceBackend["request"]>((operation: string): Promise<JsonValue> => {
      if (operation === "terminal.list") return Promise.resolve([terminal]);
      if (operation === "terminal.close") return Promise.resolve({ closed: true });
      if (operation === "terminal.get-run") return Promise.resolve(null);
      if (operation === "terminal.list-runs") return Promise.resolve([run]);
      if (operation === "terminal.create" || operation === "terminal.continue") return Promise.resolve(terminal);
      return Promise.resolve(run);
    });
    const client = new TerminalBackendClient({ capabilityVersion: 1, request });

    await expect(client.list()).resolves.toEqual([terminal]);
    await expect(client.create({ cols: 120, rows: 40 })).resolves.toEqual(terminal);
    await expect(client.close("terminal-1")).resolves.toBeUndefined();
    await expect(client.continue("terminal-1")).resolves.toEqual(terminal);
    await expect(client.runCommand("tasks", { title: "Build", command: "npm run build" })).resolves.toEqual(run);
    await expect(client.listCommandRuns({ statuses: ["running"] })).resolves.toEqual([run]);
    await expect(client.getCommandRun("missing")).resolves.toBeUndefined();
    await expect(client.cancelCommandRun("run-1")).resolves.toEqual(run);

    expect(request).toHaveBeenCalledWith("terminal.create", { cols: 120, rows: 40 }, undefined);
    expect(request).toHaveBeenCalledWith("terminal.run", {
      origin: "tasks",
      title: "Build",
      command: "npm run build",
      metadata: {},
    }, undefined);
    expect(JSON.stringify(request.mock.calls)).not.toContain("workspaceId");
  });

  it("opens the bounded attach channel and validates plugin-private frames", async () => {
    const channel: WorkspaceBackendChannel = {
      closed: Promise.resolve({ code: 1000, reason: "done", wasClean: true }),
      send: vi.fn(),
      close: vi.fn(),
    };
    const openChannel = vi.fn<NonNullable<WorkspaceBackend["openChannel"]>>((_operation, _input, options) => {
      options.onData({ type: "output", data: "hello", replay: true, replayComplete: true });
      return Promise.resolve(channel);
    });
    const frames: unknown[] = [];
    const client = new TerminalBackendClient({ capabilityVersion: 1, channelVersion: 1, request: vi.fn(), openChannel });

    await expect(client.attach({ terminalId: "terminal-1", size: { cols: 80, rows: 24 }, onFrame: (frame) => { frames.push(frame); } })).resolves.toBe(channel);

    const openCall = openChannel.mock.calls[0];
    expect(openCall?.slice(0, 2)).toEqual(["terminal.attach", { terminalId: "terminal-1", cols: 80, rows: 24 }]);
    expect(typeof openCall?.[2].onData).toBe("function");
    expect(frames).toEqual([{ type: "output", data: "hello", replay: true, replayComplete: true }]);
    expect(parseTerminalServerFrame({ type: "output", data: "live", replay: false })).toEqual({ type: "output", data: "live", replay: false });
    expect(parseTerminalServerFrame({ type: "exit", exitCode: 0 })).toEqual({ type: "exit", exitCode: 0 });
    expect(parseTerminalServerFrame({ type: "error", message: "pty failed" })).toEqual({ type: "error", message: "pty failed" });
    expect(() => parseTerminalServerFrame({ type: "output", data: "bad" })).toThrow("replay must be a boolean");
    expect(() => parseTerminalServerFrame({ type: "output", data: "bad", replay: true })).toThrow("replayComplete must be a boolean");
    expect(() => parseTerminalServerFrame({ type: "output", data: "bad", replay: false, replayComplete: true }))
      .toThrow("must not declare replay completion");
  });

  it("splits large Unicode input into ordered JSON-byte-safe channel frames", () => {
    const input = `${"paste😀\\\n".repeat(9_000)}${"\u0000".repeat(2_000)}tail`;
    const frames = terminalInputFrames(input);

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.map(({ data }) => data).join("")).toBe(input);
    for (const frame of frames) {
      expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(TERMINAL_CHANNEL_DATA_JSON_MAX_BYTES);
      const first = frame.data.charCodeAt(0);
      const last = frame.data.charCodeAt(frame.data.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("rejects malformed command records and attributes channel closure", () => {
    expect(() => parseTerminalCommandRun({ ...run, status: "done" })).toThrow("Invalid Terminal command run status");
    expect(() => parseTerminalCommandRun({ ...run, metadata: { source: 2 } })).toThrow("must be a string");
    expect(terminalChannelFailureMessage({ code: 1011, reason: "", wasClean: false, error: { code: "plugin-error", message: "failed" } }))
      .toBe("plugin-error: failed");
    expect(terminalChannelFailureMessage({ code: 1000, reason: "done", wasClean: true })).toBeUndefined();
  });

  it("fails closed when channels are not revision-paired by the host", async () => {
    const client = new TerminalBackendClient({ capabilityVersion: 1, request: vi.fn() });
    await expect(client.attach({ terminalId: "terminal-1", onFrame: vi.fn() }))
      .rejects.toThrow("Required Terminal paired channel v1 is unavailable");
  });
});
