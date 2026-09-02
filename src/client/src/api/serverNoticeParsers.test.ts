import { describe, expect, it } from "vitest";
import { parseRealtimeStreamEvent, parseServerNoticeSnapshot } from "./parsers";

const notice = {
  id: "daemon-a:notice-1",
  severity: "warning",
  message: "A warning",
  createdAt: "2026-08-01T00:00:00.000Z",
  source: "workspace.delete",
  context: { projectId: "project-1", workspaceId: "workspace-1" },
};

describe("server notice parsers", () => {
  it("parses snapshots and realtime frames with optional trace context", () => {
    const snapshot = { daemonInstanceId: "daemon-a", revision: 3, notices: [notice] };

    expect(parseServerNoticeSnapshot(snapshot)).toEqual(snapshot);
    expect(parseRealtimeStreamEvent({ type: "notices.updated", snapshot })).toEqual({ type: "notices.updated", snapshot });
  });

  it("rejects malformed notice identity, severity, timestamps, and duplicate ids", () => {
    expect(() => parseServerNoticeSnapshot({ daemonInstanceId: "daemon-a", revision: 0, notices: [{ ...notice, severity: "fatal" }] })).toThrow("severity");
    expect(() => parseServerNoticeSnapshot({ daemonInstanceId: "daemon-a", revision: 0, notices: [{ ...notice, createdAt: "not-a-time" }] })).toThrow("creation time");
    expect(() => parseServerNoticeSnapshot({ daemonInstanceId: "daemon-a", revision: 0, notices: [notice, notice] })).toThrow("Duplicate server notice id");
    expect(() => parseRealtimeStreamEvent({ type: "notices.updated", snapshot: { ...{ daemonInstanceId: "daemon-a", revision: 0, notices: [] }, revision: -1 } })).toThrow("safe integer");
  });
});
