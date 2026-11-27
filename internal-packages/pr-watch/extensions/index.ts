import { setTimeout as delay } from "node:timers/promises";
import { Type, type TSchema } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompanionBackend, type JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { DELIVERY_TIMEOUT_MS, NOTIFY_EVENT, parseNotifyPayload, PLUGIN_ID, REPLY_EVENT, UPDATE_MESSAGE_TYPE } from "../protocol.js";

/**
 * Thin companion: tools forward to the session-daemon backend, which owns all
 * subscription state. The NOTIFY handler starts a turn in an idle session and
 * confirms delivery only once the notification appears in its transcript.
 */
export default function prWatchExtension(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    current = ctx;
    unsubscribe = pi.events.on(NOTIFY_EVENT, (data) => { void receive(data); });
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    current = undefined;
  });

  async function receive(data: unknown): Promise<void> {
    // Read the nonce leniently so that even a malformed payload gets a reasoned rejection.
    const nonce: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "nonce") : undefined;
    if (typeof nonce !== "string") return;
    try {
      const payload = parseNotifyPayload(data);
      const ctx = current;
      if (ctx === undefined) throw new Error("no active session");
      if (ctx.sessionManager.getSessionId() !== payload.sessionId) throw new Error("addressed to another session");
      const persisted = () => ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message"
        && entry.customType === UPDATE_MESSAGE_TYPE && notificationIdOf(entry.details) === payload.notificationId);
      if (!persisted()) {
        // Pi can clear queued follow-ups. Leave the durable outbox in charge until the session is idle.
        if (!ctx.isIdle()) { pi.events.emit(REPLY_EVENT, { nonce, accepted: false, busy: true }); return; }
        pi.sendMessage({ customType: UPDATE_MESSAGE_TYPE, content: payload.content, display: true, details: payload.details }, { triggerTurn: true });
        // sendMessage returns before Pi writes the message. Wait only within the reply window.
        const deadline = performance.now() + DELIVERY_TIMEOUT_MS;
        while (current === ctx && !persisted() && performance.now() < deadline) await delay(25);
        if (current !== ctx || !persisted()) return;
      }
      pi.events.emit(REPLY_EVENT, { nonce, accepted: true });
    } catch (error) {
      // The cause is bounded and never includes notification or review text.
      const rejection = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      pi.events.emit(REPLY_EVENT, { nonce, accepted: false, error: rejection });
    }
  }

  const register = (name: string, label: string, description: string, parameters: TSchema, operation: string, extra: { promptSnippet?: string; promptGuidelines?: string[] } = {}) => {
    pi.registerTool(defineTool({
      name, label, description, parameters, ...extra,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const backend = createCompanionBackend(pi.events, PLUGIN_ID).forScope({ kind: "machine" });
        if (backend.request === undefined) throw new Error("Enable the pr-watch PI WEB plugin and restart the session daemon");
        // oxlint-disable-next-line typescript/consistent-type-assertions -- Pi validated the TypeBox object; the backend validates again.
        const input = { ...(params as Record<string, JsonValue>), sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
        const result = await backend.request(operation, input, signal === undefined ? {} : { signal });
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }));
  };

  register(
    "pr_watch_subscribe", "PR watch: subscribe",
    "Subscribe this session to CodeRabbit activity on a GitHub pull request. When CodeRabbit finishes a review, comments, replies, or reports a rate limit, a follow-up message wakes this session. The subscription ends when the pull request is merged or closed, when the session is archived or deleted, or when it expires (two weeks by default; configurable). Returns CodeRabbit activity that already exists.",
    Type.Object({
      pr: Type.String({ minLength: 1, maxLength: 512, description: "Pull request URL, number, or branch, resolved with gh in this workspace." }),
    }, { additionalProperties: false }),
    "subscribe",
    {
      promptSnippet: "pr_watch_subscribe: be woken when CodeRabbit reviews or comments on a pull request",
      promptGuidelines: [
        "After opening a pull request that CodeRabbit reviews, call pr_watch_subscribe and end the turn instead of polling GitHub; handle the follow-up message when it arrives.",
      ],
    },
  );
  register(
    "pr_watch_list", "PR watch: list",
    "List this session's pull request subscriptions and recently removed ones with their removal reasons.",
    Type.Object({}, { additionalProperties: false }),
    "list",
  );
  register(
    "pr_watch_unsubscribe", "PR watch: unsubscribe",
    "Stop CodeRabbit notifications for one of this session's subscriptions.",
    Type.Object({
      subscriptionId: Type.String({ minLength: 1, maxLength: 512, description: "Subscription ID from pr_watch_subscribe or pr_watch_list." }),
    }, { additionalProperties: false }),
    "unsubscribe",
  );
}

function notificationIdOf(details: unknown): unknown {
  return typeof details === "object" && details !== null ? Reflect.get(details, "notificationId") : undefined;
}
