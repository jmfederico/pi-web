import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../client/src/chatMessages.js";
import type { MessagePage } from "../shared/apiTypes.js";
import { projectBrowserMessage, projectBrowserMessageResponse, projectBrowserSessionEvent } from "./browserMessageProjection.js";

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

  it("projects final-message events but leaves other event shapes untouched", () => {
    const message = signedAssistantMessage();
    const finalEvent = { type: "message.end" as const, message };
    const appendEvent = { type: "message.append" as const, message };

    expect(projectBrowserSessionEvent(finalEvent)).toEqual({
      type: "message.end",
      message: { ...message, content: [{ type: "thinking", thinking: "private chain", redacted: true }, ...message.content.slice(1)] },
    });
    expect(projectBrowserSessionEvent(appendEvent)).toBe(appendEvent);
    expect(finalEvent.message).toBe(message);
  });

  it("replaces oversized inline images with media references and keeps small ones inline", () => {
    const bigData = "A".repeat(80 * 1024);
    const smallData = "c2hvcnQtaW1hZ2U=";
    const message = {
      role: "toolResult",
      toolName: "read",
      content: [
        { type: "image", mimeType: "image/png", data: bigData },
        { type: "image", mimeType: "image/png", data: smallData },
      ],
    };
    const mediaIds: string[] = [];
    const projected = projectBrowserMessage(message, {
      inlineLimit: 64 * 1024,
      mediaSrc: (mediaId) => {
        mediaIds.push(mediaId);
        return `api/machines/local/sessions/s1/media/${mediaId}?cwd=%2Frepo`;
      },
    });

    expect(projected).toEqual({
      role: "toolResult",
      toolName: "read",
      content: [
        { type: "image", mimeType: "image/png", src: `api/machines/local/sessions/s1/media/${mediaIds[0] ?? ""}?cwd=%2Frepo`, byteSize: 60 * 1024 },
        { type: "image", mimeType: "image/png", data: smallData },
      ],
    });
    expect(mediaIds).toHaveLength(1);
    expect(message.content[0]).toEqual({ type: "image", mimeType: "image/png", data: bigData });
  });

  it("keeps oversized images inline when no media source is available", () => {
    const bigData = "A".repeat(80 * 1024);
    const message = { role: "toolResult", content: [{ type: "image", mimeType: "image/png", data: bigData }] };

    expect(projectBrowserMessage(message)).toBe(message);
  });
});
