import type { TerminalInfo } from "../../shared/apiTypes.js";

/* ------------------------------------------------------------------ */
/*  Interface                                                          */
/* ------------------------------------------------------------------ */

export interface TerminalBackend {
  available(): boolean;

  create(options: {
    cwd: string;
    shell: string;
    shellArgs: string[];
    cols?: number;
    rows?: number;
    env: Record<string, string>;
  }): { id: string; info: TerminalInfo; cols: number; rows: number };

  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;

  attach(
    id: string,
    handlers: {
      output: (data: string, replay: boolean) => void;
      exit: (code: number | undefined) => void;
    }
  ): () => void;

  get(id: string): TerminalInfo | undefined;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  Auto-detection                                                     */
/* ------------------------------------------------------------------ */

/** Check if the current runtime is Bun */
export function isBunRuntime(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/dot-notation, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const bun = (globalThis as any)["Bun"];
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof bun === "object" && bun !== null && "spawn" in bun && typeof (bun as Record<string, unknown>)["spawn"] === "function";
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createDefaultBackend(): TerminalBackend {
  if (isBunRuntime()) {
    return new BunPTYBackend();
  }
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
  cwd?: string;
  env?: Record<string, string>;
  onExit?: (subprocess: BunSubprocessHandle, exitCode: number | null, signal: string | null) => void;
}

interface BunGlobal {
  Terminal: new (options: BunTerminalOptions) => BunTerminalHandle;
  spawn: (cmd: string[], opts: BunSpawnOptions) => BunSubprocessHandle;
}

interface BunTerminalEntry {
  terminal: BunTerminalHandle;
  subprocess: BunSubprocessHandle;
  info: TerminalInfo & { cols: number; rows: number };
  outputCb: ((data: string, replay: boolean) => void) | null;
  exitCb: ((code: number | undefined) => void) | null;
  /** Streaming decoder so multi-byte UTF-8 sequences split across data chunks are not corrupted. */
  decoder: TextDecoder;
}

export class BunPTYBackend implements TerminalBackend {
  private terminals = new Map<string, BunTerminalEntry>();

  available(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/consistent-type-assertions, @typescript-eslint/dot-notation, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const bun = (globalThis as any)["Bun"];
    return typeof bun === "object" && bun !== null && "Terminal" in bun && "spawn" in bun;
  }

  create(options: {
    cwd: string;
    shell: string;
    shellArgs: string[];
    cols?: number;
    rows?: number;
    env: Record<string, string>;
  }): { id: string; info: TerminalInfo; cols: number; rows: number } {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const Bun = (globalThis as Record<string, unknown>)["Bun"] as BunGlobal;
    const id = crypto.randomUUID();
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;

    const terminal = new Bun.Terminal({
      cols,
      rows,
      name: "xterm-256color",
      data: (_term, data: Uint8Array) => {
        const entry = this.terminals.get(id);
        if (entry?.outputCb) {
          entry.outputCb(entry.decoder.decode(data, { stream: true }), false);
        }
      },
    });

    const subprocess = Bun.spawn([options.shell, ...options.shellArgs], {
      terminal,
      cwd: options.cwd,
      env: {
        ...options.env,
        PI_WEB_TERMINAL: "1",
        TERM: "xterm-256color",
      },
      onExit: (_sub, exitCode) => {
        const entry = this.terminals.get(id);
        if (entry?.exitCb) {
          entry.exitCb(exitCode ?? undefined);
        }
        // Release the entry once the spawned process is gone so exited
        // terminals do not accumulate for the lifetime of the service.
        this.terminals.delete(id);
      },
    });

    const info: TerminalInfo & { cols: number; rows: number } = {
      id,
      cwd: options.cwd,
      name: "Terminal",
      createdAt: new Date().toISOString(),
      exited: false,
      cols,
      rows,
    };

    this.terminals.set(id, {
      terminal,
      subprocess,
      info,
      outputCb: null,
      exitCb: null,
      decoder: new TextDecoder(),
    });

    return { id, info, cols, rows };
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    entry?.terminal.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    entry?.terminal.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.subprocess.kill("SIGKILL");
      entry.terminal.close();
      entry.info.exited = true;
    }
    // The subprocess exit handler also deletes the entry; deleting here covers
    // the closed-without-exit path and the idempotent re-delete is harmless.
    this.terminals.delete(id);
  }

  attach(
    id: string,
    handlers: {
      output: (data: string, replay: boolean) => void;
      exit: (code: number | undefined) => void;
    }
  ): () => void {
    const entry = this.terminals.get(id);
    if (!entry) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return () => {};
    }

    entry.outputCb = handlers.output;
    entry.exitCb = handlers.exit;

    return () => {
      if (entry.outputCb === handlers.output) entry.outputCb = null;
      if (entry.exitCb === handlers.exit) entry.exitCb = null;
    };
  }

  get(id: string): TerminalInfo | undefined {
    const entry = this.terminals.get(id);
    return entry?.info;
  }

  dispose(): void {
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

/* ------------------------------------------------------------------ */
/*  NodePTYBackend                                                     */
/* ------------------------------------------------------------------ */

interface NodePtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string | number): void;
  on(event: "data" | "exit", cb: (data: string | number | null) => void): void;
}

export interface NodePtyModule {
  spawn(
    shell: string,
    args: string[],
    options?: {
      name?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      env?: Record<string, string>;
    }
  ): NodePtyProcess;
}

interface NodeTerminalEntry {
  proc: NodePtyProcess;
  info: TerminalInfo & { cols: number; rows: number };
  outputCb: ((data: string, replay: boolean) => void) | null;
  exitCb: ((code: number | undefined) => void) | null;
}

export class NodePTYBackend implements TerminalBackend {
  private terminals = new Map<string, NodeTerminalEntry>();
  private pty: NodePtyModule | null;

  constructor(ptyModule?: NodePtyModule) {
    if (ptyModule) {
      this.pty = ptyModule;
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-assertions
        const pty = require("node-pty") as unknown as NodePtyModule;
        this.pty = pty;
      } catch {
        this.pty = null;
      }
    }
  }

  /** Override the pty module — useful for testing with mocks. Pass null to disable. */
  setPty(ptyModule: NodePtyModule | null): void {
    this.pty = ptyModule;
  }

  available(): boolean {
    return this.pty !== null;
  }

  create(options: {
    cwd: string;
    shell: string;
    shellArgs: string[];
    cols?: number;
    rows?: number;
    env: Record<string, string>;
  }): { id: string; info: TerminalInfo; cols: number; rows: number } {
    if (!this.pty) {
      throw new Error("node-pty module is not available");
    }

    const id = crypto.randomUUID();
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;

    const proc = this.pty.spawn(options.shell, options.shellArgs, {
      name: "xterm-256color",
      cwd: options.cwd,
      cols,
      rows,
      env: {
        ...options.env,
        PI_WEB_TERMINAL: "1",
        TERM: "xterm-256color",
      },
    });

    proc.on("data", (data: string | number | null) => {
      if (typeof data === "string") {
        const entry = this.terminals.get(id);
        if (entry?.outputCb) {
          entry.outputCb(data, false);
        }
      }
    });

    proc.on("exit", (exitCode: string | number | null) => {
      const code = typeof exitCode === "number" ? exitCode : undefined;
      const entry = this.terminals.get(id);
      if (entry?.exitCb) {
        entry.exitCb(code);
      }
      // Release the entry once the process is gone so exited terminals do not
      // accumulate for the lifetime of the service.
      this.terminals.delete(id);
    });

    const info: TerminalInfo & { cols: number; rows: number } = {
      id,
      cwd: options.cwd,
      name: "Terminal",
      createdAt: new Date().toISOString(),
      exited: false,
      cols,
      rows,
    };

    this.terminals.set(id, {
      proc,
      info,
      outputCb: null,
      exitCb: null,
    });

    return { id, info, cols, rows };
  }

  write(id: string, data: string): void {
    const entry = this.terminals.get(id);
    entry?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.terminals.get(id);
    entry?.proc.resize(cols, rows);
  }

  kill(id: string): void {
    const entry = this.terminals.get(id);
    if (entry) {
      entry.proc.kill("SIGKILL");
      entry.info.exited = true;
    }
    // The proc exit event also deletes the entry; deleting here covers the
    // closed-without-exit path and the idempotent re-delete is harmless.
    this.terminals.delete(id);
  }

  attach(
    id: string,
    handlers: {
      output: (data: string, replay: boolean) => void;
      exit: (code: number | undefined) => void;
    }
  ): () => void {
    const entry = this.terminals.get(id);
    if (!entry) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return () => {};
    }

    entry.outputCb = handlers.output;
    entry.exitCb = handlers.exit;

    return () => {
      if (entry.outputCb === handlers.output) entry.outputCb = null;
      if (entry.exitCb === handlers.exit) entry.exitCb = null;
    };
  }

  get(id: string): TerminalInfo | undefined {
    const entry = this.terminals.get(id);
    return entry?.info;
  }

  dispose(): void {
    for (const entry of this.terminals.values()) {
      try {
        entry.proc.kill("SIGKILL");
      } catch {
        // ignore dispose errors
      }
    }
    this.terminals.clear();
  }
}