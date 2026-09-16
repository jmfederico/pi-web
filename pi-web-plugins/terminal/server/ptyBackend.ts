import { randomUUID } from "node:crypto";
import { loadNodePtyModule, type NodePtyModule, type NodePtyProcess } from "./nodePtyModule.js";
import { bunTerminalCapability, isBunRuntime } from "./ptyRuntime.js";

/**
 * PTY backend abstraction for the bundled Terminal plugin (Strategy pattern).
 *
 * Two engines implement it:
 * - `BunPTYBackend`: Bun's native `Bun.Terminal` + `Bun.spawn`. Preferred under Bun —
 *   node-pty cannot serve a Bun runtime at all (see `ptyRuntime.ts`), and the native engine
 *   needs no node-gyp build, no trusted-installs step, and nothing to fail silently at install.
 * - `NodePTYBackend`: node-pty, lazily loaded so a missing or unbuilt optional binding is an
 *   explicit per-terminal error instead of a fatal plugin import failure (the r1 daemon crash
 *   class).
 */

export interface TerminalBackendSpawnOptions {
  cwd: string;
  shell: string;
  shellArgs: string[];
  cols?: number;
  rows?: number;
  env: NodeJS.ProcessEnv;
}

export interface TerminalBackendAttachHandlers {
  output(data: string): void;
  exit(exitCode: number | undefined): void;
}

export interface TerminalBackend {
  available(): boolean;
  /** Spawns one PTY-backed shell and returns its backend-scoped id. */
  create(options: TerminalBackendSpawnOptions): { id: string };
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  /** Registers the single output/exit wiring for a live terminal; returns a detach function. */
  attach(id: string, handlers: TerminalBackendAttachHandlers): () => void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createDefaultBackend(): TerminalBackend {
  const bunBackend = new BunPTYBackend();
  if (bunBackend.available()) return bunBackend;
  // A Bun without Bun.Terminal still gets the node backend: node-pty may be absent there, but
  // that surfaces as an explicit unavailable error instead of a silently dead terminal. It is
  // never the Bun PTY engine — see `ptyRuntime.ts` for why (oven-sh/bun#25822).
  return new NodePTYBackend();
}

/* ------------------------------------------------------------------ */
/*  BunPTYBackend                                                      */
/* ------------------------------------------------------------------ */

interface BunTerminalHandle {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunSubprocessHandle {
  kill(signal?: string | number): void;
  onExit(cb: (code: number | null) => void): void;
}

interface BunTerminalOptions {
  cols?: number;
  rows?: number;
  name?: string;
  data?: (terminal: BunTerminalHandle, data: Uint8Array) => void;
  exit?: (terminal: BunTerminalHandle, exitCode: number, signal: string | null) => void;
  drain?: (terminal: BunTerminalHandle) => void;
}

interface BunSpawnOptions {
  terminal?: BunTerminalHandle;
  /** See the `detached: true` call site — it is what gives the shell the PTY session. */
  detached?: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
  onExit?: (subprocess: BunSubprocessHandle, exitCode: number | null, signal: string | null) => void;
}

interface BunGlobal {
  spawn: (cmd: string[], opts: BunSpawnOptions) => BunSubprocessHandle;
  Terminal: new (options: BunTerminalOptions) => BunTerminalHandle;
}

interface BunTerminalEntry {
  terminal: BunTerminalHandle;
  subprocess: BunSubprocessHandle;
  handlers: TerminalBackendAttachHandlers | null;
  /** Streaming decoder so multi-byte UTF-8 sequences split across data chunks are not corrupted. */
  decoder: TextDecoder;
}

export class BunPTYBackend implements TerminalBackend {
  private readonly terminals = new Map<string, BunTerminalEntry>();
  private disposed = false;

  available(): boolean {
    // Capability, not version: Bun.spawn alone cannot drive a PTY.
    return isBunRuntime() && bunTerminalCapability();
  }

  create(options: TerminalBackendSpawnOptions): { id: string } {
    const Bun = bunGlobal();
    const id = randomUUID();
    const terminal = new Bun.Terminal({
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      name: "xterm-256color",
      data: (_term, data: Uint8Array) => {
        const entry = this.terminals.get(id);
        if (entry?.handlers) {
          entry.handlers.output(entry.decoder.decode(data, { stream: true }));
        }
      },
    });

    // The terminal is ours, not the spawn's: if the child never starts (missing shell, bad cwd),
    // close it here or its master fd leaks for the daemon's lifetime.
    let subprocess: BunSubprocessHandle;
    try {
      subprocess = Bun.spawn([options.shell, ...options.shellArgs], {
        terminal,
        // `detached` (setsid) is what gives the shell a controlling terminal on the PTY, not just
        // stdio wires: without it the shell keeps the daemon's session (`TTY ?`), bash logs
        // "cannot set terminal process group … no job control", and ^C never reaches the
        // foreground process group. Upstream gap for pre-created terminals: oven-sh/bun#33240
        // (open) — the inline `terminal: { … }` spawn form already sessions correctly, only the
        // existing-`Bun.Terminal` form skips `setsid()` + `TIOCSCTTY`. Probed on bun 1.4.0
        // Linux/x64 with `detached: true`: bash reports PID == PGID == SID on a pts/N, `stty
        // size` tracks resize, and SIGKILLing the daemon delivers SIGHUP through the closed
        // master. Re-run that probe when #33240 closes; the flag stays harmless either way.
        detached: true,
        cwd: options.cwd,
        env: { ...options.env },
        onExit: (_sub, exitCode) => {
          const entry = this.terminals.get(id);
          if (entry?.handlers) {
            entry.handlers.exit(exitCode ?? undefined);
          }
          // Release the entry once the spawned process is gone so exited terminals do not
          // accumulate for the lifetime of the service.
          this.terminals.delete(id);
        },
      });
    } catch (error) {
      terminal.close();
      throw error;
    }

    this.terminals.set(id, { terminal, subprocess, handlers: null, decoder: new TextDecoder() });
    return { id };
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.terminal.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.subprocess.kill("SIGKILL");
      entry.terminal.close();
    }
    // The subprocess exit handler also deletes the entry; deleting here covers the
    // closed-without-exit path and the idempotent re-delete is harmless.
    // Upstream: oven-sh/bun#40289 (and the drain-order variant #35851) report the PTY exit
    // callback not firing spontaneously after a voluntary child exit on Linux. Probed on bun
    // 1.4.1 Linux/x64 with `sh -c 'exit 3'`, both with and without awaiting `proc.exited`:
    // `onExit` fired (~3ms). Re-run that probe when either issue closes; until then keep this
    // delete as the guaranteed release path rather than trusting the callback alone.
    this.terminals.delete(id);
  }

  attach(id: string, handlers: TerminalBackendAttachHandlers): () => void {
    const entry = this.terminals.get(id);
    if (entry === undefined) return () => undefined;
    entry.handlers = handlers;
    return () => {
      if (entry.handlers === handlers) entry.handlers = null;
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.terminals.values()) {
      try {
        entry.subprocess.kill("SIGKILL");
        entry.terminal.close();
      } catch {
        // ignore dispose errors
      }
    }
    this.terminals.clear();
  }
}

function bunGlobal(): BunGlobal {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const Bun = (globalThis as Record<string, unknown>)["Bun"] as BunGlobal | undefined;
  if (Bun === undefined || typeof Bun.spawn !== "function" || typeof Bun.Terminal !== "function") {
    throw new Error("Bun.Terminal is not available in this runtime");
  }
  return Bun;
}

/* ------------------------------------------------------------------ */
/*  NodePTYBackend                                                     */
/* ------------------------------------------------------------------ */

interface NodeTerminalEntry {
  process: NodePtyProcess;
  handlers: TerminalBackendAttachHandlers | null;
}

export class NodePTYBackend implements TerminalBackend {
  private readonly terminals = new Map<string, NodeTerminalEntry>();
  private pty: NodePtyModule | null;

  constructor(ptyModule?: NodePtyModule, loadModule: () => NodePtyModule = loadNodePtyModule) {
    if (ptyModule !== undefined) {
      this.pty = ptyModule;
      return;
    }
    try {
      this.pty = loadModule();
    } catch {
      // The binding is optional: an explicit unavailable error at create time is the contract.
      this.pty = null;
    }
  }

  available(): boolean {
    return this.pty !== null;
  }

  create(options: TerminalBackendSpawnOptions): { id: string } {
    if (this.pty === null) {
      throw new Error(
        "The node-pty native binding is not available, so the Terminal backend cannot spawn a PTY."
        + " Reinstall with the trusted native build: npm install -g @jmfederico/pi-web --allow-scripts=node-pty."
        + " Bun installs use the native Bun.Terminal engine and never need node-pty.",
      );
    }
    const id = randomUUID();
    const ptyProcess = this.pty.spawn(options.shell, options.shellArgs, {
      name: "xterm-256color",
      cwd: options.cwd,
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      env: { ...options.env },
    });
    ptyProcess.onData((data) => {
      const entry = this.terminals.get(id);
      if (entry?.handlers) entry.handlers.output(data);
    });
    ptyProcess.onExit(({ exitCode }) => {
      const entry = this.terminals.get(id);
      if (entry?.handlers) entry.handlers.exit(exitCode);
      // Release the entry once the process is gone so exited terminals do not accumulate.
      this.terminals.delete(id);
    });
    this.terminals.set(id, { process: ptyProcess, handlers: null });
    return { id };
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.process.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.terminals.get(id)?.process.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (entry) entry.process.kill("SIGKILL");
    // The proc exit event also deletes the entry; deleting here covers the
    // closed-without-exit path and the idempotent re-delete is harmless.
    this.terminals.delete(id);
  }

  attach(id: string, handlers: TerminalBackendAttachHandlers): () => void {
    const entry = this.terminals.get(id);
    if (entry === undefined) return () => undefined;
    entry.handlers = handlers;
    return () => {
      if (entry.handlers === handlers) entry.handlers = null;
    };
  }

  dispose(): void {
    for (const entry of this.terminals.values()) {
      try {
        entry.process.kill("SIGKILL");
      } catch {
        // ignore dispose errors
      }
    }
    this.terminals.clear();
  }
}
