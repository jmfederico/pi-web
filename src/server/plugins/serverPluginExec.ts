import { spawn } from "node:child_process";
import type {
  ServerPluginExecFileRequest,
  ServerPluginExecFileResult,
} from "../../server-plugin-api.js";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
// Git changes historically bounded command stdout at 2 MiB; keep that ceiling
// available through the same public helper used by every server plugin.
const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 250;

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

  return async (request) => runExecFile(request, { baseEnv, maxTimeoutMs, maxOutputBytes });
}

interface ResolvedExecOptions {
  baseEnv: NodeJS.ProcessEnv;
  maxTimeoutMs: number;
  maxOutputBytes: number;
}

function runExecFile(
  request: ServerPluginExecFileRequest,
  options: ResolvedExecOptions,
): Promise<ServerPluginExecFileResult> {
  validateRequest(request);
  if (request.signal.aborted) return Promise.reject(abortReason(request.signal));

  const timeoutMs = Math.min(request.timeoutMs ?? options.maxTimeoutMs, options.maxTimeoutMs);
  const stdout = new BoundedOutput(options.maxOutputBytes);
  const stderr = new BoundedOutput(options.maxOutputBytes);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(request.file, [...(request.args ?? [])], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: commandEnvironment(options.baseEnv, request),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
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
      killChildTree(child, "SIGTERM");
      setTimeout(() => {
        killChildTree(child, "SIGKILL");
      }, FORCE_KILL_GRACE_MS);
      reject(error);
    };
    const onAbort = (): void => {
      abortChild(abortReason(request.signal));
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: unknown) => { stdout.append(chunk); });
    child.stderr.on("data", (chunk: unknown) => { stderr.append(chunk); });
    child.once("error", (error) => { reject(error); });
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  constructor(private readonly limit: number) {}

  append(value: unknown): void {
    const chunk = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value) : undefined;
    if (chunk === undefined || chunk.length === 0) return;
    const remaining = this.limit - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.bytes += remaining;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
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

interface KillableChild {
  pid?: number | undefined;
  kill(signal: NodeJS.Signals): boolean;
}

function killChildTree(child: KillableChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Termination is best-effort after the bounded operation has failed.
  }
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
