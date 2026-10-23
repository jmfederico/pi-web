import type { PtyProvider } from "./ptyProvider.js";

export interface BunTerminalHandle {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface BunPtyRuntime {
  Terminal: new (...args: never[]) => BunTerminalHandle;
  spawn(command: string[], options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    terminal: {
      name: string;
      cols: number;
      rows: number;
      data(terminal: BunTerminalHandle, data: Uint8Array): void;
      exit(terminal: BunTerminalHandle): void;
    };
    onExit(child: unknown, exitCode: number | null): void;
  }): { terminal: BunTerminalHandle; kill(signal?: string): void };
}

function isBunPtyRuntime(value: unknown): value is BunPtyRuntime {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "Terminal") === "function"
    && typeof Reflect.get(value, "spawn") === "function";
}

export function inspectBunPtyCapability(): { supported: boolean; reason?: string } {
  return isBunPtyRuntime(Reflect.get(globalThis, "Bun"))
    ? { supported: true }
    : { supported: false, reason: "Bun native Terminal and spawn APIs are required; upgrade Bun to use terminals" };
}

function requireBunPtyRuntime(runtime: unknown): BunPtyRuntime {
  if (!isBunPtyRuntime(runtime)) {
    throw new Error("Bun native Terminal and spawn APIs are required; upgrade Bun to use terminals (node-pty fallback is not supported)");
  }
  return runtime;
}

export function createBunPtyProvider(api: unknown = Reflect.get(globalThis, "Bun")): PtyProvider {
  const runtime = requireBunPtyRuntime(api);
  return {
    kind: "bun",
    spawn(options, handlers) {
      let disposed = false;
      let completed = false;
      let processExited = false;
      let streamClosed = false;
      let exitCode: number | undefined;
      const decoder = new TextDecoder();
      let terminal: BunTerminalHandle | undefined;
      let terminalReleased = false;
      const closeTerminal = (): void => {
        if (terminal === undefined || terminalReleased) return;
        terminalReleased = true;
        terminal.close();
      };
      const finish = (): void => {
        if (disposed || completed || !processExited || !streamClosed) return;
        completed = true;
        const tail = decoder.decode();
        try {
          if (tail !== "") handlers.output(tail);
        } finally {
          // The process exit code and PTY EOF are separate events in Bun.
          // Close only after EOF so queued final output is not truncated.
          closeTerminal();
        }
        handlers.exit(exitCode);
      };
      // Inline terminal options give the child a controlling terminal/session.
      // A pre-created reusable Bun.Terminal can keep its slave open past child exit.
      let child: ReturnType<BunPtyRuntime["spawn"]>;
      try {
        child = runtime.spawn([options.shell, ...options.args], {
          cwd: options.cwd,
          env: options.env,
          terminal: {
            name: "xterm-256color", cols: options.cols, rows: options.rows,
            data(handle, data) {
              terminal = handle;
              if (disposed || completed || streamClosed) return;
              const text = decoder.decode(data, { stream: true });
              if (text !== "") handlers.output(text);
            },
            exit(handle) {
              terminal = handle;
              streamClosed = true;
              finish();
            },
          },
          onExit(_child, code) {
            processExited = true;
            exitCode = code ?? undefined;
            finish();
          },
        });
      } catch (error) {
        disposed = true;
        closeTerminal();
        throw error;
      }
      terminal = child.terminal;
      return {
        write(data) { if (!disposed && !completed && !processExited) child.terminal.write(data); },
        resize(cols, rows) { if (!disposed && !completed && !processExited) child.terminal.resize(cols, rows); },
        dispose() {
          if (disposed) return;
          disposed = true;
          try {
            if (!processExited) child.kill("SIGKILL");
          } finally {
            closeTerminal();
          }
        },
      };
    },
  };
}
