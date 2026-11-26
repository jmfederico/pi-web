import { Type, type TSchema } from "typebox";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompanionBackend, type JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { NOTIFY_EVENT, parseNotifyPayload, PLUGIN_ID, REPLY_EVENT, UPDATE_MESSAGE_TYPE } from "../protocol.js";

/**
 * Thin companion: tools forward to the session-daemon backend, which owns all
 * subscription state. The NOTIFY handler turns a backend notification into a
 * follow-up message that wakes an idle session or queues behind current work.
 */
export default function prWatchExtension(pi: ExtensionAPI): void {
  let current: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  // Retries reuse the notification id. Queued follow-ups are not yet in the
  // branch, so remember accepted ids for this runtime as well.
  const accepted = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    unsubscribe?.();
    current = ctx;
    unsubscribe = pi.events.on(NOTIFY_EVENT, (data) => { receive(data); });
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    current = undefined;
  });

  function receive(data: unknown): void {
    // Read the nonce leniently so that even a malformed payload gets a reasoned rejection.
    const nonce: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "nonce") : undefined;
    let rejection: string | undefined;
    try {
      const payload = parseNotifyPayload(data);
      const ctx = current;
      if (ctx === undefined) { rejection = "no active session"; return; }
      if (ctx.sessionManager.getSessionId() !== payload.sessionId) { rejection = "addressed to another session"; return; }
      const persisted = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message"
        && entry.customType === UPDATE_MESSAGE_TYPE && notificationIdOf(entry.details) === payload.notificationId);
      if (!accepted.has(payload.notificationId) && !persisted) {
        pi.sendMessage({ customType: UPDATE_MESSAGE_TYPE, content: payload.content, display: true, details: payload.details }, { triggerTurn: true, deliverAs: "followUp" });
        accepted.add(payload.notificationId);
      }
    } catch (error) {
      // The cause is bounded and never includes notification or review text.
      rejection = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    } finally {
      if (typeof nonce === "string") {
        pi.events.emit(REPLY_EVENT, rejection === undefined ? { nonce, accepted: true } : { nonce, accepted: false, error: rejection });
      }
    }
  }

  const register = (name: string, label: string, description: string, parameters: TSchema, operation: string, extra: { promptSnippet?: string; promptGuidelines?: string[] } = {}) => {
    pi.registerTool(defineTool({
      name, label, description, parameters, ...extra,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const backend = createCompanionBackend(pi.events, PLUGIN_ID).forScope({ kind: "machine" });
        if (backend.request === undefined) throw new Error("Enable the pr-watch PI WEB plugin and restart the session daemon");
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Pi validated the TypeBox object; the backend validates again.
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
