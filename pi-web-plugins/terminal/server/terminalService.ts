import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerPluginNoticeInput } from "@jmfederico/pi-web/server-plugin-api";
import { isBunRuntime } from "@pi-web/src/server/diagnostics/bunRuntime.js";

const MAX_REPLAY_BUFFER = 200_000;

export type TerminalCommandRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface TerminalCommandRun {
  id: string;
  origin: string;
  projectId: string;
  workspaceId: string;
  terminalId: string;
  title: string;
  command: string;
  status: TerminalCommandRunStatus;
  exitCode?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata: Record<string, string>;
}

export interface TerminalCommandRunFilter {
  projectId?: string;
  workspaceId?: string;
  terminalId?: string;
  statuses?: TerminalCommandRunStatus[];
  metadata?: Record<string, string>;
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  name: string;
  createdAt: string;
  exited: boolean;
  exitCode?: number;
  commandRunId?: string;
}

export interface TerminalWorkspaceScope {
  projectId: string;
  workspaceId: string;
  cwd: string;
}

export interface CreateTerminalOptions extends TerminalWorkspaceScope {
  name?: string;
  cols?: number;
  rows?: number;
}

export interface RunTerminalCommandOptions extends TerminalWorkspaceScope {
  origin: string;
  title: string;
  command: string;
  metadata?: unknown;
  /** Private host-composition intent; never accepted from the paired browser protocol. */
  failureNotice?: TerminalCommandFailureNotice;
  cols?: number;
  rows?: number;
}

export interface TerminalActivitySink {
  updateTerminal(terminal: Pick<TerminalInfo, "id" | "cwd" | "exited">): void;
  removeTerminal(terminalId: string, cwd?: string): void;
}

export interface TerminalCommandFailureNotice {
  readonly message: string;
  readonly context: Readonly<Record<string, string>>;
}

/**
 * Abstract terminal backend that works on both Node.js (using node-pty)
 * and Bun (using Bun.spawn()).
 */
interface TerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitCode?: number) => void): void;
}

/**
 * Bun-specific terminal backend that uses Bun.spawn() instead of node-pty.
 * Pipes stdout and stderr as a single output stream, and provides a simple
 * stdin write interface. This is not a full PTY but sufficient for most
 * terminal operations in a Bun environment.
 */
class BunTerminalBackend implements TerminalBackend {
  private childProcess: ReturnType<typeof Bun.spawn> | null = null;
  private stdoutBuffer = new Set<string>();
  private stderrBuffer = new Set<string>();
  private stdoutHandler: ((data: string) => void) | null = null;
  private exitHandler: ((exitCode?: number) => void) | null = null;
  private stdoutClosed = false;
  private stderrClosed = false;
  private stdinClosed = false;
  private closed = false;

  constructor(private shell: string, private args: string[], private cwd: string) {
    this.spawnProcess();
  }

  private spawnProcess(): void {
    try {
      this.childProcess = Bun.spawn(
        [this.shell, ...this.args],
        {
          cwd: this.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
        }
      );
      this.handleOutput();
      this.handleExit();
    } catch (error) {
      this.closed = true;
      this.exitHandler?.(1);
      throw error;
    }
  }

  private handleOutput(): void {
    const stdout = this.childProcess?.stdout;
    if (stdout) {
      const reader = stdout.getReader();
      const read = (): void => {
        if (this.closed) return;
        reader.read().then(({ done, value }) => {
          if (done) {
            this.stdoutClosed = true;
            this.checkClosed();
            return;
          }
          const data = new TextDecoder().decode(value);
          this.stdoutBuffer.add(data);
          this.stdoutHandler?.(data);
          read();
        }).catch(() => {
          this.stdoutClosed = true;
          this.checkClosed();
        });
      };
      read();
    }

    const stderr = this.childProcess?.stderr;
    if (stderr) {
      const reader = stderr.getReader();
      const read = (): void => {
        if (this.closed) return;
        reader.read().then(({ done, value }) => {
          if (done) {
            this.stderrClosed = true;
            this.checkClosed();
            return;
          }
          const data = new TextDecoder().decode(value);
          this.stderrBuffer.add(data);
          this.stdoutHandler?.(data);
          read();
        }).catch(() => {
          this.stderrClosed = true;
          this.checkClosed();
        });
      };
      read();
    }
  }

  private handleExit(): void {
    this.childProcess?.onExit?.(() => {
      this.closed = true;
      this.exitHandler?.(this.childProcess?.exitCode);
    });
  }

  private checkClosed(): void {
    if (this.stdoutClosed && this.stderrClosed) {
      // Output streams closed, process may still be running
    }
  }

  write(data: string): void {
    if (this.closed || this.stdinClosed) return;
    try {
      const stdin = this.childProcess?.stdin;
      if (stdin) {
        stdin.write(new TextEncoder().encode(data));
      }
    } catch {
      this.stdinClosed = true;
    }
  }

  resize(_cols: number, _rows: number): void {
    // Bun.spawn() doesn't support terminal resizing the same way PTY does
    // This is a limitation of the Bun implementation
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.childProcess) {
      try {
        this.childProcess.kill();
      } catch {
        // Process may already be dead
      }
    }
    this.exitHandler?.(128 + 9); // SIGKILL signal number
  }

  onData(callback: (data: string) => void): void {
    this.stdoutHandler = callback;
  }

  onExit(callback: (exitCode?: number) => void): void {
    this.exitHandler = callback;
  }
}

/**
 * Node.js terminal backend that uses node-pty.
 * Loaded dynamically to avoid import errors in environments without node-pty.
 */
interface NodePtyTerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitCode?: number) => void): void;
}

async function loadNodePtyBackend(): Promise<NodePtyTerminalBackend | null> {
  try {
    const ptyModule = await import("node-pty");
    const pty = ptyModule.default ?? ptyModule;

    return {
      write: (data: string) => { pty.write?.(data); },
      resize: (cols: number, rows: number) => { pty.resize?.(cols, rows); },
      kill: () => { pty.kill?.(); },
      onData: (callback: (data: string) => void) => {
        // node-pty PTY objects have on onData
        // We'll use a different pattern - the caller wraps the spawn
        return () => { /* noop */ };
      },
      onExit: (callback: (exitCode?: number) => void) => {
        // node-pty PTY objects have on onExit
        return () => { /* noop */ };
      },
    };
  } catch {
    return null;
  }
}

// Terminal record that abstracts away the backend
interface TerminalRecord extends TerminalInfo, TerminalWorkspaceScope {
  backend: TerminalBackend | null;
  buffer: string;
  events: EventEmitter;
  commandRunId?: string;
  failureNotice?: TerminalCommandFailureNotice;
}

interface CreateTerminalBackendResult {
  backend: TerminalBackend;
  dispose?: () => void;
}

function createTerminalBackend(
  shell: string,
  args: string[],
  cwd: string,
): CreateTerminalBackendResult {
  if (isBunRuntime()) {
    return { backend: new BunTerminalBackend(shell, args, cwd) };
  }
  // Node.js path: load node-pty dynamically
  let spawned: pty.IPty | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ptyModule = require("node-pty");
    const pty = ptyModule.default ?? ptyModule;
    const ptyInstance = pty.spawn(shell, args, {
      name: "xterm-256color",
      cwd,
      cols: 100,
      rows: 30,
      env: terminalEnvironment(),
    });
    spawned = ptyInstance;
    return {
      backend: {
        write: (data: string) => { ptyInstance.write(data); },
        resize: (cols: number, rows: number) => { ptyInstance.resize(cols, rows); },
        kill: () => { ptyInstance.kill(); },
        onData: (callback: (data: string) => void) => { ptyInstance.onData(callback); },
        onExit: (callback: (exitCode?: number) => void) => { ptyInstance.onExit(callback); },
      },
      dispose: () => { ptyInstance.kill(); },
    };
  } catch {
    // node-pty failed to load (not available or native module broken)
    if (spawned) {
      spawned.kill();
    }
    // Fall through to error handling in createTerminal
    throw new Error("Terminal backend unavailable: node-pty is not installed or failed to load native module. Try reinstalling PI WEB or using a Bun runtime.");
  }
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly commandRuns = new Map<string, TerminalCommandRun>();
  private activitySink: TerminalActivitySink | undefined;
  private disposed = false;

  constructor(private readonly recordNotice?: (input: ServerPluginNoticeInput) => void) {}

  bindActivitySink(sink: TerminalActivitySink): void {
    if (this.activitySink !== undefined) throw new Error("Terminal activity sink is already bound");
    this.activitySink = sink;
  }

  list(scope: TerminalWorkspaceScope): TerminalInfo[] {
    validateScope(scope);
    return [...this.terminals.values()]
      .filter((terminal) => matchesScope(terminal, scope))
      .map(toInfo);
  }

  closeForCwd(cwd: string): void {
    if (cwd === "") throw new Error("cwd is required");
    for (const terminal of [...this.terminals.values()].filter((candidate) => candidate.cwd === cwd)) {
      this.closeRecord(terminal);
    }
  }

  create(options: CreateTerminalOptions): TerminalInfo {
    validateScope(options);
    const shell = process.env["SHELL"] ?? "/bin/bash";
    return this.createTerminal({ ...options, shellArgs: interactiveShellArgs(shell) });
  }

  runCommand(options: RunTerminalCommandOptions): TerminalCommandRun {
    validateCommandRunOptions(options);
    this.requireAvailable();
    const commandRunId = randomUUID();
    const terminalId = randomUUID();
    const createdAt = new Date().toISOString();
    const metadata = parseMetadata(options.metadata);
    const failureNotice = parseFailureNotice(options.failureNotice);
    if (failureNotice !== undefined && this.recordNotice === undefined) {
      throw new Error("Terminal command failure notices are unavailable");
    }
    const queued: TerminalCommandRun = {
      id: commandRunId,
      origin: options.origin,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      terminalId,
      title: options.title,
      command: options.command,
      status: "queued",
      createdAt,
      metadata,
    };
    const running: TerminalCommandRun = { ...queued, status: "running", startedAt: new Date().toISOString() };
    this.commandRuns.set(commandRunId, running);

    try {
      this.createTerminal({
        id: terminalId,
        projectId: options.projectId,
        workspaceId: options.workspaceId,
        cwd: options.cwd,
        name: options.title,
        ...(options.cols === undefined ? {} : { cols: options.cols }),
        ...(options.rows === undefined ? {} : { rows: options.rows }),
        shellArgs: ["-lc", commandRunShellScript(options.command)],
        commandRunId,
        ...(failureNotice === undefined ? {} : { failureNotice: failureNotice }),
      });
    } catch (error) {
      this.commandRuns.delete(commandRunId);
      throw error;
    }

    return copyCommandRun(this.commandRuns.get(commandRunId) ?? running);
  }

  listCommandRuns(filter: TerminalCommandRunFilter = {}): TerminalCommandRun[] {
    return [...this.commandRuns.values()]
      .filter((run) => matchesCommandRunFilter(run, filter))
      .map(copyCommandRun);
  }

  listCommandRunsForScope(scope: TerminalWorkspaceScope, filter: TerminalCommandRunFilter = {}): TerminalCommandRun[] {
    validateScope(scope);
    return this.listCommandRuns({ ...filter, projectId: scope.projectId, workspaceId: scope.workspaceId });
  }

  getCommandRun(runId: string): TerminalCommandRun | undefined {
    const run = this.commandRuns.get(runId);
    return run === undefined ? undefined : copyCommandRun(run);
  }

  getCommandRunForScope(scope: TerminalWorkspaceScope, runId: string): TerminalCommandRun | undefined {
    validateScope(scope);
    const run = this.getCommandRun(runId);
    return run?.projectId === scope.projectId && run.workspaceId === scope.workspaceId
      ? copyCommandRun(run)
      : undefined;
  }

  cancelCommandRun(runId: string): TerminalCommandRun {
    return this.cancelCommandRunRecord(this.requireCommandRun(runId));
  }

  cancelCommandRunForScope(scope: TerminalWorkspaceScope, runId: string): TerminalCommandRun {
    const run = this.getCommandRunForScope(scope, runId);
    if (run === undefined) throw new Error("Terminal command run not found in this workspace");
    return this.cancelCommandRunRecord(this.requireCommandRun(runId));
  }

  get(scope: TerminalWorkspaceScope, id: string): TerminalInfo | undefined {
    const terminal = this.terminals.get(id);
    return terminal === undefined || !matchesScope(terminal, scope) ? undefined : toInfo(terminal);
  }

  attach(
    scope: TerminalWorkspaceScope,
    id: string,
    handlers: { output(data: string, replay: boolean): void; exit(exitCode: number | undefined): void; closed?(): void },
  ): () => void {
    const terminal = this.requireScoped(scope, id);
    if (terminal.buffer !== "") handlers.output(terminal.buffer, true);
    if (terminal.exited) handlers.exit(terminal.exitCode);
    const onOutput = (data: string): void => { handlers.output(data, false); };
    const onExit = (exitCode: number | undefined): void => { handlers.exit(exitCode); };
    const onClosed = (): void => { handlers.closed?.(); };
    terminal.events.on("output", onOutput);
    terminal.events.on("exit", onExit);
    terminal.events.on("closed", onClosed);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      terminal.events.off("output", onOutput);
      terminal.events.off("exit", onExit);
      terminal.events.off("closed", onClosed);
    };
  }

  write(scope: TerminalWorkspaceScope, id: string, data: string): void {
    const terminal = this.requireScoped(scope, id);
    if (!terminal.exited && terminal.backend) terminal.backend.write(data);
  }

  resize(scope: TerminalWorkspaceScope, id: string, cols: number, rows: number): void {
    const terminal = this.requireScoped(scope, id);
    if (!terminal.exited && terminal.backend && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
      terminal.backend.resize(Math.floor(cols), Math.floor(rows));
    }
  }

  continue(scope: TerminalWorkspaceScope, id: string): TerminalInfo {
    const record = this.requireScoped(scope, id);
    if (!record.exited) return toInfo(record);
    delete record.exitCode;
    delete record.commandRunId;
    record.exited = false;
    const marker = "\r\n[continued in interactive shell]\r\n";
    record.buffer = trimReplayBuffer(record.buffer + marker);
    record.events.emit("output", marker);
    const shell = process.env["SHELL"] ?? "/bin/bash";
    try {
      const backend = createTerminalBackend(shell, interactiveShellArgs(shell), record.cwd);
      record.backend = backend.backend;
      this.attachTerminalEvents(record);
    } catch {
      // Terminal backend unavailable (e.g., node-pty not installed)
      throw new Error("Terminal backend unavailable: cannot create PTY");
    }
    const info = toInfo(record);
    this.activitySink?.updateTerminal(info);
    return info;
  }

  closeAll(scope: TerminalWorkspaceScope): void {
    validateScope(scope);
    for (const terminal of [...this.terminals.values()].filter((candidate) => matchesScope(candidate, scope))) {
      this.closeRecord(terminal);
    }
  }

  close(scope: TerminalWorkspaceScope, id: string): void {
    validateScope(scope);
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return;
    if (!matchesScope(terminal, scope)) throw new Error("Terminal not found in this workspace");
    this.closeRecord(terminal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const terminal of [...this.terminals.values()]) this.closeRecord(terminal);
  }

  private createTerminal(options: CreateTerminalOptions & { id?: string; shellArgs: string[]; commandRunId?: string; failureNotice?: TerminalCommandFailureNotice }): TerminalInfo {
    this.requireAvailable();
    validateScope(options);
    const id = options.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const shell = process.env["SHELL"] ?? "/bin/bash";
    
    let backend: TerminalBackend | null = null;
    try {
      const result = createTerminalBackend(shell, options.shellArgs, options.cwd);
      backend = result.backend;
    } catch (error) {
      // Terminal backend unavailable (e.g., node-pty not installed)
      throw new Error(`Terminal backend unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const requestedName = options.name?.trim();
    const record: TerminalRecord = {
      id,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      name: requestedName !== undefined && requestedName !== "" ? requestedName : `Shell ${String(this.list(options).length + 1)}`,
      createdAt,
      exited: false,
      backend,
      buffer: "",
      events: new EventEmitter(),
      ...(options.commandRunId === undefined ? {} : { commandRunId: options.commandRunId }),
      ...(options.failureNotice === undefined ? {} : { failureNotice: options.failureNotice }),
    };
    this.attachTerminalEvents(record);
    this.terminals.set(id, record);
    const info = toInfo(record);
    this.activitySink?.updateTerminal(info);
    return info;
  }

  private attachTerminalEvents(record: TerminalRecord): void {
    if (!record.backend) return;
    
    record.backend.onData((data) => {
      record.buffer = trimReplayBuffer(record.buffer + data);
      record.events.emit("output", data);
    });
    record.backend.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitCode = exitCode;
      this.completeCommandRun(record.commandRunId, exitCode, record.failureNotice);
      record.events.emit("exit", exitCode);
      const info = toInfo(record);
      this.activitySink?.updateTerminal(info);
    });
  }

  private completeCommandRun(
    runId: string | undefined,
    exitCode: number | undefined,
    failureNotice: TerminalCommandFailureNotice | undefined,
  ): void {
    if (runId === undefined) return;
    const run = this.commandRuns.get(runId);
    if (run === undefined || isTerminalCommandRunFinal(run.status)) return;
    const completed: TerminalCommandRun = {
      ...run,
      status: exitCode === 0 ? "succeeded" : "failed",
      ...(exitCode === undefined ? {} : { exitCode }),
      completedAt: new Date().toISOString(),
    };
    this.commandRuns.set(runId, completed);
    if (!this.disposed && completed.status === "failed" && failureNotice !== undefined) {
      this.recordNotice?.({
        severity: "error",
        message: failureNotice.message,
        scope: { projectId: completed.projectId },
        context: { ...failureNotice.context, commandRunId: completed.id },
      });
    }
  }

  private requireScoped(scope: TerminalWorkspaceScope, id: string): TerminalRecord {
    validateScope(scope);
    const terminal = this.terminals.get(id);
    if (terminal === undefined || !matchesScope(terminal, scope)) {
      throw new Error("Terminal not found in this workspace");
    }
    return terminal;
  }

  private requireCommandRun(runId: string): TerminalCommandRun {
    const run = this.commandRuns.get(runId);
    if (run === undefined) throw new Error("Terminal command run not found");
    return run;
  }

  private cancelCommandRunRecord(run: TerminalCommandRun): TerminalCommandRun {
    if (isTerminalCommandRunFinal(run.status)) return copyCommandRun(run);
    const terminal = this.terminals.get(run.terminalId);
    if (terminal === undefined) throw new Error("Terminal not found");
    if (!terminal.exited && terminal.backend) terminal.backend.write("\x03");
    return copyCommandRun(run);
  }

  private closeRecord(terminal: TerminalRecord): void {
    if (!this.terminals.delete(terminal.id)) return;
    terminal.events.emit("closed");
    terminal.events.removeAllListeners();
    this.activitySink?.removeTerminal(terminal.id, terminal.cwd);
    if (!terminal.exited && terminal.backend) terminal.backend.kill();
  }

  private requireAvailable(): void {
    if (this.disposed) throw new Error("Terminal service is stopped");
  }
}

function toInfo(record: TerminalRecord): TerminalInfo {
  return {
    id: record.id,
    cwd: record.cwd,
    name: record.name,
    createdAt: record.createdAt,
    exited: record.exited,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.commandRunId === undefined ? {} : { commandRunId: record.commandRunId }),
  };
}

function trimReplayBuffer(buffer: string): string {
  if (buffer.length <= MAX_REPLAY_BUFFER) return buffer;
  return buffer.slice(buffer.length - MAX_REPLAY_BUFFER);
}

export function interactiveShellArgs(shell: string): string[] {
  const executable = shell.split(/[\\/]/).at(-1)?.toLowerCase().replace(/^-/, "").replace(/\.exe$/, "");
  // Preserve the existing invocation for arbitrary SHELL values rather than guessing at an unsupported login flag.
  return executable === "bash" || executable === "zsh" || executable === "fish" ? ["-l"] : [];
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, TERM: "xterm-256color", PI_WEB_TERMINAL: "1" };
}

function commandRunShellScript(command: string): string {
  return `printf '%s\\n' ${shellQuote(`$ ${command}`)}\n${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateScope(scope: TerminalWorkspaceScope): void {
  if (scope.projectId.trim() === "") throw new Error("projectId is required");
  if (scope.workspaceId.trim() === "") throw new Error("workspaceId is required");
  if (scope.cwd.trim() === "") throw new Error("cwd is required");
}

function matchesScope(record: TerminalWorkspaceScope, scope: TerminalWorkspaceScope): boolean {
  return record.projectId === scope.projectId
    && record.workspaceId === scope.workspaceId
    && record.cwd === scope.cwd;
}

function validateCommandRunOptions(options: RunTerminalCommandOptions): void {
  validateScope(options);
  if (options.origin.trim() === "") throw new Error("origin is required");
  if (options.title.trim() === "") throw new Error("title is required");
  if (options.command.trim() === "") throw new Error("command is required");
  parseMetadata(options.metadata);
}

function parseMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("metadata must be an object");
  return Object.fromEntries(Object.entries(value).map(([key, metadataValue]) => {
    if (key.trim() === "") throw new Error("metadata keys must not be empty");
    if (typeof metadataValue !== "string") throw new Error("metadata values must be strings");
    return [key, metadataValue];
  }));
}

function parseFailureNotice(value: TerminalCommandFailureNotice | undefined): TerminalCommandFailureNotice | undefined {
  if (value === undefined) return undefined;
  if (typeof value.message !== "string" || value.message.trim() === "") {
    throw new Error("failureNotice message must be a non-empty string");
  }
  if (!isRecord(value.context) || !Object.values(value.context).every((item) => typeof item === "string")) {
    throw new Error("failureNotice context must contain only strings");
  }
  return Object.freeze({ message: value.message, context: Object.freeze({ ...value.context }) });
}

function matchesCommandRunFilter(run: TerminalCommandRun, filter: TerminalCommandRunFilter): boolean {
  if (filter.projectId !== undefined && run.projectId !== filter.projectId) return false;
  if (filter.workspaceId !== undefined && run.workspaceId !== filter.workspaceId) return false;
  if (filter.terminalId !== undefined && run.terminalId !== filter.terminalId) return false;
  if (filter.statuses !== undefined && filter.statuses.length > 0 && !filter.statuses.includes(run.status)) return false;
  for (const [key, value] of Object.entries(filter.metadata ?? {})) {
    if (run.metadata[key] !== value) return false;
  }
  return true;
}

function isTerminalCommandRunFinal(status: TerminalCommandRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

function copyCommandRun(run: TerminalCommandRun): TerminalCommandRun {
  return { ...run, metadata: { ...run.metadata } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}