import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../client/src/chatMessages.js";
import type { MessagePage } from "../shared/apiTypes.js";
import { projectBrowserMessage, projectBrowserMessageResponse, projectBrowserSessionEvent, projectBrowserTranscriptSnapshot } from "./browserMessageProjection.js";
import { SessionMediaIndex } from "./sessions/sessionMediaIndex.js";

function signedAssistantMessage() {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private chain", thinkingSignature: "opaque-provider-payload", redacted: true },
      { type: "text", text: "visible answer", textSignature: "text-metadata" },
      { type: "toolCall", name: "read", arguments: { thinkingSignature: "ordinary nested argument" }, thoughtSignature: "tool-metadata" },
    ],
    model: "model-1",
  };
}

describe("browser message projection", () => {
  it("omits only thinking-block signatures without mutating runtime messages", () => {
    const message = signedAssistantMessage();

    const projected = projectBrowserMessage(message);

    expect(projected).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private chain", redacted: true },
        { type: "text", text: "visible answer", textSignature: "text-metadata" },
        { type: "toolCall", name: "read", arguments: { thinkingSignature: "ordinary nested argument" }, thoughtSignature: "tool-metadata" },
      ],
      model: "model-1",
    });
    expect(message.content[0]).toEqual({ type: "thinking", thinking: "private chain", thinkingSignature: "opaque-provider-payload", redacted: true });
    expect(normalizeMessage(projected)).toEqual(normalizeMessage(message));
  });

  it("projects paged history responses", () => {
    const message = signedAssistantMessage();
    const page: MessagePage = { messages: [message], start: 4, total: 5 };

    expect(projectBrowserMessageResponse(page)).toEqual({
      messages: [{ ...message, content: [{ type: "thinking", thinking: "private chain", redacted: true }, ...message.content.slice(1)] }],
      start: 4,
      total: 5,
    });
    expect(page.messages[0]).toBe(message);
  });

  it("projects message events but leaves unrelated event shapes untouched", () => {
    const message = signedAssistantMessage();
    const finalEvent = { type: "message.end" as const, message };
    const appendEvent = { type: "message.append" as const, message };

    expect(projectBrowserSessionEvent(finalEvent)).toEqual({
      type: "message.end",
      message: { ...message, content: [{ type: "thinking", thinking: "private chain", redacted: true }, ...message.content.slice(1)] },
    });
    expect(projectBrowserSessionEvent(appendEvent)).toEqual({ ...appendEvent, message: projectBrowserMessage(message) });
    expect(finalEvent.message).toBe(message);
  });

  it("projects images in pages, snapshot partials, and every image-carrying event without URLs or mutation", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
    const image = Object.freeze({ type: "image", data, mimeType: "image/png" });
    const message = { role: "assistant", streamId: "stream-1", content: [...signedAssistantMessage().content, image] };
    const original = structuredClone(message);
    const index = new SessionMediaIndex();
    const images = (block: Record<string, unknown>) => index.reference({ id: "s1", cwd: "/workspace" }, block);
    const reference = images(image);
    const projectedMessage = { ...message, content: [{ type: "thinking", thinking: "private chain", redacted: true }, ...message.content.slice(1, -1), reference] };
    const page = { messages: [message], start: 0, total: 1 };
    expect(projectBrowserMessageResponse(page, images)).toEqual({ ...page, messages: [projectedMessage] });
    for (const type of ["assistant.start", "message.append", "message.end"] as const) {
      expect(projectBrowserSessionEvent({ type, message }, images)).toEqual({ type, message: projectedMessage });
    }
    for (const type of ["tool.update", "tool.end"] as const) {
      const fields = { toolName: "read", toolCallId: "call", text: "[image]", content: [image] };
      const event = type === "tool.end" ? { ...fields, type, isError: false } : { ...fields, type };
      expect(projectBrowserSessionEvent(event, images)).toEqual({ ...event, content: [reference] });
      expect(projectBrowserSessionEvent(event)).toBe(event);
    }
    const snapshot = { seq: 5, page, partial: message, status: { sessionId: "s1", isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } };
    expect(projectBrowserTranscriptSnapshot(snapshot, images)).toEqual({ ...snapshot, page: { ...page, messages: [projectedMessage] }, partial: projectedMessage });
    expect(message).toEqual(original);
    expect(reference).toMatchObject({ type: "image", mimeType: "image/png", byteSize: Buffer.from(data, "base64").byteLength, width: 1, height: 1 });
    expect(reference?.mediaId).toMatch(/^[0-9a-f]{64}$/u);
  });
});
