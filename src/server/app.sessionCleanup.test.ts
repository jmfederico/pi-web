import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("cleanup daemon pin authority", () => {
  it.each(["/api/sessions/cleanup/preview", "/api/machines/local/sessions/cleanup"])("forwards skipPinned without a web snapshot for %s", async (url) => {
    const { app, sessionDaemonRequests, tempDir } = appTestContext;
    await writeFile(join(tempDir, "navigation-preferences.json"), "unreadable legacy state is not a web cleanup dependency");
    const response = await app.inject({ method: "POST", url, payload: { skipPinned: true, archiveIdleDays: 30, excludedPinnedSessionIds: ["forged"] } });
    expect(response.statusCode).toBe(200);
    expect(sessionDaemonRequests).toEqual([
      { method: "GET", path: "/runtime" },
      { method: "POST", path: url.endsWith("preview") ? "/sessions/cleanup/preview" : "/sessions/cleanup", body: { skipPinned: true, archiveIdleDays: 30 } },
    ]);
  });

  it("does not require pin capability for omitted/false and rejects malformed flags", async () => {
    const { app, sessionDaemonRequests } = appTestContext;
    for (const skipPinned of [undefined, false]) {
      const response = await app.inject({ method: "POST", url: "/api/sessions/cleanup", payload: { ...(skipPinned === undefined ? {} : { skipPinned }), excludedPinnedSessionIds: ["forged"] } });
      expect(response.statusCode).toBe(200);
      expect(sessionDaemonRequests.at(-1)?.body).toEqual(skipPinned === undefined ? {} : { skipPinned: false });
    }
    sessionDaemonRequests.length = 0;
    for (const skipPinned of [null, "true", 1]) {
      expect((await app.inject({ method: "POST", url: "/api/sessions/cleanup", payload: { skipPinned } })).statusCode).toBe(400);
    }
    expect(sessionDaemonRequests).toEqual([]);
  });
});
