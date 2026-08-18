import { describe, expect, it } from "vitest";
import {
  SESSION_NOTIFICATION_LIMIT,
  SESSION_NOTIFICATION_MESSAGE_BYTES,
  SessionNotificationStore,
  truncateSessionNotificationMessage,
} from "./sessionNotificationStore.js";

const identity = { sessionId: "session-1", cwd: "/workspace" };

function testStore() {
  let tick = 0;
  return new SessionNotificationStore({
    daemonInstanceId: "daemon-test",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
}

function register(store: SessionNotificationStore) {
  return store.registerSession(identity.sessionId, identity.cwd).generation;
}

describe("SessionNotificationStore", () => {
  it("keeps duplicate calls distinct, newest-first, and recomputes severity", () => {
    const store = testStore();
    const generation = register(store);

    const first = store.addNotification(generation, "same", undefined).notification;
    const second = store.addNotification(generation, "same", "warning").notification;
    const third = store.addNotification(generation, "same", "error").notification;
    const unknown = store.addNotification(generation, "unknown severity", "fatal").notification;

    expect([first?.id, second?.id, third?.id, unknown?.id]).toEqual([
      "daemon-test:1",
      "daemon-test:2",
      "daemon-test:3",
      "daemon-test:4",
    ]);
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd)).toMatchObject({
      summary: { retainedCount: 4, discardedCount: 0, highestSeverity: "error", inboxRevision: 4 },
      notifications: [
        { id: "daemon-test:4", severity: "info" },
        { id: "daemon-test:3", severity: "error" },
        { id: "daemon-test:2", severity: "warning" },
        { id: "daemon-test:1", severity: "info" },
      ],
      dismissThrough: { order: 4, overflowWatermark: 0 },
    });

    store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, third?.id ?? "");
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd).summary.highestSeverity).toBe("warning");
  });

  it("truncates UTF-8 only between code points and marks exact overflow", () => {
    const exact = "a".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES);
    expect(truncateSessionNotificationMessage(exact)).toEqual({ message: exact, truncated: false });

    const astral = `${"a".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES - 1)}😀tail`;
    const astralResult = truncateSessionNotificationMessage(astral);
    expect(astralResult).toEqual({ message: "a".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES - 1), truncated: true });
    expect(new TextEncoder().encode(astralResult.message).byteLength).toBe(SESSION_NOTIFICATION_MESSAGE_BYTES - 1);

    const bidi = `${"a".repeat(SESSION_NOTIFICATION_MESSAGE_BYTES - 3)}\u202etail`;
    const bidiResult = truncateSessionNotificationMessage(bidi);
    expect(bidiResult.message.endsWith("\u202e")).toBe(true);
    expect(new TextEncoder().encode(bidiResult.message).byteLength).toBe(SESSION_NOTIFICATION_MESSAGE_BYTES);
    expect(bidiResult.truncated).toBe(true);
  });

  it("retains exactly the newest 100 and reports exact overflow", () => {
    const store = testStore();
    const generation = register(store);

    for (let index = 1; index <= 105; index += 1) store.addNotification(generation, `message ${String(index)}`, "info");

    const snapshot = store.inboxSnapshot(identity.sessionId, identity.cwd);
    expect(snapshot.notifications).toHaveLength(SESSION_NOTIFICATION_LIMIT);
    expect(snapshot.notifications[0]).toMatchObject({ id: "daemon-test:105", message: "message 105" });
    expect(snapshot.notifications.at(-1)).toMatchObject({ id: "daemon-test:6", message: "message 6" });
    expect(snapshot.summary).toMatchObject({ retainedCount: 100, discardedCount: 5 });
    expect(snapshot.dismissThrough).toEqual({ order: 105, overflowWatermark: 5 });
  });

  it("makes individual dismissal idempotent and clears overflow with the final retained entry", () => {
    const store = testStore();
    const generation = register(store);
    for (let index = 0; index <= SESSION_NOTIFICATION_LIMIT; index += 1) store.addNotification(generation, String(index), "info");

    const firstSnapshot = store.inboxSnapshot(identity.sessionId, identity.cwd);
    const firstId = firstSnapshot.notifications[0]?.id ?? "";
    const firstDismiss = store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, firstId);
    const afterFirstRevision = firstDismiss.snapshot.summary.inboxRevision;
    const duplicateDismiss = store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, firstId);
    expect(duplicateDismiss.mutations).toEqual([]);
    expect(duplicateDismiss.snapshot.summary.inboxRevision).toBe(afterFirstRevision);
    expect(duplicateDismiss.snapshot.summary.discardedCount).toBe(1);

    for (const notification of duplicateDismiss.snapshot.notifications) {
      store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, notification.id);
    }
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd).summary).toMatchObject({ retainedCount: 0, discardedCount: 0 });
    expect(store.catalogSnapshot().sessions).toEqual([]);
  });

  it("dismisses only through captured order and overflow cutoffs", () => {
    const store = testStore();
    const generation = register(store);
    for (let index = 0; index <= SESSION_NOTIFICATION_LIMIT; index += 1) store.addNotification(generation, String(index), "info");
    const clicked = store.inboxSnapshot(identity.sessionId, identity.cwd);

    const later = store.addNotification(generation, "later", "error").notification;
    const result = store.dismissAll(
      identity.sessionId,
      identity.cwd,
      store.daemonInstanceId,
      clicked.dismissThrough.order,
      clicked.dismissThrough.overflowWatermark,
    );

    expect(result.snapshot.notifications).toEqual([later]);
    expect(result.snapshot.summary).toMatchObject({ retainedCount: 1, discardedCount: 1, highestSeverity: "error" });
    const revision = result.snapshot.summary.inboxRevision;
    const replay = store.dismissAll(
      identity.sessionId,
      identity.cwd,
      store.daemonInstanceId,
      clicked.dismissThrough.order,
      clicked.dismissThrough.overflowWatermark,
    );
    expect(replay.mutations).toEqual([]);
    expect(replay.snapshot.summary.inboxRevision).toBe(revision);
  });

  it("requests resync when dismissal reveals an entry hidden by the replacement projection cap", () => {
    const store = testStore();
    const oldGeneration = register(store);
    for (let index = 1; index <= 100; index += 1) store.addNotification(oldGeneration, `old ${String(index)}`, "info");
    const candidate = store.beginReplacement(oldGeneration, identity);
    const added = store.addNotification(candidate, "candidate", "warning");
    const candidateId = added.notification?.id ?? "";
    expect(added.mutations[0]?.inboxEvent.delta).toMatchObject({ kind: "added", evictedNotificationId: "daemon-test:1" });

    const result = store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, candidateId);

    expect(result.mutations[0]?.inboxEvent.delta).toEqual({ kind: "resync" });
    expect(result.snapshot.notifications).toHaveLength(100);
    expect(result.snapshot.notifications.at(-1)).toMatchObject({ id: "daemon-test:1", message: "old 1" });
    expect(result.snapshot.summary.discardedCount).toBe(0);
  });

  it("keeps dismiss-all deltas bounded to the public 100-entry projection", () => {
    const store = testStore();
    const oldGeneration = register(store);
    for (let index = 0; index < 100; index += 1) store.addNotification(oldGeneration, `old ${String(index)}`, "info");
    const candidate = store.beginReplacement(oldGeneration, identity);
    for (let index = 0; index < 100; index += 1) store.addNotification(candidate, `candidate ${String(index)}`, "warning");
    const clicked = store.inboxSnapshot(identity.sessionId, identity.cwd);

    const result = store.dismissAll(
      identity.sessionId,
      identity.cwd,
      store.daemonInstanceId,
      clicked.dismissThrough.order,
      clicked.dismissThrough.overflowWatermark,
    );

    const delta = result.mutations[0]?.inboxEvent.delta;
    expect(delta?.kind).toBe("dismissed");
    expect(delta?.kind === "dismissed" ? delta.notificationIds : []).toHaveLength(100);
    expect(result.snapshot.summary.retainedCount).toBe(0);
    store.abortReplacement(candidate);
  });

  it("treats stale daemon and unknown notification identifiers as no-ops", () => {
    const store = testStore();
    const generation = register(store);
    store.addNotification(generation, "keep", "warning");
    const before = store.inboxSnapshot(identity.sessionId, identity.cwd);

    const stale = store.dismissAll(identity.sessionId, identity.cwd, "old-daemon", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const unknown = store.dismissNotification(identity.sessionId, identity.cwd, store.daemonInstanceId, "missing");

    expect(stale.mutations).toEqual([]);
    expect(unknown.mutations).toEqual([]);
    expect(unknown.snapshot).toEqual(before);
  });

  it("advances catalog and inbox revisions only for visible mutations and emits zero cleanup", () => {
    const store = testStore();
    const generation = register(store);
    expect(store.catalogSnapshot()).toMatchObject({ daemonInstanceId: "daemon-test", catalogRevision: 0, sessions: [] });

    const added = store.addNotification(generation, "notice", "info").mutations[0];
    expect(added).toMatchObject({
      sessionId: "session-1",
      inboxEvent: { type: "notifications.inbox", catalogRevision: 1, summary: { inboxRevision: 1, retainedCount: 1 }, delta: { kind: "added" } },
      summaryEvent: { type: "notifications.summary", catalogRevision: 1, summary: { inboxRevision: 1, retainedCount: 1 } },
    });

    const cleared = store.clearSession(identity.sessionId, "archive");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({
      inboxEvent: { catalogRevision: 2, summary: { inboxRevision: 2, retainedCount: 0, discardedCount: 0 }, delta: { kind: "cleared", reason: "archive" } },
      summaryEvent: { catalogRevision: 2, summary: { retainedCount: 0, discardedCount: 0 } },
    });
    expect(store.catalogSnapshot()).toMatchObject({ catalogRevision: 2, sessions: [] });
    expect(store.addNotification(generation, "stale", "error")).toEqual({ mutations: [] });
  });

  it("keeps inbox revisions and overflow watermarks monotonic across same-daemon reopen", () => {
    const store = testStore();
    const firstGeneration = register(store);
    for (let index = 0; index <= SESSION_NOTIFICATION_LIMIT; index += 1) store.addNotification(firstGeneration, `first ${String(index)}`, "info");
    const oldSnapshot = store.inboxSnapshot(identity.sessionId, identity.cwd);
    store.clearSession(identity.sessionId, "runtime-close");

    const reopenedGeneration = register(store);
    const reopenedEmpty = store.inboxSnapshot(identity.sessionId, identity.cwd);
    expect(reopenedEmpty.summary.inboxRevision).toBeGreaterThan(oldSnapshot.summary.inboxRevision);
    expect(reopenedEmpty.dismissThrough.overflowWatermark).toBe(oldSnapshot.dismissThrough.overflowWatermark);
    for (let index = 0; index <= SESSION_NOTIFICATION_LIMIT; index += 1) store.addNotification(reopenedGeneration, `second ${String(index)}`, "warning");
    const beforeReplay = store.inboxSnapshot(identity.sessionId, identity.cwd);

    const replay = store.dismissAll(
      identity.sessionId,
      identity.cwd,
      store.daemonInstanceId,
      oldSnapshot.dismissThrough.order,
      oldSnapshot.dismissThrough.overflowWatermark,
    );

    expect(replay.mutations).toEqual([]);
    expect(replay.snapshot).toEqual(beforeReplay);
    expect(replay.snapshot.summary.discardedCount).toBe(1);
    expect(replay.snapshot.dismissThrough.overflowWatermark).toBeGreaterThan(oldSnapshot.dismissThrough.overflowWatermark);
  });

  it("commits replacement notifications while dropping the old generation and overflow", () => {
    const store = testStore();
    const oldGeneration = register(store);
    for (let index = 0; index <= SESSION_NOTIFICATION_LIMIT; index += 1) store.addNotification(oldGeneration, `old ${String(index)}`, "warning");

    const candidate = store.beginReplacement(oldGeneration, identity);
    const replacementOneResult = store.addNotification(candidate, "replacement one", "info");
    const replacementOne = replacementOneResult.notification;
    const replacementTwo = store.addNotification(candidate, "replacement two", "error").notification;
    expect(replacementOneResult.mutations[0]?.inboxEvent.delta).toMatchObject({
      kind: "added",
      evictedNotificationId: "daemon-test:2",
    });
    expect(store.addNotification(oldGeneration, "stale shutdown callback", "error")).toEqual({ mutations: [] });

    const mutations = store.commitReplacement(candidate);
    const snapshot = store.inboxSnapshot(identity.sessionId, identity.cwd);
    expect(mutations.at(-1)?.inboxEvent.delta).toEqual({ kind: "resync" });
    expect(snapshot.notifications.map((notification) => notification.id)).toEqual([replacementTwo?.id, replacementOne?.id]);
    expect(snapshot.summary).toMatchObject({ retainedCount: 2, discardedCount: 0, highestSeverity: "error" });
    expect(store.addNotification(oldGeneration, "stale", "info")).toEqual({ mutations: [] });
  });

  it("aborts replacement without cleanup and keeps the 100-entry bound", () => {
    const store = testStore();
    const oldGeneration = register(store);
    for (let index = 0; index < 100; index += 1) store.addNotification(oldGeneration, `old ${String(index)}`, "info");
    const candidate = store.beginReplacement(oldGeneration, identity);
    const replacementIds: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const notification = store.addNotification(candidate, `candidate ${String(index)}`, "warning").notification;
      if (notification !== undefined) replacementIds.push(notification.id);
    }

    const mutations = store.abortReplacement(candidate);
    const snapshot = store.inboxSnapshot(identity.sessionId, identity.cwd);
    expect(mutations.at(-1)?.inboxEvent.delta).toEqual({ kind: "resync" });
    expect(snapshot.notifications).toHaveLength(100);
    expect(snapshot.notifications.every((notification) => replacementIds.includes(notification.id))).toBe(true);
    expect(snapshot.summary.discardedCount).toBe(100);
    expect(store.addNotification(candidate, "stale candidate", "error")).toEqual({ mutations: [] });

    const afterAbort = store.addNotification(oldGeneration, "old runtime recovered", "error");
    expect(afterAbort.notification).toBeDefined();
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd)).toMatchObject({
      summary: { retainedCount: 100, discardedCount: 101, highestSeverity: "error" },
    });
  });

  it("can keep a rotated candidate binding active after aborting cleanup", () => {
    const store = testStore();
    const oldGeneration = register(store);
    store.addNotification(oldGeneration, "old", "info");
    const candidate = store.beginReplacement(oldGeneration, identity);
    store.addNotification(candidate, "candidate", "warning");

    store.abortReplacement(candidate, "candidate");

    expect(store.addNotification(oldGeneration, "stale old runner", "error")).toEqual({ mutations: [] });
    expect(store.addNotification(candidate, "current runner", "error").notification).toMatchObject({ message: "current runner", severity: "error" });
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd).notifications.map((notification) => notification.message)).toEqual([
      "current runner",
      "candidate",
      "old",
    ]);
  });

  it("moves preserved calls to the active changed-id candidate after aborting cleanup", () => {
    const store = testStore();
    const oldGeneration = register(store);
    store.addNotification(oldGeneration, "old", "info");
    const candidate = store.beginReplacement(oldGeneration, { sessionId: "session-2", cwd: identity.cwd });
    store.addNotification(candidate, "candidate", "warning");

    const mutations = store.abortReplacement(candidate, "candidate");

    expect(mutations.map((mutation) => [mutation.sessionId, mutation.inboxEvent.delta.kind])).toEqual([
      ["session-1", "cleared"],
      ["session-2", "resync"],
    ]);
    expect(() => store.inboxSnapshot("session-1", identity.cwd)).toThrow("Session not found");
    expect(store.inboxSnapshot("session-2", identity.cwd).notifications.map((notification) => notification.message)).toEqual(["candidate", "old"]);
    expect(store.addNotification(candidate, "after failure", "error").notification).toMatchObject({ message: "after failure" });
  });

  it("retags a failed changed-id replacement back to the prior inbox", () => {
    const store = testStore();
    const oldGeneration = register(store);
    store.addNotification(oldGeneration, "old", "info");
    const candidate = store.beginReplacement(oldGeneration, { sessionId: "session-2", cwd: identity.cwd });
    const replacement = store.addNotification(candidate, "replacement", "error").notification;

    const mutations = store.abortReplacement(candidate);

    expect(mutations.map((mutation) => [mutation.sessionId, mutation.inboxEvent.delta.kind])).toEqual([
      ["session-2", "cleared"],
      ["session-1", "resync"],
    ]);
    expect(() => store.inboxSnapshot("session-2", identity.cwd)).toThrow("Session not found");
    expect(store.inboxSnapshot(identity.sessionId, identity.cwd).notifications.map((notification) => notification.id)).toContain(replacement?.id);
  });
});
