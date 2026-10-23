import { formatNodePtyNativeModuleCheck } from "./nodePtyNativeModule.js";
import { checkNodePtyDarwinSpawnHelper, formatNodePtyDarwinSpawnHelperCheck } from "./nodePtySpawnHelper.js";

interface TerminalPrerequisiteReport {
  ok: boolean;
  lines: string[];
}
interface ProviderInspection {
  kind: "node" | "bun";
  supported: boolean;
  reason?: string;
}
interface TerminalPrerequisiteOptions {
  inspectProvider?: () => ProviderInspection | Promise<ProviderInspection>;
  checkNodeHelper?: () => TerminalPrerequisiteReport;
}

/**
 * Ask the shipped Terminal package, rather than reconstructing its selection in
 * core. The package remains self-contained; loading this explicit diagnostic
 * entry never activates the plugin, creates state or spawns a terminal.
 */
async function inspectBundledProvider(): Promise<ProviderInspection> {
  const entry = new URL("../../../dist/pi-web-plugins/terminal/ptyComposition.js", import.meta.url);
  const module: unknown = await import(entry.href);
  if (typeof module !== "object" || module === null) throw new Error("Terminal provider module is invalid");
  const inspect: unknown = Reflect.get(module, "inspectPtyProvider");
  if (!isInspectionFunction(inspect)) throw new Error("Terminal provider does not expose prerequisite inspection");
  const result: unknown = inspect();
  if (typeof result !== "object" || result === null) throw new Error("Terminal provider prerequisite result is invalid");
  const kind: unknown = Reflect.get(result, "kind");
  const supported: unknown = Reflect.get(result, "supported");
  const reason: unknown = Reflect.get(result, "reason");
  if ((kind !== "node" && kind !== "bun") || typeof supported !== "boolean") throw new Error("Terminal provider prerequisite result is invalid");
  return { kind, supported, ...(typeof reason === "string" ? { reason } : {}) };
}

function isInspectionFunction(value: unknown): value is () => unknown {
  return typeof value === "function";
}

export async function checkTerminalPrerequisites(options: TerminalPrerequisiteOptions = {}): Promise<TerminalPrerequisiteReport> {
  let inspection: ProviderInspection;
  try {
    inspection = await (options.inspectProvider ?? inspectBundledProvider)();
  } catch (error) {
    return { ok: false, lines: ["✗ Terminal provider inspection failed", `  ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (inspection.kind === "bun") {
    return inspection.supported
      ? { ok: true, lines: ["✓ Bun native terminal APIs available"] }
      : { ok: false, lines: [
        "✗ Bun native terminal APIs unavailable",
        `  ${inspection.reason ?? "Upgrade Bun to use terminals."}`,
        "  node-pty fallback is not supported under Bun.",
      ] };
  }
  const module = formatNodePtyNativeModuleCheck(inspection.supported
    ? { status: "ok" }
    : { status: "load-failed", message: inspection.reason ?? "Native binding unavailable" });
  if (!module.ok) return module;
  const helper = (options.checkNodeHelper ?? (() => formatNodePtyDarwinSpawnHelperCheck(checkNodePtyDarwinSpawnHelper())))();
  return { ok: helper.ok, lines: [...module.lines, ...helper.lines] };
}
