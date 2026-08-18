import type { TemplateResult } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
// Vitest runs in the node environment with no DOM, so menu/bulk-bar wiring is
// verified through the shared TemplateResult inspection escape hatch: handler
// lookups stay anchored to the buttons' own user-facing text.
import {
  findOptionalTemplateClickHandlerForText,
  isTemplateEventHandler,
  isTemplateResult,
  templateClickHandlerForText,
  templateStrings,
  templateValues,
  type TemplateEventHandler,
} from "../templateInspection.testSupport";
import { SessionList, sessionRowActivityKind, sessionRowsForCurrentTree, sessionRowUnread, unreadSessionCount } from "./SessionList";

describe("sessionRowActivityKind", () => {
  const idle = sessionStatus("s");

  it("reports 'sending' for an uploading session, taking precedence over server activity", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, true)).toBe("sending");
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, true)).toBe("sending");
  });

  it("reports 'session' for server activity when not sending", () => {
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, false)).toBe("session");
  });

  it("shows no active-work indicator for a session that is only starting up", () => {
    const startup = { sessionId: "s", phase: "active" as const, label: "Opening session", detail: "Starting the Pi session", at: "now", startup: true };

    expect(sessionRowActivityKind(session("s"), idle, startup, false)).toBeUndefined();
    // Ordinary activity is work and keeps its indicator.
    expect(sessionRowActivityKind(session("s"), idle, { sessionId: "s", phase: "active", label: "running tool", at: "now" }, false)).toBe("session");
  });

  it("reports undefined when idle and not sending, even for an unread session", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, false)).toBeUndefined();
  });

  it("never shows an indicator for archived or cached-new sessions, even while sending", () => {
    expect(sessionRowActivityKind({ ...session("s"), archived: true }, idle, undefined, true)).toBeUndefined();
    expect(sessionRowActivityKind(markCachedNewSessionInfo(session("s")), idle, undefined, true)).toBeUndefined();
  });
});

describe("sessionRowUnread", () => {
  it("flags tracked current sessions regardless of activity state", () => {
    expect(sessionRowUnread(session("s"), new Set(["s"]))).toBe(true);
    expect(sessionRowUnread(session("s"), new Set())).toBe(false);
  });

  it("never flags archived or cached-new sessions, even when tracked as unread", () => {
    expect(sessionRowUnread({ ...session("s"), archived: true }, new Set(["s"]))).toBe(false);
    expect(sessionRowUnread(markCachedNewSessionInfo(session("s")), new Set(["s"]))).toBe(false);
  });
});

describe("unreadSessionCount", () => {
  it("counts only current persisted sessions, including busy ones", () => {
    const current = session("current");
    const archived = { ...session("archived"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const cached = markCachedNewSessionInfo(session("cached"));

    const unreadIds = new Set([current.id, archived.id, cached.id]);
    expect(unreadSessionCount([current, archived, cached], unreadIds)).toBe(1);
  });
});

describe("session action eligibility", () => {
  it("requires a persisted server signal before archiving", () => {
    expect(isArchivableSessionInfo(session("persisted", { persisted: true }))).toBe(true);
    expect(isArchivableSessionInfo(session("unknown"))).toBe(false);
    expect(isArchivableSessionInfo(session("transient", { persisted: false }))).toBe(false);
    expect(isArchivableSessionInfo({ ...session("archived", { persisted: true }), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" })).toBe(false);
  });

  it("allows deleting transient non-archived sessions from server or browser-cached signals", () => {
    expect(isTransientNewSessionInfo(session("transient", { persisted: false }))).toBe(true);
    expect(isTransientNewSessionInfo(markCachedNewSessionInfo(session("cached")))).toBe(true);
    expect(isTransientNewSessionInfo(session("persisted", { persisted: true }))).toBe(false);
    expect(isTransientNewSessionInfo({ ...session("archived", { persisted: false }), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" })).toBe(false);
  });

  it("uses matching status as the freshest persistence signal", () => {
    const staleTransient = session("s", { persisted: false });
    expect(isArchivableSessionInfo(staleTransient, sessionStatus("s", { persisted: true }))).toBe(true);
    expect(isTransientNewSessionInfo(staleTransient, sessionStatus("s", { persisted: true }))).toBe(false);

    const stalePersisted = session("s", { persisted: true });
    expect(isArchivableSessionInfo(stalePersisted, sessionStatus("s", { persisted: false }))).toBe(false);
    expect(isTransientNewSessionInfo(stalePersisted, sessionStatus("s", { persisted: false }))).toBe(true);

    expect(isArchivableSessionInfo(staleTransient, sessionStatus("other", { persisted: true }))).toBe(false);
  });
});

describe("mark-as-read actions", () => {
  it("offers Mark as read in the menu of an unread current session and forwards it", () => {
    const unread = session("unread");
    const list = sessionList([unread, session("read")], new Set([unread.id]));
    const onMarkRead = vi.fn<(session: SessionInfo) => void>();
    list.onMarkRead = onMarkRead;

    openSessionMenu(list, unread.id);
    templateClickHandlerForText(renderList(list), "Mark as read")(new Event("click"));

    expect(onMarkRead).toHaveBeenCalledWith(unread);
    expect(componentState(list, "openMenuSessionId")).toBeUndefined();
  });

  it("hides Mark as read for read, transient, and archived sessions even when tracked as unread", () => {
    const read = session("read");
    const cached = markCachedNewSessionInfo(session("cached"));
    const archived = { ...session("archived"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const list = sessionList([read, cached, archived], new Set([cached.id, archived.id]));

    openSessionMenu(list, read.id);
    expect(findOptionalTemplateClickHandlerForText(renderList(list), "Mark as read")).toBeUndefined();

    openSessionMenu(list, cached.id);
    expect(findOptionalTemplateClickHandlerForText(renderList(list), "Mark as read")).toBeUndefined();

    setComponentState(list, "archivedExpanded", true);
    openSessionMenu(list, archived.id);
    expect(findOptionalTemplateClickHandlerForText(renderList(list), "Mark as read")).toBeUndefined();
  });

  it("enables bulk Mark read only when a selected session is unread and forwards only the unread selection", () => {
    const unreadA = session("unread-a");
    const readB = session("read-b");
    const unreadC = session("unread-c");
    const list = sessionList([unreadA, readB, unreadC], new Set([unreadA.id, unreadC.id]));
    const onMarkReadMany = vi.fn<(sessions: SessionInfo[]) => void>();
    list.onMarkReadMany = onMarkReadMany;
    setComponentState(list, "selectionScopes", new Set(["current"]));

    setComponentState(list, "selectedSessionIds", new Set([readB.id]));
    const disabledButton = markReadButton(renderList(list));
    expect(disabledButton.disabled).toBe(true);
    disabledButton.click(new Event("click"));
    expect(onMarkReadMany).not.toHaveBeenCalled();

    setComponentState(list, "selectedSessionIds", new Set([unreadA.id, readB.id, unreadC.id]));
    const enabledButton = markReadButton(renderList(list));
    expect(enabledButton.disabled).toBe(false);
    enabledButton.click(new Event("click"));
    expect(onMarkReadMany).toHaveBeenCalledWith([unreadA, unreadC]);
  });
});

describe("sessionRowsForCurrentTree", () => {
  it("keeps archived ancestors visible while they have unarchived descendants", () => {
    const parent = { ...session("parent"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const child = session("child", { parentSessionPath: parent.path });

    expect(rowSummaries(sessionRowsForCurrentTree([parent, child]))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
      { id: "child", depth: 1, hasMissingParent: false },
    ]);
  });

  it("hides archived parents from the current tree once children are detached", () => {
    const parent = { ...session("parent"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const detachedChild = session("child");

    expect(rowSummaries(sessionRowsForCurrentTree([parent, detachedChild]))).toEqual([
      { id: "child", depth: 0, hasMissingParent: false },
    ]);
  });

  it("nests a child whose recorded parent path differs only by a trailing separator", () => {
    // A session.created broadcast carries the live runtime's file path, while the
    // listed parent's path comes from the session store enumeration.
    const parent = session("parent");
    const child = session("child", { parentSessionPath: `${parent.path}/` });

    expect(rowSummaries(sessionRowsForCurrentTree([parent, child]))).toEqual([
      { id: "parent", depth: 0, hasMissingParent: false },
      { id: "child", depth: 1, hasMissingParent: false },
    ]);
  });

  it("still marks unavailable parents when the parent record is missing", () => {
    const child = session("child", { parentSessionPath: "/sessions/missing.jsonl" });

    expect(rowSummaries(sessionRowsForCurrentTree([child]))).toEqual([
      { id: "child", depth: 0, hasMissingParent: true },
    ]);
  });
});

function rowSummaries(rows: ReturnType<typeof sessionRowsForCurrentTree>) {
  return rows.map((row) => ({ id: row.session.id, depth: row.depth, hasMissingParent: row.hasMissingParent }));
}

function sessionList(sessions: SessionInfo[], unreadSessionIds: ReadonlySet<string>): SessionList {
  const list = new SessionList();
  list.sessions = sessions;
  list.unreadSessionIds = unreadSessionIds;
  return list;
}

function renderList(list: SessionList): TemplateResult {
  return list.render();
}

function openSessionMenu(list: SessionList, sessionId: string): void {
  setComponentState(list, "openMenuSessionId", sessionId);
}

function componentState(list: SessionList, property: string): unknown {
  return Reflect.get(list, property);
}

function setComponentState(list: SessionList, property: string, value: unknown): void {
  if (!Reflect.set(list, property, value)) throw new Error(`Could not set session list property ${property}`);
}

// Locates the bulk "Mark read" button inside the selection toolbar template,
// anchored to the button's own static text so unrelated toolbar changes do not
// break the lookup. The disabled binding sits immediately before its @click.
function markReadButton(template: TemplateResult): { disabled: boolean; click: TemplateEventHandler } {
  const host = findTemplateWithStaticText(template, ">Mark read</button>");
  const strings = templateStrings(host);
  const values = templateValues(host);
  for (let index = 0; index < values.length; index += 1) {
    if (strings[index + 1]?.includes(">Mark read</button>") !== true) continue;
    const click = values[index];
    const disabled = values[index - 1];
    if (!isTemplateEventHandler(click) || typeof disabled !== "boolean") throw new Error("Mark read button wiring is unavailable");
    return { disabled, click };
  }
  throw new Error("Expected a click handler before >Mark read</button>");
}

function findTemplateWithStaticText(value: unknown, text: string): TemplateResult {
  const found = findOptionalTemplateWithStaticText(value, text);
  if (found === undefined) throw new Error(`Expected template containing ${text}`);
  return found;
}

function findOptionalTemplateWithStaticText(value: unknown, text: string): TemplateResult | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOptionalTemplateWithStaticText(item, text);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplateResult(value)) return undefined;
  if (templateStrings(value).some((chunk) => chunk.includes(text))) return value;
  for (const item of templateValues(value)) {
    const found = findOptionalTemplateWithStaticText(item, text);
    if (found !== undefined) return found;
  }
  return undefined;
}


function sessionStatus(sessionId: string, overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    pendingMessageCount: 0,
    queuedMessages: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
