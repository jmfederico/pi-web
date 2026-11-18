import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerPluginExecFileResult } from "../../server-plugin-api.js";

const FORCE_KILL_GRACE_MS = 250;

/** A server plugin command after the daemon has validated it and resolved its environment. */
export interface HelperCommand {
  file: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
}

export type HelperRequest =
  | { type: "start"; id: number; command: HelperCommand }
  | { type: "terminate"; id: number };

export interface SerializedSpawnError {
  name: string;
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

export type HelperResponse =
  | { id: number; pid: number }
  | { id: number; result: ServerPluginExecFileResult }
  | { id: number; error: SerializedSpawnError };

/**
 * Starts commands for the session daemon. Node forks the whole calling process
 * to start a command, so this small process does it instead of the daemon.
 */
function serveCommands(): void {
  const children = new Map<number, ChildProcess>();
  const reply = (response: HelperResponse): void => {
    // The daemon can exit before this process notices; without a callback a failed send is an uncaught error.
    if (process.connected) process.send?.(response, () => undefined);
  };
  // Once the daemon disconnects, this process exits after its commands and kill timers finish.
  process.on("message", (message: unknown) => {
    if (!isHelperRequest(message)) return;
    if (message.type === "terminate") {
      const child = children.get(message.id);
      if (child === undefined) return;
      killChildTree(child, "SIGTERM");
      // Descendants can outlive the command, so the group is killed even after it closes.
      setTimeout(() => {
        killChildTree(child, "SIGKILL");
      }, FORCE_KILL_GRACE_MS);
      return;
    }
    const child = startCommand(message.command, (outcome) => {
      children.delete(message.id);
      reply({ id: message.id, ...outcome });
    });
    if (child === undefined) return;
    children.set(message.id, child);
    // Lets the daemon kill the command if this process dies first.
    if (child.pid !== undefined) reply({ id: message.id, pid: child.pid });
  });
}

function startCommand(
  command: HelperCommand,
  settle: (outcome: { result: ServerPluginExecFileResult } | { error: SerializedSpawnError }) => void,
): ChildProcess | undefined {
  const stdout = new BoundedOutput(command.maxOutputBytes);
  const stderr = new BoundedOutput(command.maxOutputBytes);
  let child: ChildProcess;
  try {
    child = spawn(command.file, command.args, {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    settle({ error: serializeSpawnError(error) });
    return undefined;
  }
  child.stdout?.on("data", (chunk: unknown) => { stdout.append(chunk); });
  child.stderr?.on("data", (chunk: unknown) => { stderr.append(chunk); });
  // A failed spawn emits both events; the daemon settles on the first.
  child.once("error", (error) => { settle({ error: serializeSpawnError(error) }); });
  child.once("close", (exitCode, signal) => {
    settle({
      result: {
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      },
    });
  });
  return child;
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

function killChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

function serializeSpawnError(error: unknown): SerializedSpawnError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const serialized: SerializedSpawnError = { name: error.name, message: error.message };
  const code: unknown = Reflect.get(error, "code");
  const errno: unknown = Reflect.get(error, "errno");
  const syscall: unknown = Reflect.get(error, "syscall");
  const path: unknown = Reflect.get(error, "path");
  if (typeof code === "string") serialized.code = code;
  if (typeof errno === "number") serialized.errno = errno;
  if (typeof syscall === "string") serialized.syscall = syscall;
  if (typeof path === "string") serialized.path = path;
  return serialized;
}

function isHelperRequest(value: unknown): value is HelperRequest {
  if (typeof value !== "object" || value === null) return false;
  const type: unknown = Reflect.get(value, "type");
  const id: unknown = Reflect.get(value, "id");
  if (typeof id !== "number") return false;
  if (type === "terminate") return true;
  return type === "start" && typeof Reflect.get(value, "command") === "object";
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveCommands();
}
