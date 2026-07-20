import { describe, expect, it, vi } from "vitest";
import type { SessionRef, SessionUnreadCatalogSnapshot, SessionUnreadEvent, SessionUnreadSummary } from "../../shared/apiTypes";
import { SessionUnreadController, type SessionUnreadApi } from "./sessionUnread";

describe("SessionUnreadController", () => {
  it("restores the durable server snapshot for a new browser controller", async () => {
    const api = fakeApi({ snapshots: [snapshot("catalog-a", 2, [summary("session-2", 2), summary("session-1", 1)])] });
    const controller = new SessionUnreadController({ api });
    controller.setCapability("local", "supported");

    await controller.refresh("local");

    expect([...controller.unreadSessionIds("local", [ref("session-1"), ref("session-2")])]).toEqual(["session-1", "session-2"]);
    expect(controller.projection("local")).toMatchObject({ status: "fresh", catalogId: "catalog-a", catalogRevision: 2 });

    const restarted = new SessionUnreadController({
      api: fakeApi({ snapshots: [snapshot("catalog-a", 2, [summary("session-2", 2), summary("session-1", 1)])] }),
    });
    restarted.setCapability("local", "supported");
    await restarted.refresh("local");
    expect(restarted.isUnread("local", ref("session-2"))).toBe(true);
  });

  it("refreshes the projection again on reconnect", async () => {
    const api = fakeApi({
      snapshots: [
        snapshot("catalog-a", 1, [summary("session-1", 1)]),
        snapshot("catalog-a", 2, [summary("session-2", 2), summary("session-1", 1)]),
      ],
    });
    const controller = new SessionUnreadController({ api });
    controller.setCapability("local", "supported");

    await controller.refresh("local");
    await controller.refresh("local");

    expect(controller.projection("local")).toMatchObject({ catalogRevision: 2 });
    expect([...controller.unreadSessionIds("local", [ref("session-1"), ref("session-2")])]).toEqual(["session-1", "session-2"]);
  });

  it("replays a contiguous event that races the initial snapshot join and performs a trailing refresh", async () => {
    const response = deferred<SessionUnreadCatalogSnapshot>();
    const unreadCatalog = vi.fn(() => response.promise);
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog }) });
    controller.setCapability("local", "supported");

    const refreshing = controller.refresh("local");
    controller.applyEvent("local", unreadEvent("catalog-a", 2, summary("session-2", 2)));
    response.resolve(snapshot("catalog-a", 1, [summary("session-1", 1)]));
    await refreshing;

    expect(unreadCatalog).toHaveBeenCalledTimes(2);
    expect(controller.projection("local")).toEqual({
      status: "fresh",
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [summary("session-2", 2), summary("session-1", 1)],
    });
  });

  it("drains reconnect refreshes that overlap an active request", async () => {
    const firstResponse = deferred<SessionUnreadCatalogSnapshot>();
    const unreadCatalog = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(snapshot("catalog-a", 2, [summary("session-2", 2)]));
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog }) });
    controller.setCapability("local", "supported");

    const firstRefresh = controller.refresh("local");
    const reconnectRefresh = controller.refresh("local");
    expect(reconnectRefresh).toBe(firstRefresh);
    firstResponse.resolve(snapshot("catalog-a", 1, [summary("session-1", 1)]));
    await firstRefresh;

    expect(unreadCatalog).toHaveBeenCalledTimes(2);
    expect(controller.projection("local")).toEqual({
      status: "fresh",
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [summary("session-2", 2)],
    });
  });

  it("retries a queued gap refresh after the active snapshot request fails", async () => {
    const firstResponse = deferred<SessionUnreadCatalogSnapshot>();
    const unreadCatalog = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(snapshot("catalog-a", 3, [summary("session-3", 3), summary("session-1", 1)]));
    const onBackgroundError = vi.fn();
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog }), onBackgroundError });
    controller.setCapability("local", "supported");
    controller.applyEvent("local", unreadEvent("catalog-a", 1, summary("session-1", 1)));

    const refreshing = controller.refresh("local");
    controller.applyEvent("local", unreadEvent("catalog-a", 3, summary("session-3", 3)));
    const error = new Error("disconnected");
    firstResponse.reject(error);
    await refreshing;

    expect(onBackgroundError).toHaveBeenCalledWith("snapshot", "local", error);
    expect(unreadCatalog).toHaveBeenCalledTimes(2);
    expect(controller.projection("local")).toMatchObject({ status: "fresh", catalogRevision: 3 });
  });

  it("resnapshots revision gaps and replaces state on a new catalog epoch", async () => {
    const unreadCatalog = vi.fn()
      .mockResolvedValueOnce(snapshot("catalog-a", 3, [summary("session-3", 3), summary("session-1", 1)]))
      .mockResolvedValueOnce(snapshot("catalog-b", 1, [summary("new-epoch", 1)]));
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog }) });
    controller.setCapability("local", "supported");

    controller.applyEvent("local", unreadEvent("catalog-a", 1, summary("session-1", 1)));
    controller.applyEvent("local", unreadEvent("catalog-a", 3, summary("session-3", 3)));
    await vi.waitFor(() => {
      expect(controller.projection("local")).toMatchObject({ status: "fresh", catalogRevision: 3 });
    });
    expect(unreadCatalog).toHaveBeenCalledOnce();

    controller.applyEvent("local", unreadEvent("catalog-b", 1, summary("new-epoch", 1)));
    await vi.waitFor(() => {
      expect(controller.projection("local")).toEqual({
        status: "fresh",
        catalogId: "catalog-b",
        catalogRevision: 1,
        sessions: [summary("new-epoch", 1)],
      });
    });
    expect(unreadCatalog).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer completion when an acknowledgement of the observed order is in flight", async () => {
    const response = deferred<SessionUnreadCatalogSnapshot>();
    const acknowledgeUnread = vi.fn(() => response.promise);
    const controller = new SessionUnreadController({ api: fakeApi({ acknowledgeUnread }) });
    const session = ref("session-1");
    controller.setCapability("local", "supported");
    controller.applyEvent("local", unreadEvent("catalog-a", 1, summary(session.id, 1)));

    const acknowledging = controller.acknowledge("local", session);
    controller.applyEvent("local", unreadEvent("catalog-a", 2, summary(session.id, 2)));
    // Even a delayed response that only represents the old revision is merged
    // with socket events observed while the request was pending.
    response.resolve(snapshot("catalog-a", 1, []));
    await acknowledging;

    expect(acknowledgeUnread).toHaveBeenCalledWith(session, "catalog-a", 1, "local");
    expect(controller.projection("local")).toEqual({
      status: "fresh",
      catalogId: "catalog-a",
      catalogRevision: 2,
      sessions: [summary(session.id, 2)],
    });
  });

  it("does not let a delayed acknowledgement response regress an epoch installed by another request", async () => {
    const acknowledgementResponse = deferred<SessionUnreadCatalogSnapshot>();
    const unreadCatalog = vi.fn().mockResolvedValue(snapshot("catalog-b", 1, [summary("epoch-b", 1)]));
    const acknowledgeUnread = vi.fn(() => acknowledgementResponse.promise);
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog, acknowledgeUnread }) });
    const session = ref("session-1");
    controller.setCapability("local", "supported");
    controller.applyEvent("local", unreadEvent("catalog-a", 1, summary(session.id, 1)));

    const acknowledging = controller.acknowledge("local", session);
    await controller.refresh("local");
    expect(controller.projection("local")).toMatchObject({ catalogId: "catalog-b", status: "fresh" });

    acknowledgementResponse.resolve(snapshot("catalog-a", 2, []));
    await acknowledging;
    await vi.waitFor(() => {
      expect(controller.projection("local")).toMatchObject({ catalogId: "catalog-b", status: "fresh" });
    });

    expect(unreadCatalog).toHaveBeenCalledTimes(2);
    expect(controller.isUnread("local", ref("epoch-b"))).toBe(true);
  });

  it("deduplicates acknowledgements and converges another client from the authoritative clear event", async () => {
    const response = deferred<SessionUnreadCatalogSnapshot>();
    const acknowledgeUnread = vi.fn(() => response.promise);
    const first = new SessionUnreadController({ api: fakeApi({ acknowledgeUnread }) });
    const second = new SessionUnreadController({ api: fakeApi() });
    const session = ref("session-1");
    first.setCapability("local", "supported");
    second.setCapability("local", "supported");
    const completion = unreadEvent("catalog-a", 1, summary(session.id, 1));
    first.applyEvent("local", completion);
    second.applyEvent("local", completion);

    const firstAttempt = first.acknowledge("local", session);
    const duplicateAttempt = first.acknowledge("local", session);
    expect(duplicateAttempt).toBe(firstAttempt);
    expect(acknowledgeUnread).toHaveBeenCalledOnce();

    response.resolve(snapshot("catalog-a", 2, []));
    await firstAttempt;
    second.applyEvent("local", unreadEvent("catalog-a", 2, null, session));

    expect(first.isUnread("local", session)).toBe(false);
    expect(second.isUnread("local", session)).toBe(false);
    expect(acknowledgeUnread).toHaveBeenCalledOnce();
  });

  it("keeps canonical identities machine- and cwd-scoped and prunes removed machines", () => {
    const controller = new SessionUnreadController({ api: fakeApi() });
    controller.setCapability("machine-a", "supported");
    controller.setCapability("machine-b", "supported");
    controller.applyEvent("machine-a", unreadEvent("catalog-a", 1, summary("shared", 1, "/repo-a")));
    controller.applyEvent("machine-b", unreadEvent("catalog-b", 1, summary("shared", 1, "/repo-b")));

    expect(controller.isUnread("machine-a", ref("shared", "/repo-a"))).toBe(true);
    expect(controller.isUnread("machine-a", ref("shared", "/repo-b"))).toBe(false);
    expect(controller.isUnread("machine-b", ref("shared", "/repo-b"))).toBe(true);

    controller.retainMachines(new Set(["machine-b"]));
    expect(controller.projection("machine-a")).toBeUndefined();
    expect(controller.isUnread("machine-b", ref("shared", "/repo-b"))).toBe(true);
  });

  it("invalidates an in-flight snapshot when its machine is removed", async () => {
    const response = deferred<SessionUnreadCatalogSnapshot>();
    const onChange = vi.fn();
    const controller = new SessionUnreadController({
      api: fakeApi({ unreadCatalog: () => response.promise }),
      onChange,
    });
    controller.setCapability("local", "supported");

    const refreshing = controller.refresh("local");
    onChange.mockClear();
    controller.retainMachines(new Set());
    response.resolve(snapshot("catalog-a", 1, [summary("session-1", 1)]));
    await refreshing;

    expect(controller.projection("local")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores socket deltas and endpoints until joint support is known, then clears state on downgrade", async () => {
    const unreadCatalog = vi.fn().mockResolvedValue(snapshot("catalog-a", 0, []));
    const controller = new SessionUnreadController({ api: fakeApi({ unreadCatalog }) });
    const completion = unreadEvent("catalog-a", 1, summary("session-1", 1));

    controller.applyEvent("legacy", completion);
    await controller.refresh("legacy");
    controller.setCapability("legacy", "unsupported");
    controller.applyEvent("legacy", completion);
    await controller.refresh("legacy");
    expect(unreadCatalog).not.toHaveBeenCalled();
    expect(controller.projection("legacy")).toBeUndefined();

    expect(controller.setCapability("legacy", "supported")).toBe(true);
    await controller.refresh("legacy");
    expect(unreadCatalog).toHaveBeenCalledOnce();

    controller.applyEvent("legacy", completion);
    controller.setCapability("legacy", "unsupported");
    expect(controller.projection("legacy")).toBeUndefined();
    expect(controller.unreadSessionIds("legacy", [ref("session-1")]).size).toBe(0);
  });

  it("preserves unread state when acknowledgement fails so a later visible check can retry", async () => {
    const error = new Error("offline");
    const onBackgroundError = vi.fn();
    const acknowledgeUnread = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(snapshot("catalog-a", 2, []));
    const controller = new SessionUnreadController({ api: fakeApi({ acknowledgeUnread }), onBackgroundError });
    const session = ref("session-1");
    controller.setCapability("local", "supported");
    controller.applyEvent("local", unreadEvent("catalog-a", 1, summary(session.id, 1)));

    await controller.acknowledge("local", session);
    expect(controller.isUnread("local", session)).toBe(true);
    expect(onBackgroundError).toHaveBeenCalledWith("acknowledge", "local", error);

    await controller.acknowledge("local", session);
    expect(controller.isUnread("local", session)).toBe(false);
    expect(acknowledgeUnread).toHaveBeenCalledTimes(2);
  });
});

interface FakeApiOptions {
  snapshots?: SessionUnreadCatalogSnapshot[] | undefined;
  unreadCatalog?: SessionUnreadApi["unreadCatalog"] | undefined;
  acknowledgeUnread?: SessionUnreadApi["acknowledgeUnread"] | undefined;
}

function fakeApi(options: FakeApiOptions = {}): SessionUnreadApi {
  const snapshots = [...(options.snapshots ?? [])];
  return {
    unreadCatalog: options.unreadCatalog ?? (() => {
      const next = snapshots.shift();
      return next === undefined
        ? Promise.reject(new Error("Unexpected unread snapshot request"))
        : Promise.resolve(next);
    }),
    acknowledgeUnread: options.acknowledgeUnread ?? (() => (
      Promise.reject(new Error("Unexpected unread acknowledgement"))
    )),
  };
}

function snapshot(catalogId: string, catalogRevision: number, sessions: SessionUnreadSummary[]): SessionUnreadCatalogSnapshot {
  return { catalogId, catalogRevision, sessions };
}

function summary(sessionId: string, completionOrder: number, cwd = "/repo"): SessionUnreadSummary {
  return {
    sessionId,
    cwd,
    completionOrder,
    completedAt: `2026-07-20T00:00:${String(completionOrder).padStart(2, "0")}.000Z`,
  };
}

function unreadEvent(
  catalogId: string,
  catalogRevision: number,
  unread: SessionUnreadSummary | null,
  identity: SessionRef = unread === null ? ref("session-1") : { id: unread.sessionId, cwd: unread.cwd },
): SessionUnreadEvent {
  return {
    type: "sessions.unread",
    catalogId,
    catalogRevision,
    sessionId: identity.id,
    cwd: identity.cwd,
    unread,
  };
}

function ref(id: string, cwd = "/repo"): SessionRef {
  return { id, cwd };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise is unavailable");
      resolvePromise(value);
    },
    reject: (error) => {
      if (rejectPromise === undefined) throw new Error("Deferred promise is unavailable");
      rejectPromise(error);
    },
  };
}
