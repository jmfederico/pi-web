import { readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appTestContext, fakeRemoteClient, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();
const paths = [
  "/navigation/projects",
  "/navigation/projects/project%2Fone/workspaces",
  "/navigation/projects/project%2Fone/workspaces/workspace%2Fone/session-pins",
];

describe("navigation preference API", () => {
  it.each(paths)("shares local aliases and persists %s without consulting sessiond", async (path) => {
    const { app, sessionDaemonRequests } = appTestContext;
    expect((await app.inject({ method: "GET", url: `/api${path}` })).json()).toEqual({ ids: [], revision: 0 });
    const response = await app.inject({ method: "PUT", url: `/api/machines/local${path}`, payload: { ids: ["root-2", "root-1"] } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ids: ["root-2", "root-1"], revision: 1 });
    expect((await app.inject({ method: "GET", url: `/api${path}` })).json()).toEqual(response.json());
    expect(await readFile(join(appTestContext.tempDir, "navigation-preferences.json"), "utf8")).toContain("root-2");
    expect(sessionDaemonRequests).toEqual([]);
    const invalid = await app.inject({ method: "PUT", url: `/api${path}`, payload: { ids: ["duplicate", "duplicate"] } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api${path}` })).json()).toEqual(response.json());
    const conflict = await app.inject({ method: "PUT", url: `/api${path}`, payload: { ids: ["stale"], revision: 0 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ ids: ["root-2", "root-1"], revision: 1 });
    expect((await app.inject({ method: "PUT", url: `/api${path}`, payload: { ids: [], revision: 1 } })).json()).toEqual({ ids: [], revision: 2 });
  });

  it("reports corrupt durable state as a server failure, not a successful empty preference", async () => {
    await writeFile(join(appTestContext.tempDir, "navigation-preferences.json"), '{"version":1,"entries":[{"scope":{"kind":"projects"},"ids":[1]}]}');
    const { app } = appTestContext;
    expect((await app.inject({ method: "GET", url: "/api/navigation/projects" })).statusCode).toBe(500);
    expect((await app.inject({ method: "PUT", url: "/api/navigation/projects", payload: { ids: ["p1"] } })).statusCode).toBe(500);
  });

  it("isolates workspace pins by project and workspace", async () => {
    const { app } = appTestContext;
    await app.inject({ method: "PUT", url: "/api/navigation/projects/p1/workspaces/w1/session-pins", payload: { ids: ["r1"] } });
    for (const path of ["p1/workspaces/w2", "p2/workspaces/w1"]) {
      expect((await app.inject({ method: "GET", url: `/api/navigation/projects/${path}/session-pins` })).json()).toEqual({ ids: [], revision: 0 });
    }
  });

  it.each(paths)("forwards GET and PUT to the selected server for %s", async (path) => {
    const { app } = appTestContext;
    const remote = (await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://remote.example.test/" } })).json<{ id: string }>();
    const request = vi.fn(() => Promise.resolve({ statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from(['{"ids":["remote-id"],"revision":1}']) }));
    appTestContext.remoteClient = fakeRemoteClient({ request });
    for (const method of ["GET", "PUT"] as const) {
      const payload = method === "PUT" ? { ids: ["remote-id"], revision: 0 } : undefined;
      const response = await app.inject({ method, url: `/api/machines/${remote.id}${path}`, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ids: ["remote-id"], revision: 1 });
      expect(request).toHaveBeenLastCalledWith(method, `/api${path}`, payload);
    }
    expect((await app.inject({ method: "GET", url: `/api${path}` })).json()).toEqual({ ids: [], revision: 0 });
  });
});
