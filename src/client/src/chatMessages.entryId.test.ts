import { describe, expect, it } from "vitest";
import { normalizeMessage, normalizeMessages, textMessage, withMessageMeta } from "./chatMessages";
import { parseMessagePage } from "./api/parsers";

describe("chat entry IDs", () => {
  it("preserves identity on every line produced by a skill invocation or assistant error", () => {
    const skill = normalizeMessage({ role: "user", entryId: "skill-1", content: '<skill name="demo" location="/skills/demo">\nInstructions\n</skill>\n\nDo this' });
    expect(skill).toHaveLength(2);
    expect(skill.map((line) => line.entryId)).toEqual(["skill-1", "skill-1"]);
    const error = normalizeMessage({ role: "assistant", entryId: "error-1", content: "partial", stopReason: "error", errorMessage: "failed" });
    expect(error).toHaveLength(2);
    expect(error.map((line) => line.entryId)).toEqual(["error-1", "error-1"]);
  });

  it("keeps the assistant entry ID when tool calls are split out and results coalesced", () => {
    const lines = normalizeMessages([
      { role: "assistant", entryId: "assistant-1", content: [{ type: "text", text: "Checking" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] },
      { role: "toolResult", entryId: "result-1", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "/repo" }] },
    ]);
    expect(lines.map((line) => line.entryId)).toEqual(["assistant-1", "assistant-1"]);
    expect(lines[1]?.parts[0]).toMatchObject({ type: "toolExecution", status: "success" });
  });

  it("keeps optimistic/streaming lines unidentified until authoritative metadata arrives", () => {
    const line = textMessage("assistant", "answer");
    expect(line).not.toHaveProperty("entryId");
    expect(withMessageMeta(line, { id: "provider-id" })).not.toHaveProperty("entryId");
    expect(withMessageMeta(line, { entryId: "entry-1" })).toEqual({ ...line, entryId: "entry-1" });
    expect(normalizeMessage({ ...line, entryId: "entry-1" })[0]?.entryId).toBe("entry-1");
  });

  it("preserves opaque API payloads and rejects malformed entry IDs", () => {
    const messages = [{ role: "user", entryId: "entry-1", content: "hi", extensionData: { custom: true } }, { role: "assistant", content: "legacy" }, "legacy opaque payload"];
    expect(parseMessagePage({ messages, start: 0, total: 3 }).messages).toEqual(messages);
    for (const entryId of [42, null, {}, []]) {
      expect(() => parseMessagePage({ messages: [{ entryId }], start: 0, total: 1 })).toThrow("Expected string field: entryId");
    }
  });
});
