import { spawn as nodeChildProcessSpawn } from "node:child_process";

/**
 * Process + protocol layer for `omp --mode rpc-ui` (NDJSON over stdio).
 *
 * Protocol reference: omp://rpc.md. Commands `{id, type, ...}` go out on
 * stdin; `{type:"response", id, ...}` plus interleaved unsolicited event
 * frames come back on stdout. omp announces readiness with a `{type:"ready"}`
 * frame before accepting commands; when it advertises protocol v2, oversized
 * logical frames are carried as bounded `rpc_chunk` sequences. Outbound
 * commands are never chunked (the protocol only chunks large *stdout* output;
 * "inbound commands are always one unchunked JSONL object").
 *
 * Kept intentionally independent of the Bun-only `@oh-my-pi/pi-coding-agent`
 * package (it cannot run under pi-web's Node server) — the wire contract and
 * environment-isolation keys below were traced against that installed
 * package purely as a reference, not a dependency.
 */

const DEFAULT_COMMAND = "omp";
const STARTUP_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
const STDERR_TAIL_LIMIT = 8 * 1024;
const DEFAULT_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
// rpc.md: the server caps each physical stdout frame (a v1 unchunked frame,
// or one physical `rpc_chunk` record within a v2 sequence) at 1 MiB unless
// the ready frame advertises a different ceiling.
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
// Control commands (state reads/toggles) get a generous bounded wait so a
// wedged omp process fails a status check instead of hanging its caller
// forever. Genuinely long-running, interruptible operations stay
// unbounded: the prompt family responds with an immediate ack per rpc.md
// but the underlying work (and any interactive follow-up) can run
// indefinitely; `bash`/`compact`/`handoff`/`login`/`new_session` themselves
// block on a shell command, model call, or user/extension interaction.
const CONTROL_COMMAND_TIMEOUT_MS = 60_000;
const UNBOUNDED_COMMAND_TYPES = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort_and_prompt",
  "bash",
  "compact",
  "handoff",
  "login",
  "new_session",
]);
// Extension UI methods that block the extension awaiting a human answer.
// Passive methods (notify/setStatus/setWidget/setTitle/set_editor_text/
// open_url/cancel) never need one and must not trip the startup guard below.
const BLOCKING_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Minimal structural contract this client needs from a spawned child
 * process. Narrower than Node's `ChildProcess` so tests can satisfy it with a
 * plain object backed by real streams instead of mocking `child_process`.
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

export interface OmpRpcSpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide?: boolean;
  detached?: boolean;
}

export type OmpRpcSpawnFn = (command: string, args: readonly string[], options: OmpRpcSpawnOptions) => OmpRpcChildProcessLike;

export interface OmpRpcClientOptions {
  cwd: string;
  command?: string;
  agentDir: string;
  sessionFile?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (frame: Record<string, unknown>) => void;
  /**
   * Test-only dependency-injection seam. Mirrors the identical
   * `dependencies.spawn` seam on ompweb's own production `RpcProcess`
   * (the reference implementation for this wire protocol) — real callers
   * omit it and get the actual `child_process.spawn`.
   */
  dependencies?: {
    spawn?: OmpRpcSpawnFn;
  };
}

export class OmpRpcCommandError extends Error {
  override readonly name = "OmpRpcCommandError";
  readonly command: string;
  readonly code: string | undefined;

  constructor(command: string, message: string, code?: string) {
    super(message);
    this.command = command;
    this.code = code;
  }
}

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingChunkSequence {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

/**
 * Runtime-identity environment keys that must never leak from a parent
 * process into a spawned `omp` child unless explicitly intended:
 * - `PI_CODING_AGENT_SESSION_DIR` / `PI_WEB_AGENT_SESSION_DIR`: Pi's own
 *   session-storage override (pi-web/src/config.ts) — irrelevant to OMP and,
 *   if inherited, would point OMP at Pi's session directory.
 * - `OMP_PROFILE` / `PI_PROFILE`: named-profile selectors that would resolve
 *   the child to a different agent profile than the one `agentDir` selects.
 * - `PI_SESSION_FILE`, `PI_ARTIFACTS_DIR`, `PI_TOOL_BRIDGE_URL`,
 *   `PI_TOOL_BRIDGE_TOKEN`, `PI_TOOL_BRIDGE_SESSION`, `PI_EVAL_LOCAL_ROOTS`:
 *   the installed OMP package's own per-session eval/bash tool-bridge
 *   identity (`@oh-my-pi/pi-coding-agent` `MANAGED_KERNEL_ENV_KEYS`,
 *   src/eval/executor-base.ts). A pi-web sessiond process started from
 *   inside a running Pi/OMP session inherits these on its own
 *   `process.env`; left unscrubbed they would point a freshly-spawned OMP
 *   child at the PARENT session's tool bridge and session file.
 */
const STRIPPED_RUNTIME_IDENTITY_ENV_KEYS = [
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

function buildArgs(options: OmpRpcClientOptions): string[] {
  const args = ["--mode", "rpc-ui", "--cwd", options.cwd];
  if (options.sessionFile !== undefined) args.push("--resume", options.sessionFile);
  return args;
}

function buildChildEnv(options: OmpRpcClientOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  // Dedicated field always wins: this is the one env var OMP and Pi's own
  // agent-dir override happen to share the exact same name for.
  env["PI_CODING_AGENT_DIR"] = options.agentDir;
  for (const key of STRIPPED_RUNTIME_IDENTITY_ENV_KEYS) {
    if (options.env?.[key] === undefined) Reflect.deleteProperty(env, key);
  }
  return env;
}

function defaultSpawn(command: string, args: readonly string[], options: OmpRpcSpawnOptions): OmpRpcChildProcessLike {
  return nodeChildProcessSpawn(command, [...args], options);
}

function isRecordFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "type" in value && typeof value.type === "string";
}

function decodeBase64Chunk(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("invalid RPC chunk data");
  }
  return Buffer.from(value, "base64");
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Validates a ready-frame-advertised ceiling before adopting it: a hostile
 * or broken peer advertising a non-finite (serializes to `null`), zero, or
 * negative value must not disable the ceiling entirely or reject every
 * legitimate frame — either direction falls back to the safe local default
 * instead of being adopted. */
function isFinitePositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBlockingUiMethod(method: unknown): boolean {
  return typeof method === "string" && BLOCKING_EXTENSION_UI_METHODS.has(method);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * `Promise.withResolvers()` equivalent, captured manually: that API is
 * ES2024 and this project's tsconfig `lib` target is ES2022, which this
 * change does not broaden.
 */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class OmpRpcClient {
  private readonly options: OmpRpcClientOptions;
  private child: OmpRpcChildProcessLike | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private stderrTail = "";
  // `exited` means the client considers the RPC session dead (poisoned,
  // timed out, transport lost, or the OS process actually exited) and
  // refuses further commands. `processExited` means the OS process itself
  // is confirmed gone. They diverge whenever the client gives up on a
  // still-running, uncommunicative child (protocol poisoning, a broken
  // stdout pipe) — `close()`/`killTree` must escalate a real kill in that
  // case instead of mistaking "we gave up" for "it already exited".
  private exited = false;
  private processExited = false;
  // True from the start of start() until it settles (success or failure).
  // Nothing is positioned to answer an interactive extension dialog during
  // this bootstrap window, so a blocking one arriving here must fail
  // start() immediately instead of hanging out the full readiness bound.
  private startupPhase = false;
  private started = false;
  private protocolVersion: 1 | 2 = 1;
  private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  private maxReassembledFrameBytes = DEFAULT_MAX_REASSEMBLED_FRAME_BYTES;
  private pendingChunkSequence: PendingChunkSequence | undefined;
  private readyResolve: ((frame: Record<string, unknown>) => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;

  constructor(options: OmpRpcClientOptions) {
    this.options = options;
  }

  get alive(): boolean {
    return !this.exited;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("OmpRpcClient.start() has already been called");
    this.started = true;
    this.startupPhase = true;

    const spawnFn = this.options.dependencies?.spawn ?? defaultSpawn;
    const child = spawnFn(this.options.command ?? DEFAULT_COMMAND, buildArgs(this.options), {
      cwd: this.options.cwd,
      env: buildChildEnv(this.options),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.child = child;

    // A write queued when the child dies fails both the write callback and an
    // 'error' event on the pipe; without a listener that becomes an
    // uncaughtException.
    child.stdin.on("error", () => {
      // Intentionally empty: mirrors the write-error listener above --
      // presence alone prevents an uncaughtException from the pipe.
    });
    child.stdout.on("error", (error: Error) => {
      this.handleTransportLost(new Error(`omp RPC stdout error: ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
    });

    // Manual reader, not `readline`: `readline.createInterface` buffers an
    // unterminated physical line internally with no size cap and only ever
    // emits "line" once it sees "\n" -- a hostile/broken peer that never
    // sends a newline would accumulate unboundedly before `handleLine`'s own
    // per-line check ever got a chance to run. This accumulates incrementally
    // instead, checking the still-unterminated buffer against maxFrameBytes
    // as each chunk arrives. A stateful `TextDecoder` (not per-chunk
    // `toString`) correctly reassembles a multi-byte UTF-8 character split
    // across two chunk boundaries.
    const stdoutDecoder = new TextDecoder("utf-8");
    let lineBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += stdoutDecoder.decode(chunk, { stream: true });
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        this.handleLine(line);
        if (this.exited) return;
        newlineIndex = lineBuffer.indexOf("\n");
      }
      if (Buffer.byteLength(lineBuffer, "utf8") > this.maxFrameBytes) {
        this.poisonProtocol(new Error(`RPC line exceeds the advertised maxFrameBytes (${String(this.maxFrameBytes)})`));
      }
    });
    child.stdout.on("end", () => {
      // Mirrors readline's own EOF behavior: a final line with no trailing
      // newline (the process died mid-write) is still handed to the decoder
      // rather than silently dropped.
      if (lineBuffer.length > 0) {
        const finalLine = lineBuffer;
        lineBuffer = "";
        if (!this.exited) this.handleLine(finalLine);
      }
      // A graceful exit also ends stdout, and `finalizeExit` below already
      // handles that case; only an unexpected EOF while the OS process
      // itself never reports exit needs to fail pending requests here.
      if (!this.processExited) this.handleTransportLost(new Error("omp RPC stdout closed unexpectedly"));
    });

    const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = deferred<Record<string, unknown>>();
    this.readyResolve = readyResolve;
    this.readyReject = readyReject;
    readyPromise.catch(() => {
      // Rejection is handled via readyReject/withStartupBound below; this
      // no-op catch only prevents an unhandled rejection warning if that
      // path never consumes the promise.
    });

    const finalizeExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (this.processExited) return;
      this.processExited = true;
      if (!this.exited) {
        this.exited = true;
        const err = new Error(
          `omp exited (code ${String(code ?? "null")}, signal ${signal ?? "none"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`,
        );
        this.failAllPending(err);
        readyReject(err);
      }
    };
    child.on("exit", finalizeExit);
    child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}\nspawn error: ${error.message}`.slice(-STDERR_TAIL_LIMIT);
      finalizeExit(null, null);
    });

    let readyFrame: Record<string, unknown>;
    try {
      readyFrame = await this.withStartupBound(readyPromise, "omp RPC did not become ready");
    } catch (error) {
      this.startupPhase = false;
      if (!this.exited) this.exited = true;
      void this.close();
      throw error;
    }

    const supported = Array.isArray(readyFrame["supportedProtocolVersions"]) ? readyFrame["supportedProtocolVersions"] : [];
    if (isFinitePositiveSafeInteger(readyFrame["maxFrameBytes"])) this.maxFrameBytes = readyFrame["maxFrameBytes"];
    if (isFinitePositiveSafeInteger(readyFrame["maxReassembledFrameBytes"])) {
      this.maxReassembledFrameBytes = readyFrame["maxReassembledFrameBytes"];
    }
    if (!supported.includes(2)) {
      this.startupPhase = false;
      return;
    }

    try {
      const negotiated = await this.withStartupBound(
        this.request<{ protocolVersion?: unknown }>({ type: "negotiate_protocol", protocolVersion: 2 }),
        "omp RPC protocol v2 negotiation did not complete",
      );
      if (negotiated.protocolVersion !== 2) throw new Error("OMP rejected RPC protocol v2 negotiation");
      this.protocolVersion = 2;
    } catch (error) {
      this.startupPhase = false;
      if (!this.exited) this.exited = true;
      void this.close();
      throw error;
    }
    this.startupPhase = false;
  }

  private withStartupBound<T>(promise: Promise<T>, timeoutMessage: string): Promise<T> {
    const { promise: bounded, resolve, reject } = deferred<T>();
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutMessage} within ${String(STARTUP_TIMEOUT_MS)}ms`));
    }, STARTUP_TIMEOUT_MS);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return bounded;
  }

  /** Send a command and await its response `data`. A failed response rejects
   * with `OmpRpcCommandError`. Long-running/interruptible command types
   * (see `UNBOUNDED_COMMAND_TYPES`) have no timeout here — the startup
   * handshake is bounded separately in `start()`. Every other command is a
   * state read/toggle omp answers synchronously in normal operation, so it
   * gets a generous bounded wait instead of hanging its caller forever
   * against a wedged process. */
  request<T = unknown>(command: { type: string; [key: string]: unknown }): Promise<T> {
    if (this.exited || !this.child) {
      return Promise.reject(new Error("OMP RPC process is not running"));
    }
    const id = `r${String(this.nextId++)}`;
    const { promise, resolve, reject } = deferred<T>();
    this.pending.set(id, {
      command: command.type,
      // The pending map intentionally erases each in-flight request's own
      // T so heterogeneous requests share one Map; the RPC protocol
      // contract (a response's `data` matches the T requested for its id),
      // not the type system, guarantees this at runtime.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- generic RPC response T boundary cannot be soundly narrowed from `unknown`; see comment above.
      resolve: resolve as (data: unknown) => void,
      reject,
    });
    this.writeLine({ ...command, id }, (error) => {
      if (error) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          reject(error);
        }
      }
    });

    if (UNBOUNDED_COMMAND_TYPES.has(command.type)) return promise;

    const { promise: bounded, resolve: boundedResolve, reject: boundedReject } = deferred<T>();
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        boundedReject(
          new Error(`OMP control command "${command.type}" did not respond within ${String(CONTROL_COMMAND_TIMEOUT_MS)}ms`),
        );
      }
    }, CONTROL_COMMAND_TIMEOUT_MS);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        boundedResolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        boundedReject(error);
      },
    );
    return bounded;
  }

  /** Fire-and-forget frame write (extension_ui_response, host_tool_result). Throws once the process has exited: a dropped human dialog answer must surface immediately, never vanish silently. */
  send(frame: { type: string; [key: string]: unknown }): void {
    if (this.exited || !this.child) {
      throw new Error("OMP RPC process is not running");
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Graceful shutdown: close stdin (omp exits on EOF), escalate to
   * SIGTERM/taskkill then SIGKILL/forced-taskkill on the whole process tree.
   * Resolves once the process has exited. Escalation timers are unref'd so
   * they never keep the event loop alive on their own. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const { promise: exited, resolve: resolveExited }: Deferred<void> = deferred();
    if (this.processExited) {
      resolveExited();
    } else {
      child.once("exit", () => {
        resolveExited();
      });
    }
    try {
      child.stdin.end();
    } catch {
      // Best-effort; the child may already be gone.
    }

    const killTree = (force: boolean, signal: NodeJS.Signals): void => {
      if (this.processExited) return;
      const pid = child.pid;
      if (process.platform !== "win32") {
        if (pid !== undefined) {
          try {
            process.kill(-pid, signal);
            return;
          } catch {
            // The process group may already be gone; fall back to the direct child.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // Termination is best-effort once the graceful path has failed.
        }
        return;
      }
      // Windows has no negative-pid process-group signal. omp can spawn
      // grandchildren (LSP servers, extension subprocesses) that a plain
      // child.kill() would orphan, so use taskkill's tree option instead.
      if (pid !== undefined) {
        try {
          const spawnFn = this.options.dependencies?.spawn ?? defaultSpawn;
          spawnFn("taskkill", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          return;
        } catch {
          // Fall through to the direct kill below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Termination is best-effort once the graceful path has failed.
      }
    };

    const softTimer = setTimeout(() => {
      killTree(false, "SIGTERM");
    }, CLOSE_GRACE_MS);
    const hardTimer = setTimeout(() => {
      killTree(true, "SIGKILL");
    }, CLOSE_GRACE_MS * 2);
    softTimer.unref();
    hardTimer.unref();
    await exited;
    clearTimeout(softTimer);
    clearTimeout(hardTimer);
  }

  private writeLine(frame: Record<string, unknown>, callback: (error?: Error | null) => void): void {
    if (!this.child || this.exited) {
      callback(new Error("OMP RPC process is not running"));
      return;
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      callback(error ?? null);
    });
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  /** stdout breaking (EPIPE, or an unexpected EOF while the OS process
   * itself never reports exit) leaves the client unable to ever observe a
   * response again. Fail every pending request instead of leaving callers
   * stuck forever, and attempt to terminate the now-uncommunicative child. */
  private handleTransportLost(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.readyReject?.(error);
    this.failAllPending(error);
    void this.close();
  }

  private dispatchEvent(frame: Record<string, unknown>): void {
    const onEvent = this.options.onEvent;
    if (!onEvent) return;
    try {
      onEvent(frame);
    } catch {
      // Listener bugs must not break the protocol reader.
    }
  }

  private handleResponse(response: Record<string, unknown>): void {
    const id = typeof response["id"] === "string" ? response["id"] : undefined;
    const command = typeof response["command"] === "string" ? response["command"] : undefined;

    if (id !== undefined) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        this.settlePending(entry, response);
        return;
      }
      // Present but unmatched: a late/duplicate response for an id already
      // settled (rpc.md: prompt/abort_and_prompt may emit a later error
      // response with the same id). Surface it instead of dropping it.
      this.dispatchEvent(response);
      return;
    }

    // No id at all: rpc.md documents that unknown-command and parse-failure
    // responses are emitted with id: undefined even when the request had
    // one. Without recovering by command type, such a failure would hang
    // its caller forever instead of surfacing.
    if (command !== undefined) {
      const matches = [...this.pending.entries()].filter(([, entry]) => entry.command === command);
      if (matches.length > 0) {
        for (const [pendingId, entry] of matches) {
          this.pending.delete(pendingId);
          this.settlePending(entry, response);
        }
        return;
      }
    }
    this.dispatchEvent(response);
  }

  private settlePending(entry: PendingRequest, response: Record<string, unknown>): void {
    if (response["success"] === true) {
      entry.resolve(response["data"]);
      return;
    }
    const message = typeof response["error"] === "string" ? response["error"] : "RPC command failed";
    const code = typeof response["code"] === "string" ? response["code"] : undefined;
    entry.reject(new OmpRpcCommandError(entry.command, message, code));
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (this.startupPhase && frame["type"] === "extension_ui_request" && isBlockingUiMethod(frame["method"])) {
      // Nothing is positioned to answer an interactive dialog during
      // start()'s own bootstrap; without this, the client would just wait
      // out the full readiness timeout with no actionable error.
      const error = new Error(
        `omp requested a blocking "${String(frame["method"])}" confirmation before RPC startup completed; interactive startup dialogs are not supported`,
      );
      this.readyReject?.(error);
      this.failAllPending(error);
      return;
    }
    if (frame["type"] === "ready") {
      this.readyResolve?.(frame);
      return;
    }
    if (frame["type"] === "response") {
      this.handleResponse(frame);
      return;
    }
    this.dispatchEvent(frame);
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      // Applies uniformly to v1 unchunked frames and each individual v2
      // `rpc_chunk` physical record: only the *reassembled* logical frame is
      // allowed to exceed this ceiling, via bounded chunking.
      this.poisonProtocol(new Error(`RPC line exceeds the advertised maxFrameBytes (${String(this.maxFrameBytes)})`));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // omp guards stdout in RPC mode, but never let a stray line kill the reader.
      return;
    }
    if (!isRecordFrame(parsed)) return;

    let frame: Record<string, unknown> | undefined;
    try {
      frame = this.decodeChunk(parsed);
    } catch (error) {
      this.poisonProtocol(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!frame) return; // Partial chunk sequence; wait for the remaining chunks.
    this.handleFrame(frame);
  }

  /** Decodes complete logical frames from parsed JSONL records, reassembling
   * bounded protocol-v2 `rpc_chunk` sequences. Deliberately simpler than a
   * full byte-accounting decoder: it validates what a client actually needs
   * to trust (sequence ordering, declared vs. advertised size, base64/UTF-8/
   * JSON well-formedness) without also re-deriving the server's own
   * physical-frame-size threshold for when to chunk in the first place. */
  private decodeChunk(value: Record<string, unknown>): Record<string, unknown> | undefined {
    if (value["type"] !== "rpc_chunk") {
      if (this.pendingChunkSequence) throw new Error("RPC chunk sequence interrupted");
      return value;
    }
    if (this.protocolVersion !== 2) throw new Error("RPC chunk received before protocol v2 negotiation");

    const chunkId = value["chunkId"];
    const index = value["index"];
    const count = value["count"];
    const byteLength = value["byteLength"];
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      !isSafeInteger(index) ||
      !isSafeInteger(count) ||
      !isSafeInteger(byteLength) ||
      index < 0 ||
      count < 1 ||
      index >= count ||
      byteLength < 0 ||
      byteLength > this.maxReassembledFrameBytes
    ) {
      throw new Error("invalid RPC chunk metadata");
    }

    const bytes = decodeBase64Chunk(value["data"]);
    if (!this.pendingChunkSequence) {
      if (index !== 0) throw new Error("RPC chunk sequence must start at index 0");
      this.pendingChunkSequence = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const pending = this.pendingChunkSequence;
    if (pending.chunkId !== chunkId || pending.count !== count || pending.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new Error("RPC chunk sequence mismatch");
    }
    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex++;
    if (pending.receivedBytes > pending.byteLength) throw new Error("RPC chunk sequence exceeds declared length");
    if (pending.nextIndex < pending.count) return undefined;
    if (pending.receivedBytes !== pending.byteLength) throw new Error("RPC chunk sequence length mismatch");

    this.pendingChunkSequence = undefined;
    const json = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = JSON.parse(json);
    if (!isRecordFrame(frame)) throw new Error("RPC frame must be an object with a string type");
    return frame;
  }

  /** A malformed/out-of-sequence chunk, or a single frame exceeding the
   * advertised size ceiling, means the stream can no longer be trusted:
   * dispose the client (mirrors ompweb's identical response to a decode
   * error) rather than trying to resynchronize. */
  private poisonProtocol(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.readyReject?.(error);
    this.failAllPending(error);
    void this.close();
  }
}
