import { describe, expect, it, vi } from "vitest";
import { Check } from "pi-web-typebox/value";
import { stubExtensionToolContext } from "./piSessionService.testSupport.js";
import { createSendSessionMessageToolDefinition, type SendSessionMessageToolDeps } from "./sendSessionMessageTool.js";

describe("createSendSessionMessageToolDefinition", () => {
  it("exposes only the target and message, not sender identity or workspace overrides", () => {
    const tool = createSendSessionMessageToolDefinition("/repos/a", { send: vi.fn() });

    expect(tool.name).toBe("send_session_message");
    expect(tool.exposure ?? "direct").toBe("direct");
    expect(tool.parameters).toHaveProperty("required", ["sessionId", "message"]);
    expect(tool.parameters).not.toHaveProperty(["properties", "sendingSessionId"]);
    expect(tool.parameters).not.toHaveProperty(["properties", "sendingCwd"]);
    expect(Check(tool.parameters, { sessionId: "target", message: "Review is ready" })).toBe(true);
    expect(Check(tool.parameters, { message: "Review is ready" })).toBe(false);
    expect(Check(tool.parameters, { sessionId: "target" })).toBe(false);
  });

  it("derives the internal sender from the live context and scopes delivery to the factory workspace", async () => {
    const send = vi.fn<SendSessionMessageToolDeps["send"]>(() => Promise.resolve({ sessionId: "target", delivery: "started" }));
    const tool = createSendSessionMessageToolDefinition("/repos/a", { send });
    let sendingSessionId = "sender-1";
    const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => sendingSessionId } });
    const params = {
      sessionId: "target",
      message: "Review is ready\nPlease continue.",
      sendingSessionId: "forged-sender",
      sendingCwd: "/repos/other",
    };

    const result = await tool.execute("send-1", params, undefined, undefined, ctx);
    sendingSessionId = "sender-2";
    await tool.execute("send-2", params, undefined, undefined, ctx);

    expect(send).toHaveBeenNthCalledWith(1, {
      sendingCwd: "/repos/a",
      sendingSessionId: "sender-1",
      sessionId: "target",
      message: params.message,
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      sendingCwd: "/repos/a",
      sendingSessionId: "sender-2",
      sessionId: "target",
      message: params.message,
    });
    expect(result.details).toEqual({ sessionId: "target", delivery: "started" });
    expect(JSON.stringify(result)).not.toContain("sender-");
  });

  it.each(["started", "queued"] as const)("reports %s delivery without ending the sender's run", async (delivery) => {
    const send = vi.fn<SendSessionMessageToolDeps["send"]>(() => Promise.resolve({ sessionId: "target", delivery }));
    const tool = createSendSessionMessageToolDefinition("/repos/a", { send });
    const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => "sender" } });

    const result = await tool.execute("send", { sessionId: "target", message: "Continue" }, undefined, undefined, ctx);

    expect(result.details).toEqual({ sessionId: "target", delivery });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("target");
    expect(result.terminate).toBeUndefined();
  });

  it("propagates delivery failures instead of reporting a queued or started message", async () => {
    const error = new Error("Target session is outside the sending project");
    const send = vi.fn<SendSessionMessageToolDeps["send"]>(() => Promise.reject(error));
    const tool = createSendSessionMessageToolDefinition("/repos/a", { send });
    const ctx = stubExtensionToolContext({ sessionManager: { getSessionId: () => "sender" } });

    await expect(tool.execute("send", { sessionId: "target", message: "Continue" }, undefined, undefined, ctx))
      .rejects.toBe(error);
  });
});
