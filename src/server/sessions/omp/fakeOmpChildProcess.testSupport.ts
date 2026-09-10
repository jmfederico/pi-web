import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * Minimal structural contract `OmpRpcClient` needs from a spawned child
 * process. Deliberately narrower than Node's `ChildProcess`/`spawn` typings so
 * tests can satisfy it with a plain object backed by real streams instead of
 * mocking Node's child_process module wholesale.
 */
export interface OmpRpcChildProcessLike {
  readonly pid?: number | undefined;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type OmpRpcSpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: unknown; windowsHide?: boolean; detached?: boolean },
) => OmpRpcChildProcessLike;

/** A single fake child process: real PassThrough streams plus a controllable exit/kill surface. */
export class FakeOmpChild extends EventEmitter implements OmpRpcChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined;
  readonly killSignals: NodeJS.Signals[] = [];
  exited = false;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
    this.stdin.on("error", () => {
      // Intentionally empty: a fake stream's own writable-side error would
      // otherwise become an uncaughtException with no listener attached.
    });
    this.stdout.on("error", () => {
      // Intentionally empty: mirrors the real transport's own listener
      // that exists only to prevent an uncaughtException.
    });
  }

  /** Records the requested signal; does not by itself end the process — tests drive `emitExit` explicitly so escalation timing (SIGTERM vs SIGKILL, reaper fallback) stays deterministic instead of racing a hidden auto-exit. */
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  /** Simulates the OS actually terminating the process (or a natural exit). */
  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  /** Simulates a spawn-time or transport-level error (e.g. ENOENT, EPIPE). */
  emitError(error: Error): void {
    this.emit("error", error);
  }
}

export interface RecordedSpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: unknown; windowsHide?: boolean; detached?: boolean };
}

export interface FakeOmpTransport {
  /** Every spawn() call in order. Index 0 is the primary `omp` child; later entries are auxiliary processes such as a Windows `taskkill` reaper. */
  readonly spawnCalls: RecordedSpawnCall[];
  /** The primary omp child returned by the first spawn() call. */
  readonly child: FakeOmpChild;
  /** Children returned by spawn() calls after the first, in call order. */
  readonly extraChildren: FakeOmpChild[];
  /** Every JSONL command line parsed off the primary child's stdin, in receipt order. */
  readonly commands: Record<string, unknown>[];
  /** Injected replacement for `child_process.spawn`. */
  readonly spawn: OmpRpcSpawnFn;
  /** Writes one JSON object as a line to the primary child's stdout. */
  send(frame: Record<string, unknown>): void;
  /** Writes a raw, unmodified line (newline appended) to the primary child's stdout — for malformed-input tests. */
  sendRawLine(line: string): void;
  /** Convenience: writes a `ready` frame. */
  sendReady(overrides?: Record<string, unknown>): void;
  /** Convenience: writes a response frame correlated to a previously-observed inbound command. */
  respondTo(command: { id?: unknown; type?: unknown }, result: { success: true; data?: unknown } | { success: false; error: string; code?: string }): void;
  /** Reassigned by tests to observe inbound commands as they arrive; called synchronously for each parsed JSONL line. */
  onCommand: (command: Record<string, unknown>) => void;
}

/**
 * Builds a fake `spawn()` dependency plus the primary child it returns, wired
 * so writes to the child's stdin are parsed as JSONL and reported through
 * `commands`/`onCommand`, mirroring how the real `omp --mode rpc-ui` process
 * reads commands. Real `PassThrough` streams stand in for the pipes so the
 * client under test exercises its actual line-reading/decoder logic instead
 * of a mocked decoder.
 */

export function createFakeOmpTransport(options: { autoExitOnStdinEnd?: boolean; omitPid?: boolean } = {}): FakeOmpTransport {
  const autoExitOnStdinEnd = options.autoExitOnStdinEnd ?? true;
  let nextPid = 4321;
  const child = new FakeOmpChild(options.omitPid === true ? undefined : nextPid++);
  const extraChildren: FakeOmpChild[] = [];
  const spawnCalls: RecordedSpawnCall[] = [];
  const commands: Record<string, unknown>[] = [];

  const spawn: OmpRpcSpawnFn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args: [...args], options: spawnOptions });
    if (spawnCalls.length === 1) return child;
    const extra = new FakeOmpChild(nextPid++);
    extraChildren.push(extra);
    return extra;
  };

  const transport: FakeOmpTransport = {
    spawnCalls,
    child,
    extraChildren,
    commands,
    spawn,
    send(frame) {
      child.stdout.write(`${JSON.stringify(frame)}\n`);
    },
    sendRawLine(line) {
      child.stdout.write(`${line}\n`);
    },
    sendReady(overrides = {}) {
      child.stdout.write(
        `${JSON.stringify({
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1024 * 1024,
          maxReassembledFrameBytes: 64 * 1024 * 1024,
          ...overrides,
        })}\n`,
      );
    },
    respondTo(command, result) {
      child.stdout.write(
        `${JSON.stringify({
          type: "response",
          id: command.id,
          command: command.type,
          ...result,
        })}\n`,
      );
    },
    onCommand: () => {
      // Default no-op: tests reassign this to observe inbound commands.
    },
  };

  let partial = "";
  child.stdin.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSON.parse boundary: a validated non-null, non-array `object` has no index signature TS can derive from `typeof`/`Array.isArray` alone.
      const record = parsed as Record<string, unknown>;
      commands.push(record);
      transport.onCommand(record);
    }
  });
  if (autoExitOnStdinEnd) {
    child.stdin.on("end", () => {
      queueMicrotask(() => {
        child.emitExit(0, null);
      });
    });
  }

  return transport;
}

/** Encodes a JSON frame as a bounded sequence of protocol-v2 `rpc_chunk` lines for decoder tests. */
export function encodeTestRpcChunks(frame: Record<string, unknown>, chunkId: string, chunkPayloadBytes: number): string[] {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  const count = Math.max(1, Math.ceil(bytes.byteLength / chunkPayloadBytes));
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * chunkPayloadBytes;
    const slice = bytes.subarray(start, start + chunkPayloadBytes);
    lines.push(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId,
        index,
        count,
        byteLength: bytes.byteLength,
        data: slice.toString("base64"),
      }),
    );
  }
  return lines;
}
