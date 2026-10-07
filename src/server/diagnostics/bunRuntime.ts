/**
 * Detect whether the current runtime is Bun or Node.js.
 *
 * Bun exposes `process.versions.bun`, while Node.js does not.
 * This is checked at module load time so callers can adjust behaviour
 * without importing the heavy node-pty module.
 */
export function isBunRuntime(): boolean {
  return typeof process !== "undefined" && process.versions?.["bun"] !== undefined;
}
