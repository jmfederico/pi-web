import { describe, expect, it } from "vitest";
import { messageHistoryTargetId } from "./messageHistoryTarget.js";

function assistant(id = "assistant", content: unknown = [{ type: "text", text: "Test message — A table" }]) {
  return { id, type: "message", message: { role: "assistant", content } };
}

function result(id: string, toolCallId: string, isError = false) {
  return { id, type: "message", message: { role: "toolResult", toolCallId, isError, content: [{ type: "text", text: "recorded output" }] } };
}

const user = { id: "user", type: "message", message: { role: "user", content: "Edit this prompt" } };
const laterAssistant = assistant("later");

describe("messageHistoryTargetId", () => {
  it("retains all intervening history until the next checkpoint without altering entries", () => {
    const branch = [
      user,
      assistant(),
      result("result-2", "call-2", true),
      { ...result("result-1", "call-1"), message: { ...result("result-1", "call-1").message, content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] } },
      { id: "name", type: "session_info" },
      { id: "system", type: "message", message: { role: "system", content: "Technical notice" } },
      { id: "shell", type: "message", message: { role: "bashExecution", output: "Recorded shell output" } },
      { id: "custom-message", type: "custom_message", content: "Notice", display: true },
      { id: "compaction", type: "compaction", summary: "Retained summary" },
      { id: "branch-summary", type: "branch_summary", summary: "Retained branch summary" },
      { id: "trailing-metadata", type: "custom" },
      laterAssistant,
    ];
    const original = structuredClone(branch);

    expect(messageHistoryTargetId(branch, "assistant")).toBe("trailing-metadata");
    expect(branch).toEqual(original);
  });

  it.each([
    user,
    laterAssistant,
    assistant("thinking-only", [{ type: "thinking", thinking: "A distinct thinking checkpoint" }]),
    assistant("image-only", [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]),
  ])("stops before the next distinct $id checkpoint", (checkpoint) => {
    const branch = [assistant(), result("result-1", "call-1"), checkpoint, result("result-2", "call-2")];
    expect(messageHistoryTargetId(branch, "assistant")).toBe("result-1");
  });

  it("keeps tool-only assistant work and results in the preceding checkpoint", () => {
    const branch = [
      assistant(),
      assistant("technical", [
        { type: "thinking", thinking: "" },
        { type: "text", text: "" },
        { type: "toolCall", id: "another-call", name: "read", arguments: { path: "file" } },
      ]),
      result("another-result", "another-call"),
      { id: "label", type: "label" },
      laterAssistant,
    ];
    expect(messageHistoryTargetId(branch, "assistant")).toBe("label");
  });

  it("treats thinking and text within one stored message as one checkpoint", () => {
    const branch = [assistant("combined", [
      { type: "thinking", thinking: "Considering user testing messages" },
      { type: "text", text: "Test message 8/10 — Emoji and Unicode" },
      { type: "toolCall", id: "call", name: "bash", arguments: { command: "printf test" } },
    ]), result("result", "call"), laterAssistant];
    expect(messageHistoryTargetId(branch, "combined")).toBe("result");
  });

  it("preserves user-message editor semantics instead of including subsequent history", () => {
    expect(messageHistoryTargetId([user, { id: "metadata", type: "session_info" }, laterAssistant], "user")).toBe("user");
  });

  it("includes the complete tail when there is no later checkpoint and does not invent results", () => {
    expect(messageHistoryTargetId([assistant()], "assistant")).toBe("assistant");
    expect(messageHistoryTargetId([assistant(), { id: "metadata", type: "label" }], "assistant")).toBe("metadata");
    expect(messageHistoryTargetId([assistant(), result("result", "call")], "result")).toBe("result");
  });

  it("rejects a message absent from the supplied active branch rather than choosing another branch", () => {
    expect(() => messageHistoryTargetId([user, assistant()], "other-branch"))
      .toThrow("no longer available on the active session branch");
  });
});
