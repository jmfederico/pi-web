/** Wire contract shared by the session-daemon backend and the companion extension. */
export const PLUGIN_ID = "pr-watch";
/** Backend → extension: deliver one notification into the conversation. */
export const NOTIFY_EVENT = "pr-watch:notify";
/** Extension → backend: acknowledge one notify by nonce. */
export const REPLY_EVENT = "pr-watch:reply";
/** Custom message type of delivered notifications in the transcript. */
export const UPDATE_MESSAGE_TYPE = "pr-watch.update";
/** Session-state namespace read only to host a saved session before delivery. */
export const STATE_NAMESPACE = "pr-watch";

export interface NotifyPayload {
  readonly nonce: string;
  readonly sessionId: string;
  readonly notificationId: string;
  readonly content: string;
  readonly details: NotificationDetails;
}

export interface NotificationDetails {
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly pullRequest: string;
}

export function record(value: unknown, label = "Input"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Checked plain object at a JSON boundary.
  return value as Record<string, unknown>;
}

export function boundedText(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${String(max)} characters`);
  return value;
}

export function parseNotifyPayload(value: unknown): NotifyPayload {
  const input = record(value);
  const details = record(input["details"], "details");
  const notificationId = boundedText(input["notificationId"], "notificationId");
  if (details["notificationId"] !== notificationId) throw new Error("Mismatched notification id");
  return {
    nonce: boundedText(input["nonce"], "nonce"),
    sessionId: boundedText(input["sessionId"], "sessionId"),
    notificationId,
    content: boundedText(input["content"], "content", 48 * 1024),
    details: {
      notificationId,
      subscriptionId: boundedText(details["subscriptionId"], "subscriptionId"),
      pullRequest: boundedText(details["pullRequest"], "pullRequest", 2048),
    },
  };
}
