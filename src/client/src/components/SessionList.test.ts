// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionStatus } from "../api";
import { markCachedNewSessionInfo } from "../cachedNewSessions";
import { isArchivableSessionInfo, isTransientNewSessionInfo } from "../sessionPersistence";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { SessionList, sessionRowActivityKind, sessionRowsForCurrentTree, sessionRowUnread, unreadSessionCount } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("sessionRowActivityKind", () => {
  const idle = sessionStatus("s");

  it("reports 'sending' for an uploading session, taking precedence over server activity", () => {
    expect(sessionRowActivityKind(session("s"), idle, undefined, true)).toBe("sending");
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, true)).toBe("sending");
  });

  it("restores persisted intervention, then honors a matching live false when work resumes", () => {
    const waiting = session("s", { interventionRequired: true });
    expect(sessionRowActivityKind(waiting, undefined, undefined, false)).toBe("intervention-required");
    expect(sessionRowActivityKind(waiting, sessionStatus("other", { interventionRequired: false }), undefined, false)).toBe("intervention-required");
    expect(sessionRowActivityKind(waiting, { ...idle, interventionRequired: false, isStreaming: true }, undefined, false)).toBe("session");
    expect(sessionRowActivityKind(waiting, { ...idle, interventionRequired: false }, undefined, false, { s: { "core:intervention-required": true } })).toBe("intervention-required");
  });

  it("clears stale status and listing attention from a complete snapshot", () => {
    const waiting = session("s", { interventionRequired: true });
    const staleStatus = { ...idle, interventionRequired: true };
    expect(sessionRowActivityKind(waiting, staleStatus, undefined, false, {})).toBeUndefined();
    expect(sessionRowActivityKind(waiting, staleStatus, undefined, false, { s: { "core:working": true } })).toBe("session");
    expect(sessionRowActivityKind(waiting, staleStatus, undefined, false, { s: { "core:intervention-required": false } })).toBeUndefined();
  });

  it("prioritizes live and machine intervention over working and sending", () => {
    expect(sessionRowActivityKind(session("s"), { ...idle, interventionRequired: true }, undefined, true)).toBe("intervention-required");
    expect(sessionRowActivityKind(session("s"), undefined, undefined, false, { s: { "core:intervention-required": true, "core:working": true } })).toBe("intervention-required");
    expect(sessionRowActivityKind(session("s", { archived: true, interventionRequired: true }), undefined, undefined, false)).toBeUndefined();
  });

  it("reports 'session' for server activity when not sending", () => {
    expect(sessionRowActivityKind(session("s"), { ...idle, isStreaming: true }, undefined, false)).toBe("session");
  });

  it("uses the complete daemon projection instead of stale chat status and activity", () => {
    const staleStatus = { ...idle, isStreaming: true };
    const staleActivity = { sessionId: "s", phase: "active" as const, label: "Working", at: "now" };
    expect(sessionRowActivityKind(session("s"), staleStatus, staleActivity, false, {})).toBeUndefined();
    expect(sessionRowActivityKind(session("s"), idle, undefined, false, { s: { "core:working": true } })).toBe("session");
    expect(sessionRowActivityKind(session("s"), idle, undefined, true, {})).toBe("sending");
    // Older daemons omit the projection and retain event-based compatibility.
    expect(sessionRowActivityKind(session("s"), staleStatus, staleActivity, false, undefined)).toBe("session");
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

describe("intervention navigation", () => {
  it("renders persisted attention and clears it on a working snapshot without changing unread", async () => {
    const waiting = session("waiting", { persisted: true, interventionRequired: true });
    const list = sessionList([waiting], new Set([waiting.id]));
    document.body.append(list);
    await list.updateComplete;
    const row = list.shadowRoot?.querySelector<HTMLElement>(".action-row");
    expect(row?.classList.contains("intervention-required")).toBe(true);
    expect(row?.getAttribute("data-busy")).toBe("false");
    expect(row?.querySelector(".session-meta")?.textContent).toContain("Needs input");
    expect(row?.querySelector(".unread-ring .intervention-required")).not.toBeNull();

    list.sessionFlags = { waiting: { "core:working": true, "core:intervention-required": true } };
    await list.updateComplete;
    expect(row?.getAttribute("data-busy")).toBe("true");
    expect(row?.getAttribute("data-activity")).toBe("intervention-required");
    await openSessionMenu(list, waiting.id);
    const reload = [...list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-panel button") ?? []]
      .find((button) => button.textContent === "Reload from disk");
    expect(reload?.disabled).toBe(true);

    list.statuses = { waiting: sessionStatus("waiting", { interventionRequired: false, isStreaming: true }) };
    list.sessionFlags = { waiting: { "core:working": true } };
    await list.updateComplete;
    expect(row?.classList.contains("intervention-required")).toBe(false);
    expect(row?.getAttribute("data-busy")).toBe("true");
    expect(row?.querySelector(".session-meta")?.textContent).not.toContain("Needs input");
    expect(row?.querySelector(".unread-ring .activity-indicator.session")).not.toBeNull();
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
  it("offers Mark as unread for a read current session without selecting it or mutating unread state", async () => {
    const read = session("read");
    const list = sessionList([read], new Set());
    list.selected = read;
    list.onMarkUnread = vi.fn();
    list.onMarkRead = vi.fn();
    list.onSelect = vi.fn();

    await openSessionMenu(list, read.id);
    const markUnread = list.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Mark session as unread"]');
    expect(markUnread?.textContent).toBe("Mark as unread");
    expect(list.shadowRoot?.querySelector('button[title="Mark session as read"]')).toBeNull();
    markUnread?.click();
    await list.updateComplete;

    expect(list.onMarkUnread).toHaveBeenCalledExactlyOnceWith(read);
    expect(list.onMarkRead).not.toHaveBeenCalled();
    expect(list.onSelect).not.toHaveBeenCalled();
    expect(list.unreadSessionIds.size).toBe(0);
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();

    list.unreadSessionIds = new Set([read.id]);
    await openSessionMenu(list, read.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as unread"]')).toBeNull();
    expect(list.shadowRoot?.querySelector('button[title="Mark session as read"]')).not.toBeNull();
  });

  it.each([
    ["cached", markCachedNewSessionInfo(session("ineligible"))],
    ["transient", session("ineligible", { persisted: false })],
    ["archived", session("ineligible", { archived: true })],
    ["agent child", session("ineligible", { parentSessionPath: "/sessions/missing.jsonl", agentSubsession: true })],
  ])("does not offer Mark as unread for a read %s session", async (_kind, ineligible) => {
    const list = sessionList([ineligible], new Set());
    document.body.append(list);
    await list.updateComplete;
    if (ineligible.archived === true) {
      list.shadowRoot?.querySelector<HTMLButtonElement>(".subheading .section-toggle")?.click();
      await list.updateComplete;
    }
    await openSessionMenu(list, ineligible.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as unread"]')).toBeNull();
  });

  it("offers Mark as unread for an ordinary fork, not just root sessions", async () => {
    const fork = session("fork", { parentSessionPath: "/sessions/missing.jsonl" });
    const list = sessionList([fork], new Set());
    await openSessionMenu(list, fork.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as unread"]')).not.toBeNull();
  });

  it("offers Mark as read in the menu of an unread current session and forwards it", async () => {
    const unread = session("unread");
    const list = sessionList([unread, session("read")], new Set([unread.id]));
    const onMarkRead = vi.fn<(session: SessionInfo) => void>();
    list.onMarkRead = onMarkRead;

    await openSessionMenu(list, unread.id);
    const markRead = list.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Mark session as read"]');
    expect(markRead?.textContent).toBe("Mark as read");
    // Fixed actions must escape the scroller's isolated paint context without
    // leaving the component (document-click dismissal still belongs to it).
    expect(markRead?.closest(".list-body")).toBeNull();
    expect(markRead?.closest(".action-menu-panel")?.parentElement).toBe(list.shadowRoot?.querySelector("section"));
    markRead?.click();

    expect(onMarkRead).toHaveBeenCalledWith(unread);
    expect(componentState(list, "openMenuSessionId")).toBeUndefined();
  });

  it("retargets the floating menu to the clicked session and closes it when the session disappears", async () => {
    const first = session("first");
    const second = session("second");
    const list = sessionList([first, second], new Set([first.id, second.id]));
    const onMarkRead = vi.fn();
    list.onMarkRead = onMarkRead;
    await openSessionMenu(list, first.id);
    await openSessionMenu(list, second.id);
    expect(list.shadowRoot?.querySelectorAll(".action-menu-panel")).toHaveLength(1);
    list.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Mark session as read"]')?.click();
    expect(onMarkRead).toHaveBeenCalledWith(second);
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();

    await openSessionMenu(list, first.id);
    list.sessions = [{ ...first, archived: true }, second];
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
    list.sessions = [second];
    await list.updateComplete;
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".action-menu-panel")).toBeNull();
  });

  it("hides Mark as read for read, transient, and archived sessions even when tracked as unread", async () => {
    const read = session("read");
    const cached = markCachedNewSessionInfo(session("cached"));
    const archived = { ...session("archived"), archived: true, archivedAt: "2026-06-09T00:00:00.000Z" };
    const list = sessionList([read, cached, archived], new Set([cached.id, archived.id]));

    await openSessionMenu(list, read.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as read"]')).toBeNull();

    await openSessionMenu(list, cached.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as read"]')).toBeNull();

    list.shadowRoot?.querySelector<HTMLButtonElement>(".subheading .section-toggle")?.click();
    await list.updateComplete;
    await openSessionMenu(list, archived.id);
    expect(list.shadowRoot?.querySelector('button[title="Mark session as read"]')).toBeNull();
  });

  it("enables bulk Mark read only when a selected session is unread and forwards only the unread selection", async () => {
    const unreadA = session("unread-a");
    const readB = session("read-b");
    const unreadC = session("unread-c");
    const list = sessionList([unreadA, readB, unreadC], new Set([unreadA.id, unreadC.id]));
    const onMarkReadMany = vi.fn<(sessions: SessionInfo[]) => void>();
    list.onMarkReadMany = onMarkReadMany;
    document.body.append(list);
    await list.updateComplete;
    list.shadowRoot?.querySelector<HTMLButtonElement>(".bulk-select-entry")?.click();
    await list.updateComplete;
    const boxes = [...(list.shadowRoot?.querySelectorAll<HTMLInputElement>(".session-checkbox") ?? [])];
    boxes[1]?.click();
    await list.updateComplete;
    const markRead = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".bulk-actions button") ?? [])].find((button) => button.textContent === "Mark read");
    expect(markRead?.disabled).toBe(true);
    markRead?.click();
    expect(onMarkReadMany).not.toHaveBeenCalled();

    boxes[0]?.click();
    boxes[2]?.click();
    await list.updateComplete;
    expect(markRead?.disabled).toBe(false);
    markRead?.click();
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

it("orders archived rows by activity immediately after archiving while preserving parent-child nesting", async () => {
  const old = session("old", { archived: true, modified: "2026-01-01T00:00:00.000Z", archivedAt: "2026-01-05T00:00:00.000Z" });
  const newer = session("newer", { modified: "2026-01-03T00:00:00.000Z" });
  const child = session("child", { archived: true, parentSessionPath: old.path, modified: "2026-01-04T00:00:00.000Z" });
  const list = sessionList([newer, old, child], new Set());
  document.body.append(list);
  await list.updateComplete;
  const root = list.shadowRoot;
  if (root === null) throw new Error("Missing session list shadow root");
  const toggle = [...root.querySelectorAll<HTMLButtonElement>(".section-toggle")].find((button) => button.textContent.includes("Archived"));
  if (toggle === undefined) throw new Error("Missing archive toggle");
  toggle.click();
  await list.updateComplete;

  // Optimistic archiving keeps the original array order until the next server refresh.
  const archivedNewer = { ...newer, archived: true, archivedAt: "2026-01-05T00:00:00.000Z" };
  list.sessions = [archivedNewer, old, child];
  await list.updateComplete;
  expect([...root.querySelectorAll<HTMLElement>(".action-row.archived")].map((row) => row.title)).toEqual([newer.path, old.path, child.path]);

  // An old server/index order must not override activity ordering either.
  list.sessions = [old, child, archivedNewer];
  await list.updateComplete;
  expect([...root.querySelectorAll<HTMLElement>(".action-row.archived")].map((row) => row.title)).toEqual([newer.path, old.path, child.path]);
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

async function openSessionMenu(list: SessionList, sessionId: string): Promise<void> {
  if (!list.isConnected) document.body.append(list);
  await list.updateComplete;
  const session = list.sessions.find((candidate) => candidate.id === sessionId);
  const row = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])].find((candidate) => candidate.title === session?.path);
  const toggle = row?.querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (!toggle) throw new Error(`Missing session actions for ${sessionId}`);
  toggle.click();
  await list.updateComplete;
}

function componentState(list: SessionList, property: string): unknown {
  return Reflect.get(list, property);
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
