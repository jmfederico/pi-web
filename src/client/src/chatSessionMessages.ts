/** Only explicit sender/body metadata opts into the split header/body presentation. */
export function sessionMessagePresentation(customType: string, content: unknown, details: unknown): { sendingSessionId: string; body: string } | undefined {
  if (customType !== "session.message" || typeof content !== "string"
    || typeof details !== "object" || details === null
    || !("sendingSessionId" in details) || typeof details.sendingSessionId !== "string" || details.sendingSessionId.trim() === ""
    || !("body" in details) || typeof details.body !== "string") return undefined;
  return { sendingSessionId: details.sendingSessionId, body: details.body };
}
