import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
} from "../../server-plugin-api.js";
import type { HelperCommand, HelperRequest, HelperResponse } from "./serverPluginCommandHelper.js";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
// Git changes historically bounded command stdout at 2 MiB; keep that ceiling
// available through the same public helper used by every server plugin.
const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface ServerPluginExecFileOptions {
  env?: NodeJS.ProcessEnv;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
}

/** Creates the argv-only, host-bounded command helper exposed to server plugins. */
export function createServerPluginExecFile(
  options: ServerPluginExecFileOptions = {},
): (request: ServerPluginExecFileRequest) => Promise<ServerPluginExecFileResult> {
  const baseEnv = Object.freeze({ ...(options.env ?? process.env) });
  const maxTimeoutMs = positiveInteger(options.maxTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS, "maxTimeoutMs");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_OUTPUT_LIMIT_BYTES, "maxOutputBytes");

  const helper = new CommandHelperClient(forkCommandHelper);

  return async (request) => runExecFile(request, { baseEnv, maxTimeoutMs, maxOutputBytes, helper });
}

interface ResolvedExecOptions {
  baseEnv: NodeJS.ProcessEnv;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  helper: CommandHelperClient;
}

type CommandOutcome = { result: ServerPluginExecFileResult } | { error: Error };

interface PendingCommand {
  helper: ChildProcess;
  settle: (outcome: CommandOutcome) => void;
}

/**
 * Starting a process from Node forks the calling process. Once the daemon holds
 * gigabytes of sessions, each fork blocks its event loop for hundreds of
 * milliseconds, so commands start from a small, long-lived helper process.
 */
class CommandHelperClient {
  private helper: ChildProcess | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(private readonly startHelper: () => ChildProcess) {}

  /** Returns a function that terminates the command's process group. */
  start(command: HelperCommand, settle: (outcome: CommandOutcome) => void): () => void {
    const helper = this.connectedHelper();
    const id = ++this.nextId;
    this.pending.set(id, { helper, settle });
    this.updateRef(helper);
    this.send(helper, { type: "start", id, command });
    return () => {
      if (this.pending.has(id)) this.send(helper, { type: "terminate", id });
    };
  }

  private connectedHelper(): ChildProcess {
    if (this.helper?.connected === true) return this.helper;
    const helper = this.startHelper();
    helper.on("message", (message: unknown) => {
      if (!isHelperResponse(message)) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      this.updateRef(helper);
      pending.settle("error" in message
        ? { error: Object.assign(new Error(message.error.message), message.error) }
        : { result: message.result });
    });
    const lost = (): void => {
      if (this.helper === helper) this.helper = undefined;
      helper.kill();
      for (const [id, pending] of this.pending) {
        if (pending.helper !== helper) continue;
        this.pending.delete(id);
        pending.settle({ error: new Error("Server plugin command helper exited before the command finished") });
      }
    };
    helper.once("exit", lost);
    helper.once("error", lost);
    this.helper = helper;
    return helper;
  }

  private send(helper: ChildProcess, request: HelperRequest): void {
    // A helper that has just exited reports through its exit event.
    if (helper.connected) helper.send(request);
  }

  /** An idle helper must not keep the daemon alive. */
  private updateRef(helper: ChildProcess): void {
    const busy = [...this.pending.values()].some((pending) => pending.helper === helper);
    if (busy) helper.ref();
    else helper.unref();
    // Bun's IPC channel has no ref() or unref() and does not keep the process alive.
    const channel = helper.channel;
    const setRef: unknown = channel === null || channel === undefined ? undefined : Reflect.get(channel, busy ? "ref" : "unref");
    if (typeof setRef === "function") Reflect.apply(setRef, channel, []);
  }
}

function isHelperResponse(value: unknown): value is HelperResponse {
  if (typeof value !== "object" || value === null || typeof Reflect.get(value, "id") !== "number") return false;
  const error: unknown = Reflect.get(value, "error");
  if (error !== undefined) return typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string";
  return typeof Reflect.get(value, "result") === "object";
}

function forkCommandHelper(): ChildProcess {
  const source = extname(fileURLToPath(import.meta.url)) === ".ts";
  const helperPath = fileURLToPath(new URL(source ? "./serverPluginCommandHelper.ts" : "./serverPluginCommandHelper.js", import.meta.url));
  const loader = source ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href : undefined;
  return fork(helperPath, [], {
    // Do not inherit daemon flags such as --inspect.
    execArgv: loader === undefined ? [] : ["--import", loader],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

function runExecFile(
  request: ServerPluginExecFileRequest,
  options: ResolvedExecOptions,
): Promise<ServerPluginExecFileResult> {
  validateRequest(request);
  if (request.signal.aborted) return Promise.reject(abortReason(request.signal));

  const timeoutMs = Math.min(request.timeoutMs ?? options.maxTimeoutMs, options.maxTimeoutMs);

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const timeout = setTimeout(() => {
      abortChild(new ExecTimeoutError(`Server plugin command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    };
    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(asError(error));
    };
    const resolve = (result: ServerPluginExecFileResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };
    const abortChild = (error: unknown): void => {
      if (settled) return;
      terminate();
      reject(error);
    };
    const onAbort = (): void => {
      abortChild(abortReason(request.signal));
    };

    const terminate = options.helper.start({
      file: request.file,
      args: [...(request.args ?? [])],
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: commandEnvironment(options.baseEnv, request),
      maxOutputBytes: options.maxOutputBytes,
    }, (outcome) => {
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.result);
    });
    request.signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ExecTimeoutError extends Error {
  override name = "TimeoutError";
}

function validateRequest(request: ServerPluginExecFileRequest): void {
  if (typeof request.file !== "string" || request.file === "") throw new Error("Server plugin command file must be a non-empty string");
  if (request.args !== undefined && (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string"))) {
    throw new Error("Server plugin command args must be strings");
  }
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd === "")) {
    throw new Error("Server plugin command cwd must be a non-empty string");
  }
  if (request.env !== undefined && !Object.values(request.env).every((value) => typeof value === "string")) {
    throw new Error("Server plugin command env values must be strings");
  }
  if (request.unsetEnv !== undefined && (!Array.isArray(request.unsetEnv) || !request.unsetEnv.every(isEnvironmentKey))) {
    throw new Error("Server plugin command unsetEnv keys must be non-empty strings without '=' or null bytes");
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new Error("Server plugin command timeoutMs must be a positive integer");
  }
  if (!isAbortSignal(request.signal)) throw new Error("Server plugin commands require an AbortSignal");
}

function commandEnvironment(baseEnv: NodeJS.ProcessEnv, request: ServerPluginExecFileRequest): NodeJS.ProcessEnv {
  const env = { ...baseEnv, ...(request.env ?? {}) };
  for (const key of request.unsetEnv ?? []) Reflect.deleteProperty(env, key);
  return env;
}

function isEnvironmentKey(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("=") && !value.includes("\0");
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "aborted") === "boolean"
    && typeof Reflect.get(value, "addEventListener") === "function"
    && typeof Reflect.get(value, "removeEventListener") === "function";
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error("The operation was aborted", { cause: reason });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveInteger(value: number | undefined, fallback: number, key: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${key} must be a positive integer`);
  return resolved;
}
