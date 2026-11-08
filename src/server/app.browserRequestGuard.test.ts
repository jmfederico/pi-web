import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks({ hostAccess: { mode: "restricted", hosts: [] } });

describe("buildApp browser request guard wiring", () => {
  it("guards assets, APIs, and unknown routes before they run", async () => {
    for (const url of ["/", "/index.html", "/pi-web-plugins/fake/plugin.js", "/api/pi-packages", "/api/sessions", "/unknown"]) {
      const response = await appTestContext.app.inject({ url, headers: { host: "evil.example" } });
      expect(response.statusCode).toBe(403);
    }
    expect(appTestContext.piPackageRequests).toEqual([]);
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("blocks a bodyless cross-origin package update without invoking the service", async () => {
    const app = appTestContext.app;
    const blocked = await app.inject({ method: "POST", url: "/api/pi-packages/update", headers: { origin: "https://evil.example" } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    expect(appTestContext.piPackageRequests).toEqual([]);

    const accepted = await app.inject({ method: "POST", url: "/api/pi-packages/update", headers: { host: "localhost:8505", origin: "http://localhost:8505" } });
    expect(accepted.statusCode).toBe(200);
    expect(appTestContext.piPackageRequests).toEqual([{ action: "update" }]);
  });

  it("blocks cross-origin session, machine and plugin requests before upstream work", async () => {
    for (const url of ["/api/sessions", "/api/machines/local/sessions", "/api/machines/remote/sessions", "/api/plugin-sessions/terminal"]) {
      const response = await appTestContext.app.inject({ method: "POST", url, headers: { origin: "https://evil.example" }, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("rejects actual upgrades on every socket route family", async () => {
    const address = await appTestContext.app.listen({ host: "127.0.0.1", port: 0 });
    for (const path of [
      "/api/events", "/api/sessions/events", "/api/sessions/session-one/events", "/api/machines/local/events", "/api/machines/remote/events",
      "/api/paired-plugin-backends/terminal/channels/open",
      "/api/machines/local/paired-plugin-backends/terminal/projects/project/workspaces/workspace/channels/open",
      "/api/machines/remote/paired-plugin-backends/terminal/channels/open",
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${address.replace("http:", "ws:")}${path}`, { origin: "https://evil.example", handshakeTimeout: 2_000 });
        socket.once("error", reject);
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.once("open", () => { socket.close(); resolve(101); });
      });
      expect(status).toBe(403);
    }
    expect(appTestContext.app.websocketServer.clients.size).toBe(0);
    expect(appTestContext.sessionDaemonRequests).toEqual([]);
  });

  it("keeps host policy fixed until the web/API restarts", async () => {
    const saved = await appTestContext.app.inject({ method: "PUT", url: "/api/config", payload: { config: { hostAccess: { mode: "any" } } } });
    expect(saved.statusCode).toBe(200);
    const response = await appTestContext.app.inject({ url: "/api/pi-web/health", headers: { host: "evil.example" } });
    expect(response.statusCode).toBe(403);
  });

  it("leaves cross-origin JSON preflights without CORS permission", async () => {
    const response = await appTestContext.app.inject({
      method: "OPTIONS", url: "/api/pi-packages/update",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
