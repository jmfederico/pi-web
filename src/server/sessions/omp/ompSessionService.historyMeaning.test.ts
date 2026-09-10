import { describe, expect, it } from "vitest";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  ompRef,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  type OmpSessionStoreLike,
} from "./ompSessionService.testSupport.js";

async function readColdMessages(entries: unknown[]): Promise<unknown[]> {
  const store: OmpSessionStoreLike = {
    list: () => Promise.resolve([]),
    listAll: () => Promise.resolve([]),
    resolve: () => Promise.resolve({ path: "/session.jsonl", nativeId: TEST_NATIVE_ID_A }),
    messages: () => Promise.resolve(entries),
  };
  const factory = fakeRpcClientFactory();
  const service = new OmpSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    createRpcClient: factory,
    store,
  });

  const page = await service.messages(ompRef(TEST_NATIVE_ID_A));

  expect(factory.clients).toHaveLength(0);
  return page.messages;
}

describe("OmpSessionService: cold history retains browser-visible meaning", () => {
  it("preserves snapcompact text edges and image frames on a compaction summary", async () => {
    // Canonical archive validation and reconstruction:
    // @oh-my-pi/snapcompact/src/snapcompact.ts:1702-1732,1819-1868.
    // The browser needs the text/image blocks, not snapcompact's provider-side
    // byte budgeting or source archive metadata.
    const frame = { type: "image", data: "aW1hZ2U=", mimeType: "image/png", detail: "high" };
    const messages = await readColdMessages([
      {
        type: "compaction",
        id: "compact",
        parentId: null,
        timestamp: "2026-01-02T03:04:05.000Z",
        summary: "summary",
        shortSummary: "short",
        tokensBefore: 1_000,
        firstKeptEntryId: "missing",
        preserveData: {
          snapcompact: {
            frames: [{ ...frame, cols: 80, rows: 24, chars: 120 }],
            totalChars: 132,
            truncatedChars: 0,
            textHead: "oldest text",
            textTail: "newest text",
          },
        },
      },
    ]);

    expect(messages).toEqual([
      {
        role: "compactionSummary",
        summary: "summary",
        shortSummary: "short",
        tokensBefore: 1_000,
        blocks: [
          { type: "text", text: "oldest text\n-------------- imaged middle below\n" },
          frame,
          { type: "text", text: "-------------- imaged middle above\nnewest text" },
        ],
        images: [frame],
        timestamp: Date.parse("2026-01-02T03:04:05.000Z"),
      },
    ]);
  });

  it("retains the latest user request preceding an experimental context rollover window", async () => {
    // Canonical recovery: coding-agent session/session-context.ts:488-507.
    const recoveredRequest = { role: "user", content: "keep my actual request", timestamp: 10 };
    const keptAssistant = { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop", timestamp: 11 };
    const messages = await readColdMessages([
      { type: "message", id: "request", parentId: null, timestamp: "2026-01-02T03:04:01.000Z", message: recoveredRequest },
      { type: "message", id: "discarded", parentId: "request", timestamp: "2026-01-02T03:04:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "discarded tail" }], stopReason: "stop", timestamp: 10 } },
      { type: "message", id: "kept", parentId: "discarded", timestamp: "2026-01-02T03:04:03.000Z", message: keptAssistant },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept",
        timestamp: "2026-01-02T03:04:04.000Z",
        summary: "rolled context",
        tokensBefore: 800,
        firstKeptEntryId: "kept",
        details: { kind: "experimental-context-rollover" },
      },
    ]);

    expect(messages).toEqual([
      { role: "compactionSummary", summary: "rolled context", tokensBefore: 800, timestamp: Date.parse("2026-01-02T03:04:04.000Z") },
      recoveredRequest,
      keptAssistant,
    ]);
  });

});
