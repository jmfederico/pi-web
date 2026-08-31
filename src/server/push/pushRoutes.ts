import type { FastifyInstance } from "fastify";
import type { PushSubscriptionRecord } from "./pushSubscriptionStore.js";

export interface PushRouteDependencies {
  /** True when all VAPID fields are configured; routes answer 503 while false. */
  readonly configured: boolean;
  /** Base64url VAPID public key handed to clients, present exactly when `configured`. */
  readonly publicKey?: string | undefined;
  readonly store: Pick<import("./pushSubscriptionStore.js").PushSubscriptionStore, "add" | "remove">;
}

/**
 * Daemon-side Web Push endpoints. Mounted without the `/api` prefix on purpose: the browser-facing
 * edge (app.ts) proxies `api/push*` onto these paths through the session-proxy allowlist, exactly
 * like the other daemon-owned routes.
 */
export function registerPushRoutes(app: FastifyInstance, deps: PushRouteDependencies): void {
  app.get("/push/vapid-public-key", (_request, reply) => {
    if (!deps.configured || deps.publicKey === undefined) {
      reply.code(503);
      return { error: "Web push is not configured on this server" };
    }
    return { publicKey: deps.publicKey };
  });

  app.post("/push/subscribe", (request, reply) => {
    if (!deps.configured) {
      reply.code(503);
      return { error: "Web push is not configured on this server" };
    }
    const subscription = parsePushSubscriptionRecord(request.body);
    if (subscription === undefined) {
      reply.code(400);
      return { error: "Invalid push subscription payload" };
    }
    const result = deps.store.add(subscription);
    if (result === "full") {
      reply.code(507);
      return { error: "Push subscription limit reached on this server; unsubscribe an old browser and retry" };
    }
    return { accepted: true };
  });

  app.delete("/push/unsubscribe", (request) => {
    const subscription = parsePushSubscriptionRecord(request.body);
    if (!deps.configured || subscription === undefined) return { removed: false };
    return { removed: deps.store.remove(subscription.endpoint) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure validation shared by subscribe and unsubscribe payloads; returns undefined when not deliverable. */
export function parsePushSubscriptionRecord(value: unknown): PushSubscriptionRecord | undefined {
  if (!isRecord(value)) return undefined;
  const endpoint = value["endpoint"];
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) return undefined;
  const keys = parseKeys(value["keys"]);
  if (keys === undefined) return undefined;
  const expirationTime = value["expirationTime"];
  return {
    endpoint,
    ...(expirationTime === null || typeof expirationTime === "number" && Number.isFinite(expirationTime) ? { expirationTime } : {}),
    keys,
  };
}

function parseKeys(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") return undefined;
    result[key] = item;
  }
  // A subscription without the VAPID key pair can never be delivered to.
  return typeof result["p256dh"] === "string" && result["p256dh"] !== "" && typeof result["auth"] === "string" && result["auth"] !== "" ? result : undefined;
}
