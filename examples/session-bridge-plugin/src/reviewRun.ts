import type { PiWebHostPiSessionConnection } from "@jmfederico/pi-web/server-plugin-api";
import { MAX_FINDINGS, REVIEW_REPLY, REVIEW_REQUEST } from "./browser/protocol.js";

/** Receipt and completion are separate, correlated events. Neither close nor timeout cancels Pi. */
export async function collectReview(connection: PiWebHostPiSessionConnection, requestId: string, lifetime: AbortSignal): Promise<string> {
  const signal = AbortSignal.any([lifetime, connection.signal]);
  signal.throwIfAborted();
  let unsubscribe: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      onAbort = () => { reject(new Error("Review connection interrupted; agent work may continue in Sessions")); };
      signal.addEventListener("abort", onAbort, { once: true });
      receiptTimer = setTimeout(() => { reject(new Error("No companion receipt within 5 seconds. Check package enablement/trust; inspect Sessions before retrying.")); }, 5_000);
      completionTimer = setTimeout(() => { reject(new Error("Review exceeded 10 minutes; agent work may continue in Sessions. No findings saved.")); }, 600_000);
      unsubscribe = connection.on(REVIEW_REPLY, (data) => {
        if (typeof data !== "object" || data === null || !("requestId" in data) || data.requestId !== requestId) return;
        if (!("status" in data)) return;
        if (data.status === "accepted") { clearTimeout(receiptTimer); return; }
        if (data.status === "failed") {
          reject(new Error("error" in data && typeof data.error === "string" ? data.error.slice(0, 4000) : "Review failed"));
        } else if (data.status === "completed") {
          if (!("text" in data) || typeof data.text !== "string" || !data.text.trim() || data.text.length > MAX_FINDINGS) {
            reject(new Error("Invalid companion findings"));
          } else resolve(data.text);
        }
      });
      // Native listeners can reply synchronously.
      connection.emit(REVIEW_REQUEST, { requestId });
    });
  } finally {
    clearTimeout(receiptTimer);
    clearTimeout(completionTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
  }
}
