import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerNoticeStore } from "./serverNoticeStore.js";
import { ServerNoticeService } from "./serverNoticeService.js";
import { registerServerNoticeRoutes } from "./serverNoticeRoutes.js";

let app: FastifyInstance;
let service: ServerNoticeService;

beforeEach(() => {
  app = Fastify({ logger: false });
  service = new ServerNoticeService(new ServerNoticeStore({ daemonInstanceId: "daemon-a", createNoticeId: () => "notice-1" }), { publishGlobal: () => undefined });
  registerServerNoticeRoutes(app, service);
});

afterEach(async () => {
  await app.close();
});

describe("server notice routes", () => {
  it("reads the current snapshot and dismisses an exact event identity", async () => {
    const notice = service.record({ severity: "error", message: "Workspace removal failed", source: "workspace.delete" });

    const snapshot = await app.inject({ method: "GET", url: "/notices" });
    const dismissed = await app.inject({
      method: "POST",
      url: "/notices/dismiss",
      payload: { daemonInstanceId: "daemon-a", noticeId: notice.id },
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ daemonInstanceId: "daemon-a", revision: 1, notices: [{ id: notice.id, source: "workspace.delete" }] });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toEqual({ daemonInstanceId: "daemon-a", revision: 2, notices: [] });
  });

  it("keeps a stale-instance dismissal harmless and validates the dismissal body", async () => {
    service.record({ severity: "warning", message: "Keep me" });

    const stale = await app.inject({
      method: "POST",
      url: "/notices/dismiss",
      payload: { daemonInstanceId: "daemon-old", noticeId: "daemon-a:notice-1" },
    });
    const invalid = await app.inject({ method: "POST", url: "/notices/dismiss", payload: { daemonInstanceId: "daemon-a" } });

    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ revision: 1, notices: [{ message: "Keep me" }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "noticeId field must not be empty" });
  });
});
