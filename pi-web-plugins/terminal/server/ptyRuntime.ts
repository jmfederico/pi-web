/**
 * Which JavaScript runtime this process is, and whether it can drive a PTY natively.
 *
 * The canonical detector lives in the host (`src/shared/piWebRuntime.ts`, SPEC D4/F5) so the
 * launcher gate, doctor, and the backend factory all agree; the bundled Terminal plugin cannot
 * import it at runtime because the plugin is bundled separately from core code. This copy is
 * kept behaviorally identical and pinned by the parity test in `ptyBackend.test.ts`, which
 * asserts both detectors return the same verdict for every Bun global shape.
 *
 * Bun serves terminals natively only with `Bun.Terminal`; older builds expose `Bun.spawn` alone.
 * node-pty cannot serve a Bun runtime at all: Bun's `tty.ReadStream` is built on `fs.ReadStream`,
 * so the first `EAGAIN` on node-pty's non-blocking PTY master fd destroys the stream and closes
 * the fd — `onData` never fires and a later `resize()` fails with `EBADF`
 * (https://github.com/oven-sh/bun/issues/25822; fix PRs #29114 / #29140, still unmerged).
 */
export type PiWebRuntime = "bun" | "node";

export function piWebRuntimeKind(): PiWebRuntime {
  return typeof bunValue("spawn") === "function" ? "bun" : "node";
}

export function bunTerminalCapability(): boolean {
  return typeof bunValue("Terminal") === "function";
}

export function isBunRuntime(): boolean {
  return piWebRuntimeKind() === "bun";
}

function bunValue(key: string): unknown {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  if (typeof bun !== "object" || bun === null) return undefined;
  return Reflect.get(bun, key);
}
