/**
 * Which JavaScript runtime the current process is, and whether it can drive a PTY natively.
 *
 * Single source of truth for both questions: the terminal backend factory, the `pi-web doctor`
 * terminal section, the runtime stamped into each component's status report, and the launcher's
 * capability gate (`bun -e 'typeof Bun.Terminal === "function"'`) all key off the same checks.
 * Detecting them separately per caller is how doctor and the backend could disagree (SPEC D4/F5).
 */
import type { PiWebRuntime } from "./pluginApiTypes.js";

export type { PiWebRuntime };

export function piWebRuntimeKind(): PiWebRuntime {
  return typeof bunValue("spawn") === "function" ? "bun" : "node";
}

/** Bun serves terminals natively only with `Bun.Terminal`; older builds expose `Bun.spawn` alone. */
export function bunTerminalCapability(): boolean {
  return typeof bunValue("Terminal") === "function";
}

function bunValue(key: string): unknown {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bun !== "object" || bun === null) return undefined;
  return Reflect.get(bun, key);
}
