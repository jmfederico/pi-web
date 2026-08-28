import { createRequire } from "node:module";

/**
 * The single node-pty loader (SPEC D4).
 *
 * `NodePTYBackend` and the `pi-web doctor` node-pty check both consume this module. Keeping two
 * independent loaders is what let doctor report a loadable node-pty while terminals threw — each
 * resolved the binding on its own. It also has to be a `createRequire` call rather than a bare
 * `require`: the build emits ES modules, where `require` is not defined in Node.
 */

const requireFromHere = createRequire(import.meta.url);

export interface NodePtyProcess {
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

/**
 * Loads the optional node-pty native binding, throwing when it is missing or unusable —
 * bun runs a dependency's install script only under its trust policy, so an installed package
 * may legitimately ship without a built binary.
 */
export function loadNodePtyModule(): NodePtyModule {
  const loaded: unknown = requireFromHere("node-pty");
  if (!isNodePtyModule(loaded)) {
    throw new Error("node-pty did not export a spawn() function");
  }
  return loaded;
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
  return (
    typeof value === "object"
    && value !== null
    && typeof Reflect.get(value, "spawn") === "function"
  );
}
