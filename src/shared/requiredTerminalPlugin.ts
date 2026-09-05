export const REQUIRED_TERMINAL_PLUGIN_ID = "terminal";

export type TerminalPluginMode = "required" | "recovery-disabled";

export function terminalPluginModeForSafeStart(safeStart: "bundled-only" | "none" | undefined): TerminalPluginMode {
  return safeStart === "none" ? "recovery-disabled" : "required";
}

export const REQUIRED_TERMINAL_RECOVERY_GUIDANCE = "Use `pi-web plugins safe-start set none --restart` to start PI WEB without Terminal for recovery.";
