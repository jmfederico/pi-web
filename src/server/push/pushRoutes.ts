import type { FastifyInstance } from "fastify";
import type { PushSubscriptionRecord, PushSubscriptionStore } from "./pushSubscriptionStore.js";

export function registerPushRoutes(
  app: FastifyInstance,
  store: Pick<PushSubscriptionStore, "add" | "remove">,
  vapidPublicKey: () => string | undefined,
): void {
  app.get("/api/push/vapid-public-key", async (_request, reply) => {
    const publicKey = vapidPublicKey();
    if (publicKey === undefined) return reply.code(404).send({ error: "Web Push is not configured" });
    return { publicKey };
  });

  app.post<{ Body: unknown }>("/api/push/subscribe", async (request, reply) => {
    try {
      const userAgent = request.headers["user-agent"];
      await store.add(parseSubscribeRequest(request.body, typeof userAgent === "string" ? userAgent : undefined));
      return { subscribed: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Body: unknown }>("/api/push/unsubscribe", async (request, reply) => {
    try {
      await store.remove(parseUnsubscribeRequest(request.body));
      return { unsubscribed: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function parseSubscribeRequest(value: unknown, userAgent: string | undefined): PushSubscriptionRecord {
  if (!isRecord(value)) throw new Error("Push subscription request must be an object");
  const endpoint = value["endpoint"];
  if (typeof endpoint !== "string" || endpoint === "") throw new Error("Push subscription endpoint must be a non-empty string");
  const keys = value["keys"];
  if (!isRecord(keys)) throw new Error("Push subscription keys must be an object");
  const p256dh = keys["p256dh"];
  const auth = keys["auth"];
  if (typeof p256dh !== "string" || p256dh === "" || typeof auth !== "string" || auth === "") {
    throw new Error("Push subscription keys must include non-empty p256dh and auth strings");
  }
  const machineId = value["machineId"];
  if (machineId !== undefined && typeof machineId !== "string") throw new Error("Push subscription machineId must be a string");
  return {
    endpoint,
    keys: { p256dh, auth },
    machineId: machineId !== undefined && machineId !== "" ? machineId : "local",
    createdAt: new Date().toISOString(),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}

function parseUnsubscribeRequest(value: unknown): string {
  if (!isRecord(value)) throw new Error("Push unsubscribe request must be an object");
  const endpoint = value["endpoint"];
  if (typeof endpoint !== "string" || endpoint === "") throw new Error("Push unsubscribe endpoint must be a non-empty string");
  return endpoint;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
