import type { TerminalInfo } from "../../shared/apiTypes.js";
import type { TerminalBackend } from "./backend.js";

export function createMockBackend(): TerminalBackend {
  const terminals = new Map<
    string,
    { id: string; info: TerminalInfo & { cols: number; rows: number } }
  >();
  const handlers = new Map<
    string,
    {
      output: (data: string, replay: boolean) => void;
      exit: (code: number | undefined) => void;
    }
  >();
  let nextId = 0;

  return {
    available(): boolean {
      return true;
    },

    create(options: {
      cwd: string;
      shell: string;
      shellArgs: string[];
      cols?: number;
      rows?: number;
      env: Record<string, string>;
    }): { id: string; info: TerminalInfo; cols: number; rows: number } {
      const id = `mock-term-${String(nextId)}`;
      nextId++;
      const info = {
        id,
        cwd: options.cwd,
        name: `Terminal ${id}`,
        createdAt: new Date().toISOString(),
        exited: false,
        env: options.env,
        cols: options.cols ?? 100,
        rows: options.rows ?? 30,
        shell: options.shell,
        shellArgs: options.shellArgs,
      };
      terminals.set(id, { id, info });
      // Simulate a command that exits immediately
      // (microtask so synchronous reads still see exited=false)
      queueMicrotask(() => {
        const handler = handlers.get(id);
        if (handler) {
          handler.exit(0);
        }
      });
      return { id, info, cols: options.cols ?? 100, rows: options.rows ?? 30 };
    },

    /* eslint-disable @typescript-eslint/no-unused-vars */
    write(_id: string, _data: string): void {
      // No-op for mock
    },

    resize(_id: string, _cols: number, _rows: number): void {
      // No-op for mock
    },
    /* eslint-enable @typescript-eslint/no-unused-vars */

    kill(id: string): void {
      const entry = terminals.get(id);
      if (entry) {
        entry.info.exited = true;
        entry.info.exitCode = 137;
        const handler = handlers.get(id);
        if (handler) {
          handler.exit(137);
        }
      }
    },

    attach(
      id: string,
      inputHandlers: {
        output: (data: string, replay: boolean) => void;
        exit: (code: number | undefined) => void;
      }
    ): () => void {
      handlers.set(id, inputHandlers);
      return () => {
        handlers.delete(id);
      };
    },

    get(id: string): TerminalInfo | undefined {
      return terminals.get(id)?.info;
    },

    dispose(): void {
      terminals.clear();
      handlers.clear();
    },
  };
}