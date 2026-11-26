import { randomUUID } from "node:crypto";
import type { PiWebHostPiSessionEventsV1, PluginSessionSelection, PluginSessionStateV1 } from "@jmfederico/pi-web/server-plugin-api";
import { NOTIFY_EVENT, REPLY_EVENT, STATE_NAMESPACE, type NotifyPayload } from "./protocol.js";

export type Deliver = (target: PluginSessionSelection, message: Omit<NotifyPayload, "nonce">, signal: AbortSignal) => Promise<boolean>;

/**
 * Hands one notification to the session's companion extension and waits for
 * its acknowledgement. `false` means unconfirmed, not necessarily undelivered;
 * the extension deduplicates retries by notification id.
 */
export function createSessionDelivery(
  state: PluginSessionStateV1,
  events: PiWebHostPiSessionEventsV1,
  lifetime: AbortSignal,
  timeoutMs = 5000,
): Deliver {
  return async (target, message, signal) => {
    // Reading session state hosts a saved session, loading its extensions so
    // the event below has a receiver. The value itself is unused.
    await state.read(target, STATE_NAMESPACE, { signal });
    const connection = await events.connect(target);
    const nonce = randomUUID();
    try {
      return await new Promise<boolean>((resolve) => {
        const combined = AbortSignal.any([signal, lifetime, connection.signal]);
        const end = (accepted: boolean) => {
          clearTimeout(timer);
          off();
          combined.removeEventListener("abort", abort);
          resolve(accepted);
        };
        const abort = () => { end(false); };
        const off = connection.on(REPLY_EVENT, (value) => {
          if (typeof value === "object" && value !== null && Reflect.get(value, "nonce") === nonce) end(Reflect.get(value, "accepted") === true);
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
