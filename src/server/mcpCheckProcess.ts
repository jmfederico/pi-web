import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "../server-plugin-api.js";
import { MCP_CHECK_OWNER_ENV } from "./mcpCheckBootstrap.js";

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const CLEANUP_ROUNDS = 10;

interface ProcessEntry { pid: number; parent: number; identity: string; owned: boolean }
interface WindowsRoot { before: number; after: number }

/**
 * Process groups/ancestry alone lose ownership when a wrapper exits and a helper
 * reparents in another group. Each check has a unique inherited environment marker.
 * POSIX cleanup inventories that marker, then verifies identities before signaling
 * individual processes (never an unverified or shared group). Windows has no
 * equivalent environment inventory here; it uses timestamp-bounded ancestry.
 */
export function executeMcpCheck(request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult> {
  if (request.signal.aborted) return Promise.reject(asError(request.signal.reason));
  return new Promise((resolve, reject) => {
    const owner = `${MCP_CHECK_OWNER_ENV}=${randomUUID()}`;
    const before = Date.now();
    const child = spawn(request.file, [...request.args ?? []], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env, [MCP_CHECK_OWNER_ENV]: owner.slice(MCP_CHECK_OWNER_ENV.length + 1) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let settled = false;
    const roots = new Map<number, WindowsRoot>();
    if (child.pid !== undefined) roots.set(child.pid, { before, after: Date.now() });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const type: unknown = Reflect.get(message, "type");
      const pid: unknown = Reflect.get(message, "pid");
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
      if (type === "mcp.check.spawn") {
        const before: unknown = Reflect.get(message, "before");
        const after: unknown = Reflect.get(message, "after");
        if (typeof before === "number" && typeof after === "number" && Number.isSafeInteger(before) && Number.isSafeInteger(after) && before <= after) {
          roots.set(pid, { before, after });
        }
      }
    });
    const stdout = boundedOutput();
    const stderr = boundedOutput();
    const cleanup = (): void => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(asError(error));
    };
    const terminate = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void stopOwnedProcesses(owner, roots, true).then(() => { reject(asError(error)); }, (cleanupError: unknown) => {
        reject(new AggregateError([error, cleanupError], "Could not completely stop the MCP connection check"));
      });
    };
    const abort = (): void => { terminate(request.signal.reason); };
    const timeout = setTimeout(() => { terminate(new Error("MCP connection check timed out")); }, request.timeoutMs ?? 90_000);
    timeout.unref();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout?.on("data", stdout.append);
    child.stderr?.on("data", stderr.append);
    child.once("error", fail);
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = { exitCode, signal, stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated(), stderrTruncated: stderr.truncated() };
      // Completion is a cleanup boundary even when all original parents/groups
      // have already disappeared. Do not resolve a successful report first.
      void stopOwnedProcesses(owner, roots, false).then(() => { resolve(result); }, (error: unknown) => { reject(asError(error)); });
    });
  });
}

async function stopOwnedProcesses(owner: string, roots: ReadonlyMap<number, WindowsRoot>, graceful: boolean): Promise<void> {
  const owned = new Map<number, ProcessEntry>();
  // Freeze all marked POSIX processes before signaling, not just the CLI. Repeat
  // the inventory to catch forks between the first snapshot and SIGSTOP. Bounds
  // prevent an actively forking server from hanging cleanup indefinitely.
  const freeze = async (): Promise<void> => {
    const stopped = new Map<number, string>();
    for (let round = 0; round < CLEANUP_ROUNDS; round++) {
      const entries = await processEntries(owner);
      const live = process.platform === "win32" ? windowsOwnedEntries(entries, roots, owned) : posixOwnedEntries(entries, owned);
      const added = live.filter((entry) => stopped.get(entry.pid) !== entry.identity);
      if (added.length === 0) return;
      for (const entry of added) owned.set(entry.pid, entry);
      if (process.platform !== "win32") await signalOwnedProcesses(added, owner, "SIGSTOP");
      for (const entry of added) stopped.set(entry.pid, entry.identity);
    }
    throw new Error("MCP processes kept spawning during cleanup");
  };
  const errors: Error[] = [];
  try {
    await freeze();
    if (graceful && owned.size > 0 && process.platform !== "win32") {
      await signalOwnedProcesses([...owned.values()], owner, "SIGTERM");
      await signalOwnedProcesses([...owned.values()], owner, "SIGCONT");
      // Keep escalation alive even during daemon shutdown.
      await new Promise<void>((resolve) => { setTimeout(resolve, KILL_GRACE_MS); });
      await freeze();
    }
  } catch (error) {
    errors.push(asError(error));
  }
  // Also release frozen processes if a later inventory fails. Every signal is
  // identity-checked; retained numeric PIDs alone never authorize a kill.
  try { await signalOwnedProcesses([...owned.values()], owner, "SIGKILL"); }
  catch (error) { errors.push(asError(error)); }
  if (errors.length > 0) throw new AggregateError(errors, "Could not clean up MCP processes");
}

async function signalOwnedProcesses(entries: readonly ProcessEntry[], owner: string, signal: NodeJS.Signals): Promise<void> {
  if (entries.length === 0) return;
  const current = new Map((await processEntries(owner, entries.map((entry) => entry.pid))).map((entry) => [entry.pid, entry]));
  const live = entries.filter((entry) => {
    const now = current.get(entry.pid);
    return now?.identity === entry.identity;
  });
  if (process.platform === "win32") {
    if (live.length > 0) {
      // Do not use /T: it would include descendants not validated in the snapshot.
      await promisify(execFile)("taskkill", [...live.flatMap((entry) => ["/pid", String(entry.pid)]), "/F"], { timeout: 5_000 });
    }
    return;
  }
  const errors: Error[] = [];
  for (const entry of live) {
    try { signalProcess(entry.pid, signal); }
    catch (error) { errors.push(asError(error)); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not signal all owned MCP processes");
}

function posixOwnedEntries(entries: readonly ProcessEntry[], known: ReadonlyMap<number, ProcessEntry>): ProcessEntry[] {
  const owned = new Set(entries.filter((entry) => entry.owned || known.get(entry.pid)?.identity === entry.identity).map((entry) => entry.pid));
  // Also retain the existing tree-cleanup contract for children launched with a
  // cleared env while their ancestry is still present. Never seed stale PIDs.
  let added = true;
  while (added) {
    added = false;
    for (const entry of entries) {
      if (owned.has(entry.parent) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        added = true;
      }
    }
  }
  return entries.filter((entry) => owned.has(entry.pid));
}

function windowsOwnedEntries(entries: readonly ProcessEntry[], roots: ReadonlyMap<number, WindowsRoot>, known: ReadonlyMap<number, ProcessEntry>): ProcessEntry[] {
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const owned = new Set(entries.filter((entry) => {
    if (known.get(entry.pid)?.identity === entry.identity) return true;
    const root = roots.get(entry.pid);
    const created = Number(entry.identity);
    return root !== undefined && created >= root.before && created <= root.after;
  }).map((entry) => entry.pid));
  // Windows retains ParentProcessId after exit, but an exited parent's PID can
  // have been reused. Only live, creation-matched roots or previously observed
  // identities authorize discovery; vanished ancestry is a best-effort limit.
  let added = true;
  while (added) {
    added = false;
    for (const entry of entries) {
      const parent = byPid.get(entry.parent);
      if (parent !== undefined && owned.has(parent.pid) && Number(entry.identity) >= Number(parent.identity) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        added = true;
      }
    }
  }
  return entries.filter((entry) => owned.has(entry.pid));
}

async function processEntries(owner: string, pids?: readonly number[]): Promise<ProcessEntry[]> {
  if (process.platform === "win32") {
    const filter = pids === undefined ? "ProcessId > 0" : pids.map((pid) => `ProcessId = ${String(pid)}`).join(" OR ");
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId, ParentProcessId, @{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`], { timeout: 5_000, maxBuffer: OUTPUT_LIMIT_BYTES });
    if (stdout.trim() === "") return [];
    const value: unknown = JSON.parse(stdout);
    const records: unknown[] = Array.isArray(value) ? value : [value];
    return records.map((entry) => {
      if (typeof entry !== "object" || entry === null) throw new Error("Invalid process inventory");
      const pid: unknown = Reflect.get(entry, "ProcessId");
      const parent: unknown = Reflect.get(entry, "ParentProcessId");
      const created: unknown = Reflect.get(entry, "Created");
      if (typeof pid !== "number" || typeof parent !== "number" || !Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)
        || typeof created !== "string" || !Number.isFinite(Date.parse(created))) throw new Error("Invalid process inventory");
      return { pid, parent, identity: String(Date.parse(created)), owned: false };
    });
  }
  if (process.platform !== "linux") {
    // macOS ps exposes inherited environments with -E and untruncated -ww.
    // Require the complete unique assignment, not a partial token match.
    const selection = pids === undefined ? ["-A"] : ["-p", pids.join(",")];
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)("ps", [...selection, "-ww", "-E", "-o", "pid=,ppid=,lstart=,command="], { timeout: 5_000, maxBuffer: OUTPUT_LIMIT_BYTES }));
    } catch (error) {
      // ps returns 1 when a targeted selection has already exited.
      if (pids !== undefined && error instanceof Error && Reflect.get(error, "code") === 1 && String(Reflect.get(error, "stdout")).trim() === "") return [];
      throw error;
    }
    return stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/u.exec(line);
      if (match === null) return [];
      return [{ pid: Number(match[1]), parent: Number(match[2]), identity: match[3] ?? "", owned: ` ${match[4] ?? ""} `.includes(` ${owner} `) }];
    });
  }
  // /proc works in minimal Linux images without requiring ps. The marker
  // survives reparenting/setsid, unlike PPID/PGID. Birth identity guards PID reuse.
  const names = pids === undefined ? (await readdir("/proc")).filter((name) => /^\d+$/u.test(name)) : pids.map(String);
  const entries = await Promise.all(names.map(async (name): Promise<ProcessEntry | undefined> => {
    try {
      const text = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return undefined;
      const identity = fields[19];
      const parent = Number(fields[1]);
      if (identity === undefined || !/^\d+$/u.test(identity) || !Number.isSafeInteger(parent) || parent < 0) throw new Error("Invalid process inventory");
      const environment = await readFile(`/proc/${name}/environ`, "utf8");
      return { pid: Number(name), parent, identity, owned: environment.split("\0").includes(owner) };
    } catch (error) {
      // Processes may exit during a snapshot; hidepid can hide other users.
      if (error instanceof Error && ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(String(Reflect.get(error, "code")))) return undefined;
      throw error;
    }
  }));
  return entries.filter((entry) => entry !== undefined);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal); } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ESRCH") throw error;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("MCP connection check failed", { cause: value });
}

function boundedOutput() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    append: (value: unknown): void => {
      if (!Buffer.isBuffer(value)) return;
      const remaining = OUTPUT_LIMIT_BYTES - bytes;
      if (value.length > remaining) truncated = true;
      if (remaining > 0) {
        const chunk = value.subarray(0, remaining);
        chunks.push(chunk);
        bytes += chunk.length;
      }
    },
    text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    truncated: () => truncated,
  };
}
