import { randomUUID } from "node:crypto";
import type { PiWebHostPiSessionEventsV1, PluginSessionSelection, PluginSessionStateV1 } from "@jmfederico/pi-web/server-plugin-api";
import { DELIVERY_TIMEOUT_MS, NOTIFY_EVENT, REPLY_EVENT, STATE_NAMESPACE, type NotifyPayload } from "./protocol.js";

export type Deliver = (target: PluginSessionSelection, message: Omit<NotifyPayload, "nonce">, signal: AbortSignal) => Promise<boolean | "busy">;

/**
 * Hands one notification to the session's companion extension and waits for
 * its acknowledgement. `false` means unconfirmed (no reply), not necessarily
 * undelivered; the extension deduplicates retries by notification id. An
 * explicit rejection throws with the extension's reported cause. `busy` is a
 * normal deferral: the session is still working and did not queue the message.
 */
export function createSessionDelivery(
  state: PluginSessionStateV1,
  events: PiWebHostPiSessionEventsV1,
  lifetime: AbortSignal,
  timeoutMs = DELIVERY_TIMEOUT_MS,
): Deliver {
  return async (target, message, signal) => {
    // Reading session state hosts a saved session, loading its extensions so
    // the event below has a receiver. The value itself is unused.
    await state.read(target, STATE_NAMESPACE, { signal });
    const connection = await events.connect(target);
    const nonce = randomUUID();
    try {
      return await new Promise<boolean | "busy">((resolve, reject) => {
        const combined = AbortSignal.any([signal, lifetime, connection.signal]);
        const end = (accepted: boolean | "busy", rejection?: string) => {
          clearTimeout(timer);
          off();
          combined.removeEventListener("abort", abort);
          if (rejection === undefined) resolve(accepted);
          else reject(new Error(`Session companion rejected the notification: ${rejection}`));
        };
        const abort = () => { end(false); };
        const off = connection.on(REPLY_EVENT, (value) => {
          if (typeof value !== "object" || value === null || Reflect.get(value, "nonce") !== nonce) return;
          if (Reflect.get(value, "accepted") === true) { end(true); return; }
          if (Reflect.get(value, "busy") === true) { end("busy"); return; }
          const error: unknown = Reflect.get(value, "error");
          end(false, typeof error === "string" ? error.slice(0, 300) : "no reason given");
        });
        const timer = setTimeout(() => { end(false); }, timeoutMs);
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) { end(false); return; }
        try {
          const payload: NotifyPayload = { ...message, nonce };
          connection.emit(NOTIFY_EVENT, payload);
        } catch { end(false); }
      });
    } finally { connection.close(); }
  };
}
