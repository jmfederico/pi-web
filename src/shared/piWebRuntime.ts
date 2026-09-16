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

/**
 * Bun serves terminals natively only with `Bun.Terminal`; older builds expose `Bun.spawn` alone.
 *
 * Canonical upstream-tracking note for the whole feature — this capability is a requirement, not a
 * preference, because node-pty cannot serve a Bun runtime at all: Bun's `tty.ReadStream` is built on
 * `fs.ReadStream`, so the first `EAGAIN` on node-pty's non-blocking PTY master fd destroys the stream
 * and closes the fd — `onData` never fires and a later `resize()` fails with `EBADF`
 * (https://github.com/oven-sh/bun/issues/25822; fix PRs #29114 / #29140, still unmerged).
 *
 * What that means when Bun ships the fix: nothing here becomes dead code, because it is not a
 * workaround — the Bun path never uses node-pty. `Bun.Terminal` stays the preferred Bun engine on
 * purpose (no node-gyp build, no `trustedDependencies` step, nothing to fail silently at install),
 * and this gate stays to keep a Bun older than `Bun.Terminal` from booting PI WEB at all. The only
 * thing that changes upstream is the degraded path: on such a Bun running PI WEB on Node.js with a
 * trusted `node-pty` build goes from "works, and the binding may be missing" to "works". Relax the
 * launcher warning and the `docs/install.html` wording then, not this check.
 */
export function bunTerminalCapability(): boolean {
  return typeof bunValue("Terminal") === "function";
}

function bunValue(key: string): unknown {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bun !== "object" || bun === null) return undefined;
  return Reflect.get(bun, key);
}
