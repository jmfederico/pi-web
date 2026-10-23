export const NODE_PTY_GLOBAL_REINSTALL_COMMAND = "npm install -g @jmfederico/pi-web --allow-scripts=node-pty";

const doctorLabel = "node-pty native module loadable";
export type NodePtyNativeModuleCheck =
  | { status: "ok" }
  | { status: "load-failed"; message: string };

export interface FormattedNodePtyNativeModuleCheck {
  ok: boolean;
  lines: string[];
}

export function formatNodePtyNativeModuleCheck(check: NodePtyNativeModuleCheck): FormattedNodePtyNativeModuleCheck {
  if (check.status === "ok") return { ok: true, lines: [`✓ ${doctorLabel}`] };
  return {
    ok: false,
    lines: [
      `✗ ${doctorLabel}`,
      `  Could not load node-pty: ${check.message}`,
      "  npm may have skipped node-pty's required install script.",
      "  For a global npm installation, reinstall PI WEB with:",
      `    ${NODE_PTY_GLOBAL_REINSTALL_COMMAND}`,
      "  Then run `pi-web doctor` again.",
    ],
  };
}
