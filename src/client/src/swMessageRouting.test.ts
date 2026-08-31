import { describe, expect, it, vi } from "vitest";
import { handleServiceWorkerSessionMessage, OPEN_SESSION_ACK_MESSAGE_TYPE } from "./swMessageRouting";

function messageWithData(data: unknown, withSource = true) {
  const postMessage = vi.fn();
  return {
    message: { data, ...(withSource ? { source: { postMessage } } : { source: null }) },
    postMessage,
  };
}

describe("handleServiceWorkerSessionMessage", () => {
  it("opens the session and acks through the message source", () => {
    const { message, postMessage } = messageWithData({ type: "pi-web:open-session", sessionId: "abc", requestId: "r-1" });
    const openSession = vi.fn();

    expect(handleServiceWorkerSessionMessage(message, openSession)).toBe(true);
    expect(openSession).toHaveBeenCalledWith({ sessionId: "abc", cwd: undefined });
    expect(postMessage).toHaveBeenCalledWith({ type: OPEN_SESSION_ACK_MESSAGE_TYPE, requestId: "r-1" });
  });

  it("passes a usable cwd through to the routing target", () => {
    const { message } = messageWithData({ type: "pi-web:open-session", sessionId: "abc", cwd: "/repo/app" });
    const openSession = vi.fn();
    expect(handleServiceWorkerSessionMessage(message, openSession)).toBe(true);
    expect(openSession).toHaveBeenCalledWith({ sessionId: "abc", cwd: "/repo/app" });
  });

  it("drops empty and non-string cwd values", () => {
    const openSession = vi.fn();
    handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session", sessionId: "abc", cwd: "" }).message, openSession);
    handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session", sessionId: "abc", cwd: 7 }).message, openSession);
    expect(openSession).toHaveBeenNthCalledWith(1, { sessionId: "abc", cwd: undefined });
    expect(openSession).toHaveBeenNthCalledWith(2, { sessionId: "abc", cwd: undefined });
  });

  it("ignores non-object data and unrelated message types", () => {
    const openSession = vi.fn();
    expect(handleServiceWorkerSessionMessage(messageWithData(undefined).message, openSession)).toBe(false);
    expect(handleServiceWorkerSessionMessage(messageWithData("pi-web:open-session").message, openSession)).toBe(false);
    expect(handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:clear-push-notifications" }).message, openSession)).toBe(false);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("ignores open-session requests without a usable session id", () => {
    const openSession = vi.fn();
    expect(handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session" }).message, openSession)).toBe(false);
    expect(handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session", sessionId: "" }).message, openSession)).toBe(false);
    expect(handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session", sessionId: 42 }).message, openSession)).toBe(false);
    expect(openSession).not.toHaveBeenCalled();
  });

  it("still opens the session when there is no ack path", () => {
    const { message } = messageWithData({ type: "pi-web:open-session", sessionId: "abc" }, false);
    const openSession = vi.fn();
    expect(() => {
      expect(handleServiceWorkerSessionMessage(message, openSession)).toBe(true);
    }).not.toThrow();
    expect(openSession).toHaveBeenCalledWith({ sessionId: "abc", cwd: undefined });
  });

  it("passes canonical project and workspace ids through for direct routing", () => {
    const { message } = messageWithData({ type: "pi-web:open-session", sessionId: "abc", cwd: "/repo", projectId: "p1", workspaceId: "w1" });
    const openSession = vi.fn();
    expect(handleServiceWorkerSessionMessage(message, openSession)).toBe(true);
    expect(openSession).toHaveBeenCalledWith({ sessionId: "abc", cwd: "/repo", projectId: "p1", workspaceId: "w1" });
  });

  it("drops empty and non-string id values like it does for cwd", () => {
    const openSession = vi.fn();
    handleServiceWorkerSessionMessage(messageWithData({ type: "pi-web:open-session", sessionId: "abc", projectId: "", workspaceId: 12 }).message, openSession);
    expect(openSession).toHaveBeenCalledWith({ sessionId: "abc", cwd: undefined, projectId: undefined, workspaceId: undefined });
  });
});
