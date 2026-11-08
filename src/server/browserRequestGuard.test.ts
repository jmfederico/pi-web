import { request } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { PiWebHostAccess } from "../shared/apiTypes.js";
import { registerBrowserRequestGuard } from "./browserRequestGuard.js";

const apps = new Set<FastifyInstance>();
afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

function guardedApp(hosts: string[] | true = []) {
  return policyApp(hosts === true ? { mode: "any" } : { mode: "restricted", hosts });
}

function policyApp(policy?: PiWebHostAccess) {
  const app = Fastify();
  apps.add(app);
  registerBrowserRequestGuard(app, policy);
  const handled = vi.fn(() => ({ ok: true }));
  app.all("/resource", handled);
  return { app, handled };
}

describe("Host access decisions", () => {
  it.each([undefined, { mode: "restricted" as const, hosts: ["allowed.test"] }, { mode: "any" as const }])("keeps Origin validation independent of %j host policy", async (policy) => {
    const { app, handled } = policyApp(policy);
    const host = "unlisted.test";
    expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(policy?.mode === "restricted" ? 403 : 200);
    handled.mockClear();
    const blocked = await app.inject({ method: "POST", url: "/resource", headers: { host: "allowed.test", origin: "https://foreign.test" } });
    expect(blocked.statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });

});

describe("browser Host admission", () => {
  it.each([
    "localhost", "LOCALHOST.:8504", "dev.localhost:8505", "127.0.0.1:8504", "192.168.1.20", "[::1]:8504", "[2001:db8::1]",
  ])("allows default local and IP access: %s", async (host) => {
    const { app } = guardedApp();
    expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(200);
  });

  it.each([
    "evil.example", "localhost.evil.example", "evil-localhost", "127.0.0.1.evil.example", "example.test", "127.1", "2130706433",
  ])("blocks unlisted DNS hosts: %s", async (host) => {
    const { app, handled } = guardedApp();
    expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });

  it.each([
    "localhost:", "localhost:0", "localhost:65536", "localhost:abc", "localhost,evil.example", "localhost/path", "localhost?query",
    "user@localhost", "http://localhost", " localhost", "localhost\n", "local%68ost", "localhost\\evil", "[not-ipv6]", "[::1", "::1", "localhost..", ".localhost",
  ])("rejects malformed Host even with the allowlist disabled: %j", async (host) => {
    const { app, handled } = guardedApp(true);
    expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });

  it("rejects empty and duplicate security headers on the wire", async () => {
    const { app, handled } = guardedApp(true);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    // inject() substitutes localhost for an empty Host, and cannot preserve
    // duplicate raw headers. Exercise the actual HTTP boundary for these cases.
    for (const headers of [
      ["Host", ""],
      ["Host", "localhost", "Host", "evil.example"],
      ["Host", "localhost", "Origin", "http://localhost", "Origin", "http://localhost"],
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request(`${address}/resource`, { method: "POST", headers }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      expect(status).toBe(403);
    }
    expect(handled).not.toHaveBeenCalled();
  });

  it("matches exact names and dot-prefixed domains without suffix confusion", async () => {
    const { app } = guardedApp(["PI.Example.Test", ".trusted.test"]);
    for (const host of ["pi.example.test:8443", "pi.example.test.", "trusted.test", "child.trusted.test"]) {
      expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(200);
    }
    for (const host of ["child.pi.example.test", "untrusted.test", "trusted.test.evil.example"]) {
      expect((await app.inject({ url: "/resource", headers: { host } })).statusCode).toBe(403);
    }
  });

  it("allows any valid host in any mode, without allowing foreign Origins", async () => {
    const { app, handled } = guardedApp(true);
    expect((await app.inject({ url: "/resource", headers: { host: "unlisted.test" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/resource", headers: { host: "unlisted.test", origin: "https://other.test" } })).statusCode).toBe(403);
    expect(handled).toHaveBeenCalledOnce();
  });

  it("does not adopt later mutations of its startup policy", async () => {
    const hosts = ["initial.test"];
    const { app } = guardedApp(hosts);
    hosts.push("later.test");
    expect((await app.inject({ url: "/resource", headers: { host: "later.test" } })).statusCode).toBe(403);
  });
});

describe("browser Origin admission", () => {
  it.each([
    ["localhost:8504", "http://localhost:8504"],
    ["localhost:8505", "http://localhost:8505"],
    ["pi.example.test", "https://pi.example.test"],
    ["pi.example.test:443", "https://pi.example.test"],
    ["pi.example.test", "https://pi.example.test:443"],
    ["pi.example.test:80", "http://pi.example.test"],
    ["pi.example.test:8443", "https://pi.example.test:8443"],
    ["PI.Example.Test.:8443", "https://pi.example.test:8443"],
    ["[0:0:0:0:0:0:0:1]:8504", "http://[::1]:8504"],
    // TLS enforcement is proxy-owned; this is deliberately not full same-origin policy.
    ["pi.example.test:8504", "https://pi.example.test:8504"],
  ])("accepts matching public authority %s / %s", async (host, origin) => {
    const { app, handled } = guardedApp(["pi.example.test"]);
    const response = await app.inject({ method: "POST", url: "/resource", headers: { host, origin } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(handled).toHaveBeenCalledOnce();
  });

  it.each([
    "https://evil.example", "http://localhost:8505", "http://localhost", "null", "", "file://localhost:8504", "ws://localhost:8504",
    "http://localhost:8504/", "http://localhost:8504/path", "http://localhost:8504?query", "http://localhost:8504#fragment",
    "http://user@localhost:8504", "http://localhost:8504 http://evil.example", "http://localhost:8504,http://evil.example",
    " http://localhost:8504", "http://localhost:8504\n", "http://local%68ost:8504", "http://localhost:8504\\evil",
  ])("rejects foreign or malformed Origin before a mutation: %j", async (origin) => {
    const { app, handled } = guardedApp(true);
    const response = await app.inject({ method: "POST", url: "/resource", headers: { host: "localhost:8504", origin } });
    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(handled).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("guards %s, including bodyless requests", async (method) => {
    const { app, handled } = guardedApp();
    expect((await app.inject({ method, url: "/resource", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });

  it("allows missing Origin for non-browser mutations and does not enable CORS on safe requests", async () => {
    const { app } = guardedApp();
    expect((await app.inject({ method: "POST", url: "/resource" })).statusCode).toBe(200);
    for (const method of ["GET", "HEAD", "OPTIONS"] as const) {
      const response = await app.inject({ method, url: "/resource", headers: { origin: "https://evil.example" } });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("does not permit cross-origin mutations between two allowed hosts", async () => {
    const { app, handled } = guardedApp(["one.test", "two.test"]);
    expect((await app.inject({ method: "POST", url: "/resource", headers: { host: "one.test", origin: "https://two.test" } })).statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });

  it("never trusts forwarded headers to authorize a Host or Origin", async () => {
    const { app, handled } = guardedApp();
    const headers = { host: "localhost:8504", origin: "https://evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https" };
    expect((await app.inject({ method: "POST", url: "/resource", headers })).statusCode).toBe(403);
    expect((await app.inject({ url: "/resource", headers: { host: "evil.example", "x-forwarded-host": "localhost" } })).statusCode).toBe(403);
    expect(handled).not.toHaveBeenCalled();
  });
});

describe("WebSocket admission before upgrade", () => {
  it.each([undefined, { mode: "any" as const }])("keeps cross-origin sockets blocked with Host policy %j", async (policy) => {
    const app = Fastify();
    apps.add(app);
    await app.register(fastifyWebsocket);
    registerBrowserRequestGuard(app, policy);
    const handled = vi.fn();
    app.get("/socket", { websocket: true }, (socket) => { handled(); socket.close(); });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address.replace("http:", "ws:")}/socket`;
    expect(await handshakeStatus(url, { host: "existing.public.test", origin: "https://foreign.test" })).toBe(403);
    expect(handled).not.toHaveBeenCalled();
    expect(await handshakeStatus(url, { host: "existing.public.test", origin: "https://existing.public.test" })).toBe(101);
    expect(handled).toHaveBeenCalledOnce();
  });

  it("rejects bad Host and Origin, but accepts proxy, Vite and non-browser authorities", async () => {
    const app = Fastify();
    apps.add(app);
    await app.register(fastifyWebsocket);
    registerBrowserRequestGuard(app, { mode: "restricted", hosts: ["pi.example.test"] });
    const handled = vi.fn();
    app.get("/socket", { websocket: true }, (socket) => { handled(); socket.close(); });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address.replace("http:", "ws:")}/socket`;

    expect(await handshakeStatus(url, { host: "evil.example", origin: "https://evil.example" })).toBe(403);
    expect(await handshakeStatus(url, { host: "localhost:8504", origin: "https://evil.example" })).toBe(403);
    expect(await handshakeStatus(url, { host: "localhost:8504", origin: "null" })).toBe(403);
    expect(handled).not.toHaveBeenCalled();
    expect(await handshakeStatus(url, { host: "pi.example.test", origin: "https://pi.example.test" })).toBe(101);
    expect(await handshakeStatus(url, { host: "localhost:8505", origin: "http://localhost:8505" })).toBe(101);
    expect(await handshakeStatus(url, {})).toBe(101);
    expect(handled).toHaveBeenCalledTimes(3);
  });
});

async function handshakeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 2_000 });
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => { socket.close(); resolve(101); });
  });
}
