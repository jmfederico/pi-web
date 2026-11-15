import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createCompanionBackend, createSessionStateData, readSessionState, SESSION_STATE_CUSTOM_TYPE,
} from "@jmfederico/pi-web/server-plugin-api";
import { resolveDestination } from "../destination.js";
import {
  CHECK_EVENT, isFinished, NOTIFY_EVENT, OUTCOME_TYPE, outcomeText, parseRecord,
  PRIVATE_INPUT_TOOL, recordObject, REPLY_EVENT, requestId, stateNamespace,
} from "../protocol.js";

/** The companion never receives the secret, even transiently. Only the backend writes it. */
export default function privateInputExtension(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let unsubscribe: (() => void)[] = [];
  const pending = new Map<string, { nonce: string; timeout: ReturnType<typeof setTimeout> }>();
  const finish = (id: string, accepted: boolean) => {
    const receipt = pending.get(id);
    if (receipt === undefined) return;
    pending.delete(id);
    clearTimeout(receipt.timeout);
    pi.events.emit(REPLY_EVENT, { nonce: receipt.nonce, accepted });
  };
  const confirm = (ctx: ExtensionContext, settled: boolean) => {
    if (pending.size === 0) return;
    const branch = ctx.sessionManager.getBranch();
    for (const id of pending.keys()) {
      const persisted = branch.some((entry) => entry.type === "custom_message"
        && entry.customType === OUTCOME_TYPE && matchesRequest(entry.details, id));
      if (persisted || settled) finish(id, persisted);
    }
  };
  const stop = () => {
    for (const off of unsubscribe) off();
    unsubscribe = [];
    for (const id of pending.keys()) finish(id, false);
    current = undefined;
  };
  // sendMessage is void; message_end runs before persistence. These hooks only
  // wake confirmation: the authoritative branch, not the event, proves delivery.
  pi.on("context", (_event, ctx) => { confirm(ctx, false); });
  pi.on("agent_settled", (_event, ctx) => { confirm(ctx, true); });
  pi.on("session_shutdown", stop);
  pi.on("session_start", (_event, ctx) => {
    stop();
    current = ctx;
    unsubscribe = [
      pi.events.on(CHECK_EVENT, (data) => { reply(data, false); }),
      pi.events.on(NOTIFY_EVENT, (data) => { reply(data, true); }),
    ];
  });

  function reply(value: unknown, notify: boolean): void {
    // Event payloads contain identity only. Re-read authoritative state rather
    // than accepting a caller-supplied outcome or free-form follow-up text.
    let nonce: string | undefined;
    let accepted = false;
    try {
      const input = recordObject(value);
      if (typeof input["nonce"] !== "string") return;
      nonce = requestId(input["nonce"]);
      const id = requestId(input["requestId"]);
      const ctx = current;
      if (ctx === undefined) return;
      const record = parseRecord(readSessionState(ctx.sessionManager.getEntries(), stateNamespace(id)).value);
      if (record.sessionId !== ctx.sessionManager.getSessionId()) return;
      const branch = ctx.sessionManager.getBranch();
      const requested = branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult"
        && entry.message.toolName === PRIVATE_INPUT_TOOL && matchesRequest(entry.message.details, id));
      if (!requested) return;
      if (!notify) { accepted = ctx.isIdle() && record.status === "waiting"; return; }
      if (!isFinished(record)) return;
      const alreadyDelivered = branch.some((entry) => entry.type === "custom_message"
        && entry.customType === OUTCOME_TYPE && matchesRequest(entry.details, id));
      if (alreadyDelivered) { accepted = true; return; }
      if (!ctx.isIdle() || pending.has(id)) return;
      // Bound local receipts too: a failure before a run starts need not emit
      // agent_settled. The peer times out independently; local expiry must not
      // call a session-bound API after disposal.
      pending.set(id, { nonce, timeout: setTimeout(() => { pending.delete(id); }, 3000) });
      nonce = undefined; // The pending receipt now owns the acknowledgement.
      try {
        pi.sendMessage({ customType: OUTCOME_TYPE, content: outcomeText(record), display: true, details: { requestId: id, status: record.status } }, { triggerTurn: true, deliverAs: "followUp" });
      } catch { finish(id, false); }
    } catch { /* Reply with a fixed negative acknowledgement, never raw event data. */ }
    finally { if (nonce !== undefined) pi.events.emit(REPLY_EVENT, { nonce, accepted }); }
  }

  pi.registerTool(defineTool({
    name: PRIVATE_INPUT_TOOL,
    label: "Request private input",
    exposure: "model-only",
    description: "Ask the user to enter a secret privately in PI WEB and create a new file with it. Ends the run; a non-secret outcome later resumes it. Existing files are never overwritten. The parent directory must exist.",
    promptSnippet: "request_private_input: privately collect a secret into a new file; ends the run",
    promptGuidelines: [
      "Use request_private_input for secrets. Supply only a destination and purpose, never a secret value.",
      "Call request_private_input alone and last. Wait for its non-secret follow-up; do not read the secret file to verify capture.",
    ],
    parameters: Type.Object({
      destination: Type.String({ minLength: 1, maxLength: 4096, description: "New file path, absolute or relative to this workspace. Its parent directory must already exist." }),
      purpose: Type.String({ minLength: 1, maxLength: 2000, description: "Explain what the user should enter and why, without including the secret." }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const peer = createCompanionBackend(pi.events, "private-input").forScope({ kind: "machine" });
      if (peer.request === undefined) throw new Error("Enable the Private input PI WEB plugin before requesting private input");
      await peer.request("available", null, signal === undefined ? {} : { signal });
      const record = parseRecord({
        requestId: randomUUID(), sessionId: ctx.sessionManager.getSessionId(),
        destination: await resolveDestination(params.destination, ctx.cwd), purpose: params.purpose, status: "waiting",
      });
      signal?.throwIfAborted();
      pi.appendEntry(SESSION_STATE_CUSTOM_TYPE, createSessionStateData(stateNamespace(record.requestId), { ...record }, false));
      return {
        content: [{ type: "text", text: `Private input requested for ${JSON.stringify(record.destination)}. This run ends now; the user can submit or cancel in PI WEB. The follow-up will contain only the outcome, not the value.` }],
        details: { requestId: record.requestId, privateInput: { ...record }, interventionRequired: true },
        terminate: true,
      };
    },
  }));
}

function matchesRequest(value: unknown, id: string): boolean {
  return typeof value === "object" && value !== null && "requestId" in value && value.requestId === id;
}
