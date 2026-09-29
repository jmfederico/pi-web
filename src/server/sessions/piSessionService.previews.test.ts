import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import type { ArchiveSessionInput, ArchivedSessionRecord } from "./sessionArchiveStore.js";
import { CapturingSessionEventHub, emptyArchiveStore, sessionGateway, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";

const firstMessage = "x".repeat(253_702);
const expectedPreview = `${"x".repeat(509)}...`;

// Exercise the public service boundary, not just the truncation helper.
describe("PiSessionService first-message previews", () => {
  it("bounds active list previews but passes the complete message to archive storage", async () => {
    const record = { ...sessionRecord("active"), messageCount: 1, firstMessage, allMessagesText: firstMessage };
    const archive = vi.fn((input: ArchiveSessionInput) => Promise.resolve({
      sessionId: input.sessionId,
      cwd: input.cwd,
      archivedAt: "2026-01-03T00:00:00.000Z",
    }));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([record]),
      archiveStore: { ...emptyArchiveStore(), archive },
      heartbeatIntervalMs: 60_000,
    });

    try {
      expect(await service.list(record.cwd)).toMatchObject([{ id: record.id, firstMessage: expectedPreview }]);
      expect(record.firstMessage).toBe(firstMessage);
      expect(record.allMessagesText).toBe(firstMessage);

      expect(await service.archiveMany([{ id: record.id, cwd: record.cwd }])).toMatchObject({
        archived: true,
        archivedSessionIds: [record.id],
        failures: [],
      });
      expect(archive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: record.id, firstMessage }));
    } finally {
      await service.dispose();
    }
  });

  it.each(["stored record", "legacy fallback"] as const)("bounds archived previews from the %s without mutating the source", async (source) => {
    const listed = { ...sessionRecord("archived"), messageCount: 1, firstMessage, allMessagesText: firstMessage };
    const archived: ArchivedSessionRecord = {
      sessionId: listed.id,
      cwd: listed.cwd,
      archivedAt: "2026-01-03T00:00:00.000Z",
      ...(source === "stored record" ? {
        originalPath: listed.path,
        archivePath: "/archive/archived.jsonl",
        created: listed.created.toISOString(),
        modified: listed.modified.toISOString(),
        messageCount: listed.messageCount,
        firstMessage,
      } : {}),
    };
    const originalArchived = { ...archived };
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent",
      modelRuntime: testModelRuntime,
      sessionManager: sessionGateway(source === "legacy fallback" ? [listed] : []),
      archiveStore: { ...emptyArchiveStore(), list: () => Promise.resolve([archived]) },
      heartbeatIntervalMs: 60_000,
    });

    try {
      expect(await service.list(listed.cwd)).toMatchObject([{
        id: listed.id,
        archived: true,
        firstMessage: expectedPreview,
      }]);
      expect(archived).toEqual(originalArchived);
      expect(listed.firstMessage).toBe(firstMessage);
      expect(listed.allMessagesText).toBe(firstMessage);
    } finally {
      await service.dispose();
    }
  });
});
