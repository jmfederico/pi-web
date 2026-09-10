import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeOmpTransport, encodeTestRpcChunks, type FakeOmpTransport } from "./fakeOmpChildProcess.testSupport.js";
// `dependencies.spawn` is a test-only injection seam beyond the shared
// `OmpRpcClient` contract's literal constructor signature.
import { OmpRpcClient, type OmpRpcClientOptions } from "./ompRpcClient.js";

const AGENT_DIR = "/tmp/omp-agent-dir";
const CWD = "/workspace/project";

function client(transport: FakeOmpTransport, overrides: Partial<OmpRpcClientOptions> = {}): OmpRpcClient {
  return new OmpRpcClient({
    cwd: CWD,
    agentDir: AGENT_DIR,
    dependencies: { spawn: transport.spawn },
    ...overrides,
  });
}

/** Lets already-queued microtasks/macrotasks (stream 'data' events, decoder callbacks) settle before asserting. `Promise.withResolvers` is ES2024; this project's tsconfig lib target is ES2022. */
function flushMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// Defense in depth, not the primary fix: every fake-timer test restores
// real timers itself in a `finally`. This only guards against a bypassed
// `finally` (e.g. a hard test-runner timeout) leaking a fake clock into
// unrelated later tests in this file.
afterEach(() => {
  vi.useRealTimers();
});

describe("OmpRpcClient startup and argv", () => {
  it("spawns the default omp command with rpc-ui argv as a plain array, never a shell string", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    expect(transport.spawnCalls).toHaveLength(1);
    const call = transport.spawnCalls[0];
    expect(call?.command).toBe("omp");
    expect(call?.args).toEqual(["--mode", "rpc-ui", "--cwd", CWD]);
    expect(call?.options.stdio).toBeDefined();
    expect(Reflect.get(call?.options ?? {}, "shell")).toBeUndefined();
    await proc.close();
  });

  it("uses an overridden command and appends --resume for a sessionFile", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport, { command: "/opt/omp/bin/omp", sessionFile: "/agent/sessions/proj/abc.jsonl" });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const call = transport.spawnCalls[0];
    expect(call?.command).toBe("/opt/omp/bin/omp");
    expect(call?.args).toEqual(["--mode", "rpc-ui", "--cwd", CWD, "--resume", "/agent/sessions/proj/abc.jsonl"]);
    await proc.close();
  });

  it("passes a cwd containing shell metacharacters through as one literal argv element", async () => {
    const dangerousCwd = "/workspace/a b; rm -rf /tmp/x && echo pwned";
    const transport = createFakeOmpTransport();
    const proc = client(transport, { cwd: dangerousCwd });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const call = transport.spawnCalls[0];
    expect(call?.args).toEqual(["--mode", "rpc-ui", "--cwd", dangerousCwd]);
    await proc.close();
  });

  it("rejects start() with the child's stderr tail when it exits before advertising readiness", async () => {
    // Mirrors a real observed failure: an isolated agentDir with no model
    // credentials makes omp exit before emitting `ready`, printing
    // "No models available" on stderr. The rejection must carry that context
    // instead of a bare "process exited" message.
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    const started = proc.start();
    transport.child.stderr.write("No models available\n");
    await flushMicrotasks();
    transport.child.emitExit(1, null);
    await expect(started).rejects.toThrow(/No models available/);
  });

  it("bounds the captured stderr tail instead of growing without limit", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    const started = proc.start();
    for (let index = 0; index < 20; index++) transport.child.stderr.write("x".repeat(4096));
    transport.child.stderr.write("FINAL-MARKER");
    await flushMicrotasks();
    transport.child.emitExit(1, null);

    const failure = await started.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("FINAL-MARKER");
    expect(message.length).toBeLessThan(20_000);
  });
});

describe("OmpRpcClient environment isolation", () => {
  const originalEnv = { ...process.env };
  // Beyond the profile/session-dir names in RUNTIME_IDENTITY_ENV_KEYS below, the
  // installed OMP package (@oh-my-pi/pi-coding-agent) defines
  // MANAGED_KERNEL_ENV_KEYS for its own eval/bash tool-bridge identity
  // (src/eval/executor-base.ts). A pi-web sessiond process started from
  // inside a running Pi/OMP session (a real, reproducible nesting scenario)
  // inherits these on its own process.env; left unscrubbed they would point
  // a freshly-spawned OMP child at the PARENT session's tool bridge/session
  // file instead of its own.
  const RUNTIME_IDENTITY_ENV_KEYS = [
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_WEB_AGENT_SESSION_DIR",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_SESSION_FILE",
    "PI_ARTIFACTS_DIR",
    "PI_TOOL_BRIDGE_URL",
    "PI_TOOL_BRIDGE_TOKEN",
    "PI_TOOL_BRIDGE_SESSION",
    "PI_EVAL_LOCAL_ROOTS",
  ] as const;

  beforeEach(() => {
    process.env["PI_CODING_AGENT_DIR"] = "/home/user/.pi/agent";
    for (const key of RUNTIME_IDENTITY_ENV_KEYS) process.env[key] = `inherited-${key}`;
    process.env["ANTHROPIC_API_KEY"] = "sk-unrelated-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("overrides the inherited PI_CODING_AGENT_DIR with the client's own agentDir", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport, { agentDir: "/omp/agent/state" });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    expect(transport.spawnCalls[0]?.options.env["PI_CODING_AGENT_DIR"]).toBe("/omp/agent/state");
    await proc.close();
  });

  it("strips every inherited Pi/OMP runtime-identity variable not explicitly requested", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const env: NodeJS.ProcessEnv = transport.spawnCalls[0]?.options.env ?? {};
    for (const key of RUNTIME_IDENTITY_ENV_KEYS) expect(env[key]).toBeUndefined();
    // Unrelated inherited variables (e.g. provider credentials) still pass through.
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-unrelated-secret");
    await proc.close();
  });

  it("keeps an explicitly requested profile/session-dir variable when the caller sets it on purpose", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport, { env: { OMP_PROFILE: "intentional-profile" } });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    expect(transport.spawnCalls[0]?.options.env["OMP_PROFILE"]).toBe("intentional-profile");
    await proc.close();
  });
});

describe("OmpRpcClient bounded startup", () => {
  it("rejects start() and attempts cleanup when the child stays alive but never advertises readiness", async () => {
    vi.useFakeTimers();
    try {
      const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
      const proc = client(transport);
      // Attach the rejection expectation before the timer fires: the
      // timeout settles started's promise synchronously within the fake-
      // timer advance below, before this test's own next statement runs,
      // so a handler must already be registered or Node reports it as an
      // unhandled rejection even though the test does observe it moments later.
      const startFailure = expect(proc.start()).rejects.toThrow();
      // No sendReady() -- the child just sits there.
      await vi.advanceTimersByTimeAsync(120_000);
      await startFailure;
      expect(transport.child.stdin.writableEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects start() and attempts cleanup when protocol v2 negotiation never answers", async () => {
    vi.useFakeTimers();
    try {
      const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
      const proc = client(transport);
      const startFailure = expect(proc.start()).rejects.toThrow();
      transport.sendReady({ supportedProtocolVersions: [1, 2] });
      // Never respond to the negotiate_protocol command the client sends.
      await vi.advanceTimersByTimeAsync(120_000);
      await startFailure;
      expect(transport.child.stdin.writableEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OmpRpcClient protocol negotiation", () => {
  it("negotiates protocol v2 during start() when the ready frame advertises it", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.onCommand = (command) => {
      if (command["type"] === "negotiate_protocol") {
        transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      }
    };
    transport.sendReady({ supportedProtocolVersions: [1, 2] });
    await proc.start();

    expect(transport.commands.some((command) => command["type"] === "negotiate_protocol")).toBe(true);
    await proc.close();
  });

  it("skips negotiation when the ready frame only advertises v1", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    expect(transport.commands.some((command) => command["type"] === "negotiate_protocol")).toBe(false);
    await proc.close();
  });

  it("rejects start() when the server refuses v2 negotiation", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.onCommand = (command) => {
      if (command["type"] === "negotiate_protocol") {
        transport.respondTo(command, { success: false, error: "protocol v2 unsupported" });
      }
    };
    transport.sendReady({ supportedProtocolVersions: [1, 2] });
    await expect(proc.start()).rejects.toThrow();
  });
});

describe("OmpRpcClient request correlation", () => {
  it("resolves concurrent requests independently of response arrival order", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const first = proc.request({ type: "first" });
    const second = proc.request({ type: "second" });
    while (transport.commands.length < 2) {
      await flushMicrotasks();
    }
    const [firstCommand, secondCommand] = transport.commands.slice(-2);
    if (!firstCommand || !secondCommand) throw new Error("expected two recorded commands");
    transport.respondTo(secondCommand, { success: true, data: "second-data" });
    transport.respondTo(firstCommand, { success: true, data: "first-data" });

    await expect(first).resolves.toBe("first-data");
    await expect(second).resolves.toBe("second-data");
    await proc.close();
  });

  it("resolves with the unwrapped data payload, not the response envelope", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.onCommand = (command) => {
      if (command["type"] === "get_state") transport.respondTo(command, { success: true, data: { sessionId: "abc" } });
    };
    await expect(proc.request({ type: "get_state" })).resolves.toEqual({ sessionId: "abc" });
    await proc.close();
  });

  it("rejects with the server's error message and code on a failed response", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.onCommand = (command) => {
      if (command["type"] === "set_model") transport.respondTo(command, { success: false, error: "Model not found: x/y", code: "model_not_found" });
    };
    const request = proc.request({ type: "set_model", provider: "x", modelId: "y" });
    await expect(request).rejects.toThrow("Model not found: x/y");
    await expect(request).rejects.toMatchObject({ code: "model_not_found" });
    await proc.close();
  });

  it("writes exactly one JSONL command line per request, merging a unique id into the caller's fields", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.onCommand = (command) => {
      transport.respondTo(command, { success: true, data: null });
    };
    await proc.request({ type: "set_todos", phases: [] });

    const sent = transport.commands.find((command) => command["type"] === "set_todos");
    expect(sent).toMatchObject({ type: "set_todos", phases: [] });
    expect(typeof sent?.["id"]).toBe("string");
    await proc.close();
  });
});

describe("OmpRpcClient response correlation edge cases", () => {
  it("forwards a late response to onEvent when its id no longer matches any pending request", async () => {
    // rpc.md: "prompt ... may emit a later error response with the same id
    // if async prompt scheduling fails" -- arriving after the original
    // response already resolved and removed that id from pending tracking.
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.onCommand = (command) => {
      if (command["type"] === "prompt") transport.respondTo(command, { success: true, data: { agentInvoked: true } });
    };
    await proc.request({ type: "prompt", message: "hi" });
    const promptCommand = transport.commands.find((command) => command["type"] === "prompt");
    if (!promptCommand) throw new Error("expected a prompt command to have been sent");
    transport.respondTo(promptCommand, { success: false, error: "prompt scheduling failed" });
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "response", command: "prompt", success: false, error: "prompt scheduling failed" });
    await proc.close();
  });

  it("fails the pending request matching the response's command when the response carries no id", async () => {
    // rpc.md: "Unknown command responses are emitted with id: undefined (even
    // if the request had an id)." Without a command-type fallback this would
    // hang the caller forever instead of surfacing the failure.
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const pending = proc.request({ type: "some_new_command", value: 1 });
    await flushMicrotasks();
    transport.send({ type: "response", command: "some_new_command", success: false, error: "Unknown command: some_new_command" });

    await expect(pending).rejects.toThrow(/Unknown command/);
    await proc.close();
  });

  it("fails every pending request of the same command type on one id-less drop, leaving other-typed requests pending", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.onCommand = (command) => {
      if (command["type"] === "get_state") transport.respondTo(command, { success: true, data: {} });
    };
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const firstBash = proc.request({ type: "bash", command: "echo one" });
    const secondBash = proc.request({ type: "bash", command: "echo two" });
    const unrelated = proc.request({ type: "get_state" });
    await flushMicrotasks();
    transport.send({ type: "response", command: "bash", success: false, error: "Unknown command: bash" });

    await expect(firstBash).rejects.toThrow();
    await expect(secondBash).rejects.toThrow();
    await expect(unrelated).resolves.toEqual({});
    await proc.close();
  });

  it("forwards an id-less response to onEvent when no pending request shares its command", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.send({ type: "response", command: "parse", success: false, error: "Malformed JSON" });
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "response", command: "parse", success: false });
    await proc.close();
  });
});

describe("OmpRpcClient event dispatch", () => {
  it("delivers unsolicited event frames to onEvent, and never the ready or response frames", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.onCommand = (command) => {
      transport.respondTo(command, { success: true, data: null });
    };
    await proc.request({ type: "prompt", message: "hi" });
    transport.send({ type: "agent_start" });
    transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });

    expect(events.map((frame) => frame["type"])).toEqual(["agent_start", "message_update"]);
    await proc.close();
  });

  it("keeps dispatching frames after an onEvent listener throws", async () => {
    const transport = createFakeOmpTransport();
    const seen: string[] = [];
    const proc = client(transport, {
      onEvent: (frame) => {
        seen.push(String(frame["type"]));
        if (frame["type"] === "agent_start") throw new Error("listener bug");
      },
    });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.send({ type: "agent_start" });
    transport.send({ type: "agent_end", messages: [] });
    await flushMicrotasks();

    expect(seen).toEqual(["agent_start", "agent_end"]);
    await proc.close();
  });

  it("ignores an unparseable stdout line without breaking the reader", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    transport.sendRawLine("not json at all {{{");
    transport.send({ type: "agent_start" });
    await flushMicrotasks();

    expect(events).toEqual([{ type: "agent_start" }]);
    await proc.close();
  });
});

describe("OmpRpcClient bounded chunk decoder", () => {
  it("reassembles an in-order rpc_chunk sequence into one logical event frame", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    transport.onCommand = (command) => {
      if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
    };
    transport.sendReady({ supportedProtocolVersions: [1, 2] });
    await proc.start();

    const expected = { type: "message_update", content: "x".repeat(100) };
    for (const line of encodeTestRpcChunks(expected, "chunk-1", 12)) transport.sendRawLine(line);
    await flushMicrotasks();

    expect(events).toEqual([expected]);
    await proc.close();
  });

  it("treats an out-of-order chunk sequence as a fatal protocol violation", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.onCommand = (command) => {
      if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
    };
    transport.sendReady({ supportedProtocolVersions: [1, 2] });
    await proc.start();

    // Attach the rejection expectation before triggering the chunk poison:
    // it settles this request synchronously within flushMicrotasks below.
    const pendingRejection = expect(proc.request({ type: "never_answered" })).rejects.toThrow();
    const chunks = encodeTestRpcChunks({ type: "message_update", content: "x".repeat(100) }, "chunk-2", 12);
    // Skip index 0 — the sequence must start at index 0 per rpc.md.
    transport.sendRawLine(chunks[1] ?? "");
    await flushMicrotasks();

    expect(proc.alive).toBe(false);
    await pendingRejection;
  });

  it("rejects an rpc_chunk frame received before protocol v2 negotiation", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const chunks = encodeTestRpcChunks({ type: "message_update", content: "x".repeat(60) }, "chunk-3", 12);
    transport.sendRawLine(chunks[0] ?? "");
    await flushMicrotasks();

    expect(proc.alive).toBe(false);
  });

  it("enforces the ready frame's advertised reassembly ceiling", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.onCommand = (command) => {
      if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
    };
    transport.sendReady({ supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: 32 });
    await proc.start();

    transport.sendRawLine(JSON.stringify({ type: "rpc_chunk", chunkId: "huge", index: 0, count: 2, byteLength: 10_000, data: "AAAA" }));
    await flushMicrotasks();

    expect(proc.alive).toBe(false);
  });
});

describe("OmpRpcClient exit and cleanup", () => {
  it("reports alive=true after start and alive=false after the child exits", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();
    expect(proc.alive).toBe(true);

    transport.child.emitExit(0, null);
    await flushMicrotasks();
    expect(proc.alive).toBe(false);
  });

  it("fails a pending request when the child exits unexpectedly", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const pending = proc.request({ type: "prompt", message: "hi" });
    transport.child.emitExit(1, null);
    await expect(pending).rejects.toThrow();
  });

  it("fails a pending request when the child errors", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    const pending = proc.request({ type: "prompt", message: "hi" });
    transport.child.emitError(new Error("spawn EPIPE"));
    await expect(pending).rejects.toThrow();
  });

  it("rejects request() immediately once the process has exited, without writing to the dead pipe", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();
    transport.child.emitExit(0, null);
    await flushMicrotasks();

    const before = transport.commands.length;
    await expect(proc.request({ type: "get_state" })).rejects.toThrow();
    expect(transport.commands.length).toBe(before);
  });

  it("throws from send() once the process has exited, instead of silently dropping a human dialog answer", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();
    transport.child.emitExit(0, null);
    await flushMicrotasks();

    expect(() => {
      proc.send({ type: "extension_ui_response", id: "x", value: "y" });
    }).toThrow();
  });

  it("close() ends stdin and resolves once the child exits gracefully, without forcing a kill", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    transport.sendReady({ supportedProtocolVersions: [1] });
    await proc.start();

    await proc.close();
    expect(transport.child.stdin.writableEnded).toBe(true);
    expect(transport.child.killSignals).toEqual([]);
  });

  it("falls back to child.kill() when the process has no pid to target for a tree-wide kill", async () => {
    vi.useFakeTimers();
    try {
      const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false, omitPid: true });
      const proc = client(transport);
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      const closed = proc.close();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(transport.child.killSignals.length).toBeGreaterThan(0);
      transport.child.emitExit(0, "SIGTERM");
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === "win32")("escalates to a POSIX process-group SIGTERM then SIGKILL when the child does not exit", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
      const proc = client(transport);
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      const closed = proc.close();
      await vi.advanceTimersByTimeAsync(30_000);

      const pid = transport.child.pid;
      if (pid === undefined) throw new Error("expected the fake primary child to have a pid");
      expect(killSpy).toHaveBeenCalledWith(-pid, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-pid, "SIGKILL");
      transport.child.emitExit(0, "SIGKILL");
      await closed;
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("spawns a Windows taskkill tree-kill reaper when the child does not exit", async () => {
    vi.useFakeTimers();
    try {
      const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
      const proc = client(transport);
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      const closed = proc.close();
      await vi.advanceTimersByTimeAsync(30_000);

      const reaperCall = transport.spawnCalls[1];
      expect(reaperCall?.command.toLowerCase()).toContain("taskkill");
      expect(reaperCall?.args).toEqual(expect.arrayContaining(["/pid", String(transport.child.pid), "/t"]));
      transport.child.emitExit(null, "SIGTERM");
      await closed;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OmpRpcClient bounded control-command waits", () => {
  // Control commands (state reads/toggles) get a generous
  // bounded wait so a wedged omp process fails a status check instead of
  // hanging its caller forever; genuinely long-running, interruptible
  // operations stay unbounded exactly as before. Classification is by
  // command type, grounded in rpc.md: `bash` is documented to respond only
  // once the shell command completes; `compact`/`handoff` block on a model
  // call to summarize; `login` blocks on user OAuth interaction;
  // `new_session` can await session_before_switch/session_switch extension
  // hooks that themselves use interactive ctx.ui. The
  // prompt-family (`prompt`/`steer`/`follow_up`/`abort_and_prompt`) stays
  // unbounded too, out of caution, even though rpc.md documents their own
  // response as an immediate ack. No new public config: the bound is a
  // purely internal request()-type classification.
  //
  // These tests use a settlement-flag observed via `.then()` plus
  // `vi.advanceTimersByTimeAsync`, never a bare `await` on the request's own
  // promise: against today's unbounded source nothing ever settles it, and
  // blocking on it directly would hang past Vitest's own test timeout,
  // skipping this test's `finally` and leaking fake timers into later tests.
  it("bounds a control command like get_state and rejects if omp never answers", async () => {
    vi.useFakeTimers();
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      let rejected = false;
      proc.request({ type: "get_state" }).then(
        () => {
          // This request is expected to reject, not resolve; nothing to do here.
        },
        () => { rejected = true; },
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(rejected).toBe(true);
    } finally {
      await proc.close();
      vi.useRealTimers();
    }
  });

  it("keeps prompt/bash/compact/handoff/login requests unbounded past the control-command wait", async () => {
    vi.useFakeTimers();
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      const longRunningTypes = ["prompt", "steer", "follow_up", "abort_and_prompt", "bash", "compact", "handoff", "login", "new_session"];
      const settled: Record<string, boolean> = {};
      for (const type of longRunningTypes) {
        settled[type] = false;
        proc.request({ type }).then(
          () => { settled[type] = true; },
          () => { settled[type] = true; },
        );
      }

      await vi.advanceTimersByTimeAsync(120_000);

      for (const type of longRunningTypes) expect(settled[type]).toBe(false);
    } finally {
      await proc.close();
      vi.useRealTimers();
    }
  });
});

describe("OmpRpcClient stdout failure handling", () => {
  // Settlement-flag pattern for the same reason as the control-command
  // bound tests: against today's source nothing settles these requests, so
  // a bare `await expect(pending).rejects...` would hang the test.
  it("fails pending requests when stdout errors instead of leaving the client silently stuck", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      let rejected = false;
      proc.request({ type: "get_state" }).then(
        () => {
          // This request is expected to reject, not resolve; nothing to do here.
        },
        () => { rejected = true; },
      );
      transport.child.stdout.emit("error", new Error("EPIPE"));
      await flushMicrotasks();

      expect(rejected).toBe(true);
      expect(proc.alive).toBe(false);
    } finally {
      transport.child.emitExit(0, null);
      await proc.close();
    }
  });

  it("fails pending requests when stdout ends (EOF) while the child process itself never reports exit", async () => {
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1] });
      await proc.start();

      let rejected = false;
      proc.request({ type: "get_state" }).then(
        () => {
          // This request is expected to reject, not resolve; nothing to do here.
        },
        () => { rejected = true; },
      );
      transport.child.stdout.end();
      await flushMicrotasks();

      expect(rejected).toBe(true);
      expect(proc.alive).toBe(false);
    } finally {
      transport.child.emitExit(0, null);
      await proc.close();
    }
  });
});

describe("OmpRpcClient protocol poisoning terminates a stubborn child", () => {
  it("escalates to a real kill signal even though alive already reads false immediately after poisoning", async () => {
    // Mutation-test guard: a fix that merely sets `exited = true` on protocol
    // poisoning without actually terminating a child that ignores the
    // graceful EOF would still pass an alive-only assertion. This fails
    // unless a real termination signal reaches the still-running fake child.
    vi.useFakeTimers();
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    try {
      transport.onCommand = (command) => {
        if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      };
      transport.sendReady({ supportedProtocolVersions: [1, 2] });
      await proc.start();

      const chunks = encodeTestRpcChunks({ type: "message_update", content: "x".repeat(100) }, "chunk-stubborn", 12);
      transport.sendRawLine(chunks[1] ?? ""); // out-of-order -> poisonProtocol
      // `flushMicrotasks()` uses the real setImmediate, which fake timers
      // also intercept -- advance the fake clock by 0 instead so any queued
      // fake-timer-scheduled work (and true microtasks) settle deterministically.
      await vi.advanceTimersByTimeAsync(0);
      expect(proc.alive).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(transport.child.killSignals.length).toBeGreaterThan(0);
    } finally {
      transport.child.emitExit(0, "SIGKILL");
      await proc.close();
      vi.useRealTimers();
    }
  });
});

describe("OmpRpcClient bounded unchunked frame size", () => {
  it("rejects an oversized partial line before any newline or EOF arrives", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1], maxFrameBytes: 1024 });
      await proc.start();
      let rejected = false;
      void proc.request({ type: "get_state" }).catch(() => { rejected = true; });
      transport.child.stdout.write('{"type":"message_update","content":"');
      transport.child.stdout.write("x".repeat(2048));
      await flushMicrotasks();
      expect(rejected).toBe(true);
      expect(proc.alive).toBe(false);
    } finally {
      await proc.close();
    }
  });

  it("poisons on a single oversized v1-style line instead of accumulating it unboundedly", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.sendReady({ supportedProtocolVersions: [1], maxFrameBytes: 1024 });
      await proc.start();

      const oversizedLine = JSON.stringify({ type: "message_update", content: "x".repeat(10_000) });
      transport.sendRawLine(oversizedLine);
      await flushMicrotasks();

      expect(proc.alive).toBe(false);
    } finally {
      await proc.close();
    }
  });

  it("still reassembles a legitimate large v2 chunk sequence up to the advertised ceiling", async () => {
    // Regression guard: the new per-line size bound must not break the
    // existing successful large-payload path when it arrives correctly
    // chunked (each individual rpc_chunk line stays well under maxFrameBytes
    // even though the reassembled logical frame is much larger).
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    try {
      transport.onCommand = (command) => {
        if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      };
      transport.sendReady({ supportedProtocolVersions: [1, 2], maxFrameBytes: 1024 });
      await proc.start();

      const expected = { type: "message_update", content: "x".repeat(5000) };
      for (const line of encodeTestRpcChunks(expected, "chunk-large", 512)) transport.sendRawLine(line);
      await flushMicrotasks();

      expect(events).toEqual([expected]);
    } finally {
      await proc.close();
    }
  });

  it("rejects a chunk frame with a hostile non-finite byteLength instead of misbehaving on Infinity/NaN comparisons", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.onCommand = (command) => {
        if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      };
      transport.sendReady({ supportedProtocolVersions: [1, 2] });
      await proc.start();

      transport.sendRawLine(JSON.stringify({ type: "rpc_chunk", chunkId: "hostile", index: 0, count: 2, byteLength: Number.POSITIVE_INFINITY, data: "AAAA" }));
      await flushMicrotasks();

      expect(proc.alive).toBe(false);
    } finally {
      await proc.close();
    }
  });
});


describe("OmpRpcClient rejects a blocking startup dialog instead of hanging out the full readiness bound", () => {
  // omp can require an interactive confirmation before it finishes its own
  // handshake (e.g. a workspace-trust prompt). Nothing is positioned to
  // answer it during start()'s own bootstrap -- the caller only takes over
  // once start() resolves -- so omp would sit blocked forever, and today's
  // client would just wait out the full readiness timeout with no
  // actionable error. A blocking method (select/confirm/input/editor)
  // arriving before negotiation completes must fail start() immediately
  // and clearly instead. Passive methods (notify/setStatus/setWidget/
  // setTitle/set_editor_text/open_url/cancel) never need an answer and
  // must not trip this path.
  it("fails start() immediately when omp requests a blocking confirmation before the handshake completes", async () => {
    // Settlement-flag pattern: against today's source, start() only ever
    // settles via the 60s real readiness timeout for this scenario, which
    // would make the test itself time out before reaching its assertions.
    const transport = createFakeOmpTransport({ autoExitOnStdinEnd: false });
    const proc = client(transport);
    try {
      let rejected = false;
      let rejectionError: unknown;
      proc.start().then(
        () => {
          // start() is expected to reject, not resolve; nothing to do here.
        },
        (error: unknown) => { rejected = true; rejectionError = error; },
      );
      transport.send({ type: "extension_ui_request", id: "startup-confirm", method: "confirm", title: "Trust this workspace?", message: "Continue?" });
      await flushMicrotasks();

      expect(rejected).toBe(true);
      if (!(rejectionError instanceof Error)) throw new Error("expected start() to reject with an Error");
      expect(rejectionError.message).toMatch(/blocking|dialog|confirm/i);
    } finally {
      transport.child.emitExit(0, null);
      await proc.close();
    }
  });

  it("still completes start() normally when only a passive notify frame arrives before the handshake completes", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    try {
      transport.send({ type: "extension_ui_request", method: "notify", message: "starting up" });
      transport.sendReady({ supportedProtocolVersions: [1] });

      await expect(proc.start()).resolves.toBeUndefined();
      expect(events).toContainEqual({ type: "extension_ui_request", method: "notify", message: "starting up" });
    } finally {
      await proc.close();
    }
  });
});

describe("OmpRpcClient validates the ready frame's advertised reassembly ceiling", () => {
  // start() currently assigns readyFrame.maxReassembledFrameBytes blindly.
  // A hostile or broken peer advertising a non-finite/negative value must
  // not disable the reassembly ceiling (too permissive) or reject every
  // legitimate chunk sequence (too restrictive) -- either direction must
  // fall back to a safe local default instead.
  it("keeps rejecting an oversized chunk even when the ready frame advertises a non-finite ceiling", async () => {
    const transport = createFakeOmpTransport();
    const proc = client(transport);
    try {
      transport.onCommand = (command) => {
        if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      };
      transport.sendReady({ supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: Number.POSITIVE_INFINITY });
      await proc.start();

      transport.sendRawLine(JSON.stringify({ type: "rpc_chunk", chunkId: "x", index: 0, count: 2, byteLength: Number.MAX_SAFE_INTEGER, data: "AAAA" }));
      await flushMicrotasks();

      expect(proc.alive).toBe(false);
    } finally {
      await proc.close();
    }
  });

  it("still accepts a legitimate small chunk sequence when the ready frame advertises a negative ceiling", async () => {
    const transport = createFakeOmpTransport();
    const events: Record<string, unknown>[] = [];
    const proc = client(transport, { onEvent: (frame) => events.push(frame) });
    try {
      transport.onCommand = (command) => {
        if (command["type"] === "negotiate_protocol") transport.respondTo(command, { success: true, data: { protocolVersion: 2 } });
      };
      transport.sendReady({ supportedProtocolVersions: [1, 2], maxReassembledFrameBytes: -1 });
      await proc.start();

      const expected = { type: "message_update", content: "x".repeat(100) };
      for (const line of encodeTestRpcChunks(expected, "chunk-ok", 12)) transport.sendRawLine(line);
      await flushMicrotasks();

      expect(events).toEqual([expected]);
      expect(proc.alive).toBe(true);
    } finally {
      await proc.close();
    }
  });
});