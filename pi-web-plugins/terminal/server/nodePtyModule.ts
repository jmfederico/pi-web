import { createRequire } from "node:module";

/**
 * The plugin's single node-pty loader.
 *
 * The bundled Terminal plugin cannot import the host's shared loader
 * (`src/server/terminals/nodePtyModule.ts`, SPEC D4) because plugin code is bundled separately
 * from core production code; this is its plugin-local counterpart, and
 * `src/server/terminals/nodePtyLoader.test.ts` asserts each tree keeps exactly one loader.
 *
 * It must be a `createRequire` call rather than a bare `require`: the build emits ES modules,
 * where `require` is not defined in Node.
 */
const requireFromHere = createRequire(import.meta.url);

export interface NodePtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string | number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
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
      env?: Record<string, string | undefined>;
    },
  ): NodePtyProcess;
}

/**
 * Loads the optional node-pty native binding, throwing when it is missing or unusable —
 * package managers install this optional dependency under their own script trust policies, so an
 * installed package may legitimately ship without a built binary.
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
