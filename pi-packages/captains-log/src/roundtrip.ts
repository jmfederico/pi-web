import type { PiWebHostPiSessionConnection } from "@jmfederico/pi-web/server-plugin-api";
import { MAX_FINDINGS, CAPTAIN_REPLY, CAPTAIN_REQUEST, SOURCE_REPLY, SOURCE_REQUEST } from "./browser/protocol.js";

export function collectReply(connection: PiWebHostPiSessionConnection, requestId: string, text: string, lifetime: AbortSignal, progress: (stage: string) => void): Promise<string> {
  return collect(connection, requestId, { requestId, text }, CAPTAIN_REQUEST, CAPTAIN_REPLY, lifetime, progress);
}

export function collectSourceReply(connection: PiWebHostPiSessionConnection, requestId: string, lifetime: AbortSignal, progress: (stage: string) => void): Promise<string> {
  return collect(connection, requestId, { requestId }, SOURCE_REQUEST, SOURCE_REPLY, lifetime, progress);
}

/** Subscribe before sending. Never retry an ambiguous send or cancel Pi on timeout. */
async function collect(connection: PiWebHostPiSessionConnection, requestId: string, payload: { requestId: string; text?: string }, requestEvent: string, replyEvent: string, lifetime: AbortSignal, progress: (stage: string) => void): Promise<string> {
  const signal = AbortSignal.any([lifetime, connection.signal]);
  signal.throwIfAborted();
  let unsubscribe: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      onAbort = () => { reject(new Error("Captain connection interrupted; agent work may continue in Sessions")); };
      signal.addEventListener("abort", onAbort, { once: true });
      receiptTimer = setTimeout(() => { reject(new Error("No companion receipt within 5 seconds. Check package enablement/trust; inspect Sessions before retrying.")); }, 5_000);
      completionTimer = setTimeout(() => { reject(new Error("Captain request exceeded 10 minutes; agent work may continue in Sessions. No translation saved.")); }, 600_000);
      unsubscribe = connection.on(replyEvent, (data) => {
        if (typeof data !== "object" || data === null || !("requestId" in data) || data.requestId !== requestId) return;
        if (!("status" in data)) return;
        if (data.status === "accepted") { clearTimeout(receiptTimer); progress("Native companion received request"); return; }
        if (data.status === "running") { progress("Native Pi agent running"); return; }
        if (data.status === "failed") {
          reject(new Error("error" in data && typeof data.error === "string" ? data.error.slice(0, 4000) : "Captain request failed"));
        } else if (data.status === "completed") {
          if (!("text" in data) || typeof data.text !== "string" || !data.text.trim() || data.text.length > MAX_FINDINGS) {
            reject(new Error("Invalid companion reply"));
          } else { progress("Backend received correlated final reply"); resolve(data.text); }
        }
      });
      // Native listeners can reply synchronously.
      progress("Backend sent request to native companion");
      connection.emit(requestEvent, payload);
    });
  } finally {
    clearTimeout(receiptTimer);
    clearTimeout(completionTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
  }
}
