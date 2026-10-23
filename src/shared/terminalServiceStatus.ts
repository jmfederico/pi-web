/** Running Terminal state, distinct from provider prerequisites checked before startup. */
export type TerminalServiceStatus =
  | { state: "active"; health: "healthy" | "degraded" | "unhealthy"; message?: string }
  | { state: "disabled"; message: string }
  | { state: "unavailable"; message: string };

export function parseTerminalServiceStatus(value: unknown): TerminalServiceStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state: unknown = Reflect.get(value, "state");
  const message: unknown = Reflect.get(value, "message");
  if (state === "disabled" || state === "unavailable") {
    return typeof message === "string" ? { state, message } : undefined;
  }
  const health: unknown = Reflect.get(value, "health");
  if (state !== "active" || (health !== "healthy" && health !== "degraded" && health !== "unhealthy")) return undefined;
  return { state, health, ...(typeof message === "string" ? { message } : {}) };
}
