import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("cleanup pin resolution at the web/API boundary", () => {
  it("refreshes the union of workspace pins for preview and execution on both local aliases", async () => {
    const { app, sessionDaemonRequests } = appTestContext;
    const pins = "/api/navigation/projects/offline/workspaces/stale/session-pins";
    await app.inject({ method: "PUT", url: "/api/navigation/projects", payload: { ids: ["not-a-session"] } });
    await app.inject({ method: "PUT", url: pins, payload: { ids: ["first", "shared"] } });
    await app.inject({ method: "PUT", url: "/api/navigation/projects/other/workspaces/other/session-pins", payload: { ids: ["shared", "second"] } });
    await app.inject({ method: "POST", url: "/api/sessions/cleanup/preview", payload: { skipPinned: true, archiveIdleDays: 30, excludedPinnedSessionIds: ["forged"] } });
    expect(sessionDaemonRequests.at(-1)).toMatchObject({ method: "POST", path: "/sessions/cleanup/preview", body: { skipPinned: true, archiveIdleDays: 30, excludedPinnedSessionIds: ["first", "second", "shared"] } });

    await app.inject({ method: "PUT", url: pins, payload: { ids: ["new-pin"] } });
    await app.inject({ method: "POST", url: "/api/machines/local/sessions/cleanup", payload: { skipPinned: true, deleteArchivedDays: 30, projectCwds: ["/repo"] } });
    expect(sessionDaemonRequests.at(-1)).toMatchObject({ method: "POST", path: "/sessions/cleanup", body: { skipPinned: true, deleteArchivedDays: 30, projectCwds: ["/repo"], excludedPinnedSessionIds: ["new-pin", "second", "shared"] } });
  });

  it.each(["/api/sessions/cleanup/preview", "/api/machines/local/sessions/cleanup"])("fails closed on unreadable pin state for %s", async (url) => {
    const { app, sessionDaemonRequests, tempDir } = appTestContext;
    const path = join(tempDir, "navigation-preferences.json");
    await mkdir(path);
    expect((await app.inject({ method: "POST", url, payload: { skipPinned: true } })).statusCode).toBe(500);
    expect(sessionDaemonRequests).toEqual([]);
  });

  it("does not read pins for omitted/false and rejects malformed flags before contacting sessiond", async () => {
    const { app, sessionDaemonRequests, tempDir } = appTestContext;
    await writeFile(join(tempDir, "navigation-preferences.json"), "corrupt");
    for (const skipPinned of [undefined, false]) {
      await app.inject({ method: "POST", url: "/api/sessions/cleanup", payload: { ...(skipPinned === undefined ? {} : { skipPinned }), excludedPinnedSessionIds: ["forged"] } });
      expect(sessionDaemonRequests.at(-1)?.body).toEqual(skipPinned === undefined ? {} : { skipPinned: false });
    }
    sessionDaemonRequests.length = 0;
    expect((await app.inject({ method: "POST", url: "/api/sessions/cleanup/preview", payload: { skipPinned: true } })).statusCode).toBe(500);
    for (const skipPinned of [null, "true", 1]) {
      expect((await app.inject({ method: "POST", url: "/api/sessions/cleanup", payload: { skipPinned } })).statusCode).toBe(400);
    }
    expect(sessionDaemonRequests).toEqual([]);
  });

  it("supplies an empty snapshot when no preferences exist", async () => {
    const { app, sessionDaemonRequests } = appTestContext;
    await app.inject({ method: "POST", url: "/api/sessions/cleanup/preview", payload: { skipPinned: true } });
    expect(sessionDaemonRequests.at(-1)?.body).toEqual({ skipPinned: true, excludedPinnedSessionIds: [] });
  });
});
