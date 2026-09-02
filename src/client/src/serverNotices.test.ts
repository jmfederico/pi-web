import { describe, expect, it, vi } from "vitest";
import type { ServerNotice, ServerNoticeEvent, ServerNoticeSnapshot } from "../../shared/apiTypes";
import { ServerNoticesController, type ServerNoticeDisplayContext, type ServerNoticesApi, visibleServerNotices } from "./serverNotices";

function notice(id: string, severity: ServerNotice["severity"] = "error", message = id): ServerNotice {
  return { id, severity, message, createdAt: "2026-08-01T00:00:00.000Z" };
}

function snapshot(revision: number, notices: ServerNotice[], daemonInstanceId = "daemon-a"): ServerNoticeSnapshot {
  return { daemonInstanceId, revision, notices };
}

function event(value: ServerNoticeSnapshot): ServerNoticeEvent {
  return { type: "notices.updated", snapshot: value };
}

describe("visibleServerNotices", () => {
  it("keeps unscoped notices visible while hiding a project notice outside its project", () => {
    const globalNotice = notice("global");
    const projectNotice = { ...notice("project"), context: { projectId: "project-a" } };

    expect(visibleServerNotices([globalNotice, projectNotice], { projectId: "project-a" })).toEqual([globalNotice, projectNotice]);
    expect(visibleServerNotices([globalNotice, projectNotice], { projectId: "project-b" })).toEqual([globalNotice]);
  });

  it("keeps worktree deletion notices at project scope across the involved worktrees", () => {
    const deletionNotice = {
      ...notice("deletion"),
      source: "workspace.delete",
      context: { projectId: "project-a", workspaceId: "target-worktree" },
    };

    expect(visibleServerNotices([deletionNotice], { projectId: "project-a", workspaceId: "runner-worktree" })).toEqual([deletionNotice]);
    expect(visibleServerNotices([deletionNotice], { projectId: "project-b", workspaceId: "other-worktree" })).toEqual([]);
  });

  it("matches ordinary workspace and session notice context to the active namespace", () => {
    const workspaceNotice = { ...notice("workspace"), context: { projectId: "project-a", workspaceId: "workspace-a" } };
    const sessionNotice = { ...notice("session"), context: { projectId: "project-a", workspaceId: "workspace-a", sessionId: "session-a" } };
    const context: ServerNoticeDisplayContext = { projectId: "project-a", workspaceId: "workspace-a", sessionId: "session-a" };

    expect(visibleServerNotices([workspaceNotice, sessionNotice], context)).toEqual([workspaceNotice, sessionNotice]);
    expect(visibleServerNotices([workspaceNotice, sessionNotice], { projectId: "project-a", workspaceId: "workspace-b", sessionId: "session-b" })).toEqual([]);
  });
});

describe("ServerNoticesController", () => {
  it("installs refreshed snapshots and accepts only newer revisions for the current daemon", async () => {
    const api = fakeApi();
    api.snapshot.mockResolvedValue(snapshot(1, [notice("one")]));
    const controller = new ServerNoticesController({ api });

    await controller.refresh("local");
    controller.applyEvent("local", event(snapshot(1, [notice("old")])));
    controller.applyEvent("local", event(snapshot(2, [notice("two", "warning")])));

    expect(controller.projection("local")).toMatchObject({ status: "fresh", daemonInstanceId: "daemon-a", revision: 2, notices: [notice("two", "warning")] });
  });

  it("replays a newer realtime snapshot that races an HTTP refresh", async () => {
    const api = fakeApi();
    const response = deferred<ServerNoticeSnapshot>();
    api.snapshot.mockReturnValue(response.promise);
    const controller = new ServerNoticesController({ api });

    const refreshing = controller.refresh("local");
    controller.applyEvent("local", event(snapshot(2, [notice("live")])));
    response.resolve(snapshot(1, [notice("stale")]));
    await refreshing;

    expect(controller.projection("local")).toMatchObject({ status: "fresh", revision: 2, notices: [notice("live")] });
  });

  it("refreshes when a realtime frame belongs to another daemon instance", async () => {
    const api = fakeApi();
    api.snapshot
      .mockResolvedValueOnce(snapshot(1, [notice("old")], "daemon-a"))
      .mockResolvedValueOnce(snapshot(0, [notice("new")], "daemon-b"));
    const controller = new ServerNoticesController({ api });

    await controller.refresh("local");
    controller.applyEvent("local", event(snapshot(1, [notice("new")], "daemon-b")));
    await vi.waitFor(() => { expect(api.snapshot).toHaveBeenCalledTimes(2); });

    expect(controller.projection("local")).toMatchObject({ status: "fresh", daemonInstanceId: "daemon-b", revision: 0, notices: [notice("new")] });
  });

  it("optimistically hides one notice and reconciles the exact dismiss response", async () => {
    const api = fakeApi();
    const first = notice("first");
    const second = notice("second", "info");
    api.snapshot.mockResolvedValue(snapshot(2, [second, first]));
    api.dismiss.mockResolvedValue(snapshot(3, [second]));
    const controller = new ServerNoticesController({ api });

    await controller.refresh("local");
    const dismissal = controller.dismiss("local", first.id);
    expect(controller.projection("local")?.notices).toEqual([second]);
    await dismissal;

    expect(api.dismiss).toHaveBeenCalledWith("local", "daemon-a", first.id);
    expect(controller.projection("local")?.notices).toEqual([second]);
  });

  it("restores a notice when its dismissal request fails", async () => {
    const api = fakeApi();
    const first = notice("first");
    api.snapshot.mockResolvedValue(snapshot(1, [first]));
    api.dismiss.mockRejectedValue(new Error("offline"));
    const onBackgroundError = vi.fn();
    const controller = new ServerNoticesController({ api, onBackgroundError });

    await controller.refresh("local");
    await controller.dismiss("local", first.id);

    expect(controller.projection("local")?.notices).toEqual([first]);
    expect(onBackgroundError).toHaveBeenCalledWith("dismiss", "local", expect.any(Error));
  });
});

function fakeApi(): { snapshot: ReturnType<typeof vi.fn<ServerNoticesApi["snapshot"]>>; dismiss: ReturnType<typeof vi.fn<ServerNoticesApi["dismiss"]>> } {
  return { snapshot: vi.fn<ServerNoticesApi["snapshot"]>(), dismiss: vi.fn<ServerNoticesApi["dismiss"]>() };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise resolver is unavailable");
      resolvePromise(value);
    },
  };
}
