import { describe, expect, it } from "vitest";
import { deriveDocumentTitle } from "./documentTitle";
import type { SessionActivity, SessionInfo, SessionStatus } from "./api";

function testSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session-abc12345678",
    path: "/tmp/project/.pi/sessions/session-abc12345678.json",
    cwd: "/tmp/project",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "",
    ...overrides,
  };
}

function testStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-abc12345678",
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    pendingMessageCount: 0,
    persisted: false,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

function idleActivity(): SessionActivity {
  return { phase: "idle", sessionId: "session-abc12345678", label: "Idle", at: "2026-01-01T00:00:00.000Z" };
}

describe("deriveDocumentTitle", () => {
  it("returns brand when no session is selected", () => {
    expect(deriveDocumentTitle(undefined, undefined, undefined)).toBe("PI WEB");
  });

  it("uses session name when available", () => {
    const session = testSession({ name: "My Chat", firstMessage: "Hello world" });
    expect(deriveDocumentTitle(session, testStatus(), idleActivity())).toBe("My Chat — PI WEB");
  });

  it("falls back to firstMessage when name is empty", () => {
    const session = testSession({ firstMessage: "Explain TypeScript generics" });
    expect(deriveDocumentTitle(session, testStatus(), idleActivity())).toBe("Explain TypeScript generics — PI WEB");
  });

  it("falls back to short session id when name and firstMessage are empty", () => {
    const session = testSession({ firstMessage: "" });
    expect(deriveDocumentTitle(session, testStatus(), idleActivity())).toBe("12345678 — PI WEB");
  });

  it("prepends streaming indicator when session is active", () => {
    const session = testSession({ name: "Debug session" });
    const status = testStatus({ isStreaming: true });
    expect(deriveDocumentTitle(session, status, idleActivity())).toBe("● Debug session — PI WEB");
  });

  it("prepends indicator when bash is running", () => {
    const session = testSession({ firstMessage: "Run the tests" });
    const status = testStatus({ isBashRunning: true });
    expect(deriveDocumentTitle(session, status, idleActivity())).toBe("● Run the tests — PI WEB");
  });

  it("prepends indicator when session activity phase is active", () => {
    const session = testSession({ firstMessage: "Fix the bug" });
    const activity: SessionActivity = { phase: "active", sessionId: "session-abc12345678", label: "Working", at: "2026-01-01T00:00:00.000Z" };
    expect(deriveDocumentTitle(session, testStatus(), activity)).toBe("● Fix the bug — PI WEB");
  });

  it("appends archived suffix for archived sessions", () => {
    const session = testSession({ name: "Old review", archived: true, archivedAt: "2026-05-01T00:00:00.000Z" });
    expect(deriveDocumentTitle(session, undefined, undefined)).toBe("Old review (archived) — PI WEB");
  });

  it("combines streaming indicator and archived suffix", () => {
    const session = testSession({ firstMessage: "Archived stream", archived: true });
    const status = testStatus({ isStreaming: true });
    expect(deriveDocumentTitle(session, status, idleActivity())).toBe("● Archived stream (archived) — PI WEB");
  });

  it("uses trimmed name", () => {
    const session = testSession({ name: "  Padded Chat  " });
    expect(deriveDocumentTitle(session, testStatus(), idleActivity())).toBe("Padded Chat — PI WEB");
  });

  it("treats whitespace-only name as empty and falls back", () => {
    const session = testSession({ name: "   ", firstMessage: "Actual message" });
    expect(deriveDocumentTitle(session, testStatus(), idleActivity())).toBe("Actual message — PI WEB");
  });
});