import { fileURLToPath } from "node:url";
import { loadNodePtyModule, type LoadNodePty } from "../terminals/nodePtyModule.js";

export const NODE_PTY_GLOBAL_REINSTALL_COMMAND = "npm install -g @jmfederico/pi-web --allow-scripts=node-pty";

/** Bun global installs live under `<root>/install/global/node_modules` — the launcher's own heuristic. */
const BUN_GLOBAL_LAYOUT_MARKER = "/install/global/node_modules/";

export type NodePtyInstallLayout = "bun-global" | "npm";

const doctorLabel = "node-pty native module loadable";

export interface NodePtyNativeModuleCheckOptions {
  load?: LoadNodePty;
}

export type NodePtyNativeModuleCheck =
  | { status: "ok" }
  | { status: "load-failed"; message: string };

export interface FormattedNodePtyNativeModuleCheck {
  ok: boolean;
  lines: string[];
}

export function checkNodePtyNativeModule(options: NodePtyNativeModuleCheckOptions = {}): NodePtyNativeModuleCheck {
  try {
    (options.load ?? loadNodePtyModule)();
    return { status: "ok" };
  } catch (error) {
    return { status: "load-failed", message: errorMessage(error) };
  }
}

export function formatNodePtyNativeModuleCheck(
  check: NodePtyNativeModuleCheck,
  layout: NodePtyInstallLayout = nodePtyInstallLayoutForModulePath(fileURLToPath(import.meta.url)),
): FormattedNodePtyNativeModuleCheck {
  if (check.status === "ok") return { ok: true, lines: [`✓ ${doctorLabel}`] };
  return {
    ok: false,
    lines: [
      `✗ ${doctorLabel}`,
      `  Could not load node-pty: ${check.message}`,
      ...nodePtyFailureAdvice(layout),
      "  Then run `pi-web doctor` again.",
    ],
  };
}

/**
 * Recovery advice must match the tree that is actually missing the binding: recommending an npm
 * reinstall inside a bun installation creates a second, conflicting install (the r1 confusion).
 */
export function nodePtyFailureAdvice(layout: NodePtyInstallLayout): string[] {
  if (layout === "bun-global") {
    return [
      "  bun installs this optional binding only when trusted. In your bun global directory (e.g. ~/.bun/install/global) run:",
      "    bun add node-pty && bun pm trust node-pty",
    ];
  }
  return [
    "  npm may have skipped node-pty's required install script.",
    "  For a global npm installation, reinstall PI WEB with:",
    `    ${NODE_PTY_GLOBAL_REINSTALL_COMMAND}`,
  ];
}

export function nodePtyInstallLayoutForModulePath(modulePath: string): NodePtyInstallLayout {
  return modulePath.replaceAll("\\", "/").includes(BUN_GLOBAL_LAYOUT_MARKER) ? "bun-global" : "npm";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").trim();
}
