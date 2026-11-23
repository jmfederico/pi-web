import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it } from "vitest";
import { SessionDaemonClient } from "../sessiond/sessionDaemonClient.js";
import { createHttpServer } from "./httpServer.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function capture(service: "web" | "sessiond", settings: Parameters<typeof createHttpServer>[1] = {}) {
  const records: unknown[] = [];
  const app = createHttpServer(service, settings, { logger: {
    stream: { write(line: string) { records.push(JSON.parse(line)); } },
  } });
  apps.push(app);
  return { app, records };
}

it("logs only safe completion fields, linking concurrent gateway requests to their own local daemon work", async () => {
  const daemon = capture("sessiond", { httpAccessLog: true });
  daemon.app.get("/lookup", (req) => ({ id: req.id }));
  const baseUrl = await daemon.app.listen({ port: 0, host: "127.0.0.1" });
  daemon.records.length = 0;
  const client = new SessionDaemonClient({ baseUrl });
  const web = capture("web", { httpAccessLog: true });
  web.app.post("/items/:id", async () => (await client.request("GET", "/lookup")).body);
  const spoof = randomUUID();
  const responses = await Promise.all([1, 2].map(() => web.app.inject({
    method: "POST", url: "/items/secret-path?token=secret-query", payload: { value: "secret-payload" },
    headers: { "x-request-id": spoof, authorization: "secret-token", cookie: "secret-cookie", host: "secret-host.test" },
  })));
  const ids = responses.map((res) => res.headers["x-request-id"]);
  expect(new Set(ids).size).toBe(2);
  expect(ids).not.toContain(spoof);
  const durationMs: unknown = expect.any(Number);
  for (const res of responses) {
    expect(res.statusCode).toBe(200);
    const reqId = res.headers["x-request-id"];
    expect(res.json()).toEqual({ id: reqId });
    expect(web.records).toContainEqual(expect.objectContaining({
      event: "http.access", service: "web", reqId, method: "POST", route: "/items/:id", statusCode: 200, durationMs,
    }));
    expect(daemon.records).toContainEqual(expect.objectContaining({ event: "http.access", service: "sessiond", reqId, route: "/lookup" }));
  }
  await web.app.inject("/secret-missing?secret-query");
  expect(web.records).toHaveLength(3);
  expect(daemon.records).toHaveLength(2);
  expect(web.records[2]).toMatchObject({ route: "<unmatched>", statusCode: 404 });
  expect(JSON.stringify([...web.records, ...daemon.records])).not.toMatch(/secret-|incoming request/u);
});

it("keeps Fastify errors once, without enabling access logs or accepting malformed daemon IDs", async () => {
  const { app, records } = capture("sessiond");
  app.get("/failure/:id", () => { throw new Error("diagnostic cause"); });
  await app.inject("/missing?secret-query");
  expect(records).toHaveLength(0);
  const res = await app.inject({ url: "/failure/secret-path?secret-query", headers: { "x-request-id": "secret-input" } });
  expect(res.statusCode).toBe(500);
  expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  expect(records).toHaveLength(1);
  const stack: unknown = expect.any(String);
  expect(records[0]).toMatchObject({
    level: 50, service: "sessiond", reqId: res.headers["x-request-id"], err: { message: "diagnostic cause", stack },
  });
  expect(JSON.stringify(records)).not.toContain("secret-");
});

it("filters info access records at the configured severity without losing warnings", async () => {
  const { app, records } = capture("web", { logLevel: "warn", httpAccessLog: true });
  app.get("/ok", (request) => { request.log.warn("test warning"); return "ok"; });
  expect((await app.inject("/ok")).statusCode).toBe(200);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ level: 40, msg: "test warning" });
});
