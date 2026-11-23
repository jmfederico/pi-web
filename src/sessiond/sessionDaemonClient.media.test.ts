import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewayRequestId } from "./gatewayRequestContext.js";
import { SessionDaemonClient } from "./sessionDaemonClient.js";

const servers: http.Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); });
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("session daemon binary transport", () => {
  it.each(["tcp", "socket"])("preserves image bytes over %s", async (transport) => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xc3, 0x28]);
    let requestedPath: string | undefined;
    const server = http.createServer((request, response) => {
      requestedPath = request.url;
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": bytes.length,
        "cache-control": "private, max-age=31536000, immutable",
      });
      response.write(bytes.subarray(0, 4));
      response.end(bytes.subarray(4));
    });
    servers.push(server);
    if (transport === "socket") {
      await listenSocket(server);
    } else {
      await listenTcp(server);
    }
    const path = `/sessions/session-1/media/${"a".repeat(64)}?cwd=%2Frepo`;
    const result = await new SessionDaemonClient().requestStream(path);
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary daemon chunks");
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(requestedPath).toBe(path);
  });

  it("forwards selected Range headers without enabling arbitrary header forwarding", async () => {
    const gatewayId = randomUUID();
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(206, { "content-type": "application/octet-stream", "content-range": "bytes 1-2/4" });
      response.end(Buffer.from([0xff, 0x00]));
    });
    servers.push(server);
    await listenTcp(server);
    const browserHeaders = { range: "bytes=1-2", "x-request-id": randomUUID(), cookie: "private" };
    const result = await withGatewayRequestId(gatewayId, () => new SessionDaemonClient().requestStream("/resource", { headers: browserHeaders }));
    expect(receivedHeaders).toMatchObject({ range: "bytes=1-2", "accept-encoding": "identity", "x-request-id": gatewayId });
    expect(receivedHeaders?.cookie).toBeUndefined();
    expect(result.statusCode).toBe(206);
    expect(result.headers["content-range"]).toBe("bytes 1-2/4");
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary chunks");
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xff, 0x00]));
  });

  it("rejects interrupted buffered socket responses instead of leaving the proxy waiting", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-length": 64, connection: "close" });
      response.end("partial");
    });
    servers.push(server);
    await listenSocket(server);
    await expect(new SessionDaemonClient().request("GET", "/status")).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  it("bounds stalled response headers", async () => {
    const server = http.createServer(() => { /* Deliberately never send headers. */ });
    servers.push(server);
    await listenTcp(server);
    await expect(new SessionDaemonClient().requestStream("/resource", { timeoutMs: 20 })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("propagates cancellation after headers to a streaming response", async () => {
    let closeResponse: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { closeResponse = resolve; });
    const server = http.createServer((_request, response) => {
      response.on("close", () => { closeResponse?.(); });
      response.writeHead(200, { "content-type": "image/png" });
      response.write(Buffer.from([0x89, 0x50]));
      // Deliberately leave the body open until the client cancels.
    });
    servers.push(server);
    await listenTcp(server);
    const controller = new AbortController();
    const result = await new SessionDaemonClient().requestStream("/sessions/s1/media/image", { signal: controller.signal });
    result.body.on("error", () => { /* Expected abort of the unfinished image body. */ });
    controller.abort();
    await closed;
    expect(controller.signal.aborted).toBe(true);
  });
});

async function listenSocket(server: http.Server): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-media-"));
  directories.push(directory);
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\pi-web-media-${randomUUID()}` : join(directory, "daemon.sock");
  vi.stubEnv("PI_WEB_SESSIOND_URL", "");
  vi.stubEnv("PI_WEB_SESSIOND_SOCKET", socketPath);
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
}

async function listenTcp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  vi.stubEnv("PI_WEB_SESSIOND_URL", `http://127.0.0.1:${String(address.port)}`);
}
