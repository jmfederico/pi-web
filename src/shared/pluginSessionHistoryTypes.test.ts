import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY } from "./pluginSessionHistoryTypes.js";

function provider(readMessages: unknown = vi.fn(() => Promise.resolve({ messages: [], start: 0, total: 0 }))) {
  return { version: 1, readMessages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("session history capability", () => {
  it("requires an explicit capability and returns detached immutable bounded pages", async () => {
    const message = { role: "assistant", content: [{ type: "text", text: "answer" }] };
    const readMessages = vi.fn(() => Promise.resolve({ messages: [message], start: 0, total: 1 }));
    const history = PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY.parse(provider(readMessages));
    const result = await history.readMessages({ projectId: "p", workspaceId: "w", sessionId: "s" });
    const returnedMessage = result.messages[0];
    if (!isRecord(returnedMessage)) throw new Error("Expected message record");
    const content = returnedMessage["content"];
    if (!Array.isArray(content) || !isRecord(content[0])) throw new Error("Expected nested message content");
    expect(readMessages).toHaveBeenCalledWith({ projectId: "p", workspaceId: "w", sessionId: "s" }, { limit: 100 }, undefined);
    expect(returnedMessage).not.toBe(message);
    expect(Object.isFrozen(returnedMessage)).toBe(true);
    expect(Object.isFrozen(content[0])).toBe(true);
    expect(Reflect.set(content[0], "text", "changed")).toBe(false);
    expect(message.content[0]?.text).toBe("answer");
    await expect(history.readMessages({ projectId: "p", workspaceId: "w", sessionId: "s" }, { limit: 101 })).rejects.toThrow("Invalid PI WEB host session history capability v1 data");
  });

  it("rejects malformed capability providers and pages", async () => {
    expect(() => PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY.parse({ version: 1 })).toThrow("Invalid");
    const invalid = PI_WEB_HOST_PI_SESSION_HISTORY_CAPABILITY.parse(provider(() => Promise.resolve({ messages: "bad", start: 0, total: 0 })));
    await expect(invalid.readMessages({ projectId: "p", workspaceId: "w", sessionId: "s" })).rejects.toThrow("Invalid");
  });
});
