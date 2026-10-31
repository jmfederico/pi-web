import { createRequire } from "node:module";
import type { IPty, spawn } from "node-pty";
import type { PtyProvider } from "./ptyProvider.js";
import { ensureNodePtySpawnHelper } from "./nodePtySpawnHelper.js";

type NodePtyProcess = Pick<IPty, "write" | "resize" | "kill" | "onData" | "onExit">;
interface NodePtyModule { spawn(...args: Parameters<typeof spawn>): NodePtyProcess }

function loadNodePty(): NodePtyModule {
  const require = createRequire(import.meta.url);
  const loaded: unknown = require("node-pty");
  if (!isNodePtyModule(loaded)) {
    throw new Error("node-pty does not expose spawn()");
  }
  ensureNodePtySpawnHelper(require);
  return loaded;
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "spawn") === "function";
}

export function inspectNodePtyCapability(): { supported: boolean; reason?: string } {
  try {
    loadNodePty();
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Native loading happens only on spawn or explicit inspection, never on import. */
export function createNodePtyProvider(load: () => NodePtyModule = loadNodePty): PtyProvider {
  return {
    kind: "node",
    spawn(options, handlers) {
      let module: NodePtyModule;
      try {
        module = load();
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`Terminal PTY unavailable: ${detail}`, { cause });
      }
      const child = module.spawn(options.shell, options.args, {
        name: "xterm-256color", cwd: options.cwd, cols: options.cols, rows: options.rows, env: options.env,
      });
      let disposed = false;
      const state: { exited: boolean; exitSubscription?: { dispose(): void } } = { exited: false };
      const dataSubscription = child.onData((data) => {
        if (!disposed && !state.exited) handlers.output(data);
      });
      state.exitSubscription = child.onExit(({ exitCode }) => {
        if (disposed || state.exited) return;
        state.exited = true;
        dataSubscription.dispose();
        state.exitSubscription?.dispose();
        // node-pty closes its master before publishing onExit.
        handlers.exit(exitCode);
      });
      if (state.exited) state.exitSubscription.dispose();
      return {
        write(data) { if (!disposed && !state.exited) child.write(data); },
        resize(cols, rows) { if (!disposed && !state.exited) child.resize(cols, rows); },
        dispose() {
          if (disposed) return;
          disposed = true;
          dataSubscription.dispose();
          state.exitSubscription?.dispose();
          if (!state.exited) child.kill();
        },
      };
    },
  };
}
