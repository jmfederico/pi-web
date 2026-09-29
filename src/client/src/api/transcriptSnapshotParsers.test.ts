import { describe, expect, it } from "vitest";
import { parseSessionTranscriptSnapshot } from "./parsers";

function snapshot() {
  return {
    page: { messages: [{ role: "user", content: "hello", entryId: "entry-1" }], start: 2, total: 3 },
    status: {
      sessionId: "session-1",
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: 0,
    },
    seq: 7,
    partial: null,
  };
}

describe("parseSessionTranscriptSnapshot", () => {
  it.each([null, { role: "assistant", content: [{ type: "text", text: "streaming" }] }, "opaque SDK payload"])("parses the complete snapshot with partial %j", (partial) => {
    const wire = { ...snapshot(), partial };
    expect(parseSessionTranscriptSnapshot(wire)).toEqual({
      ...wire,
      status: { ...wire.status, queuedMessages: [] },
    });
  });

  it("accepts an empty initial snapshot", () => {
    const wire = { ...snapshot(), page: { messages: [], start: 0, total: 0 }, seq: 0 };
    expect(parseSessionTranscriptSnapshot(wire)).toMatchObject({ page: wire.page, seq: 0, partial: null });
  });

  it.each(["page", "status", "seq", "partial"])("requires the %s field", (field) => {
    const wire = Object.fromEntries(Object.entries(snapshot()).filter(([key]) => key !== field));
    expect(() => parseSessionTranscriptSnapshot(wire)).toThrow();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "7", null])("rejects an invalid sequence %s", (seq) => {
    expect(() => parseSessionTranscriptSnapshot({ ...snapshot(), seq })).toThrow();
  });

  it.each([
    { page: [] },
    { page: { messages: null, start: 0, total: 0 } },
    { page: { messages: [], start: "0", total: 0 } },
    { page: { messages: [], start: 0, total: "0" } },
    { page: { messages: [{ entryId: 42 }], start: 0, total: 1 } },
    { status: null },
    { status: { ...snapshot().status, isStreaming: "true" } },
    { partial: undefined },
  ])("rejects malformed snapshot fields %j", (fields) => {
    expect(() => parseSessionTranscriptSnapshot({ ...snapshot(), ...fields })).toThrow();
  });
});
