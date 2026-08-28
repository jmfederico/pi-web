import { checkNodePtyNativeModule, formatNodePtyNativeModuleCheck, type NodePtyNativeModuleCheck } from "./nodePtyNativeModule.js";
import { bunTerminalCapability, piWebRuntimeKind, type PiWebRuntime } from "../../shared/piWebRuntime.js";
import type { LoadNodePty } from "../terminals/nodePtyModule.js";

export interface TerminalRuntimeCheckOptions {
  /** Test seam for the shared loader; production always uses `loadNodePtyModule`. */
  loadNodePty?: LoadNodePty;
}

export type TerminalRuntimeInspection =
  | { runtime: PiWebRuntime; backend: "bun"; bunTerminal: true; nodePty: null }
  | { runtime: PiWebRuntime; backend: "node-pty"; bunTerminal: boolean; nodePty: NodePtyNativeModuleCheck };

export interface TerminalRuntimeReport {
  ok: boolean;
  lines: string[];
}

/**
 * Inspect the terminal stack through the decisions the server actually makes at start-up: the
 * runtime and the Bun capability come from the shared detection, and the node-pty verdict comes
 * from the shared loader. Under a Bun that has `Bun.Terminal` nothing touches node-pty — that
 * install usually has no built native binding, and recommending one is how doctor misled bun users
 * (SPEC F5).
 */
export function checkTerminalRuntime(options: TerminalRuntimeCheckOptions = {}): TerminalRuntimeInspection {
  const runtime = piWebRuntimeKind();
  const bunTerminal = bunTerminalCapability();
  if (runtime === "bun" && bunTerminal) {
    return { runtime, backend: "bun", bunTerminal: true, nodePty: null };
  }
  return {
    runtime,
    backend: "node-pty",
    bunTerminal,
    nodePty: checkNodePtyNativeModule(options.loadNodePty === undefined ? {} : { load: options.loadNodePty }),
  };
}

export function formatTerminalRuntimeCheck(inspection: TerminalRuntimeInspection): TerminalRuntimeReport {
  const lines = [`runtime: ${inspection.runtime}`];
  if (inspection.backend === "bun") {
    return { ok: true, lines: [...lines, "✓ terminals: Bun native PTY (Bun.Terminal)"] };
  }
  // An older bun still serves terminals, just through node-pty — name the stack before judging it.
  if (inspection.runtime === "bun") {
    lines.push("! terminals: Bun.Terminal unavailable — falling back to node-pty");
  }
  const nodePty = formatNodePtyNativeModuleCheck(inspection.nodePty);
  return { ok: nodePty.ok, lines: [...lines, ...nodePty.lines] };
}
