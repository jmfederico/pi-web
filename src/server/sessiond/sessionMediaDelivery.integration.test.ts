import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { describe, expect, it, vi } from "vitest";
import type { MessagePage } from "../../shared/apiTypes.js";
import { isSessionMediaId } from "../../shared/sessionMedia.js";
import { SessionDaemonClient } from "../../sessiond/sessionDaemonClient.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService } from "../sessions/piSessionService.js";
import { fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "../sessions/piSessionService.testSupport.js";
import { SessionArchiveStore } from "../sessions/sessionArchiveStore.js";
import { registerSessionRoutes } from "../sessions/sessionRoutes.js";
import { registerSessionProxyRoutes } from "./sessionProxyRoutes.js";

describe("browser-facing session media delivery", () => {
  it("roundtrips a projected image through the real daemon HTTP client and local proxy without changing Pi content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-media-delivery-"));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
    const data = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(60 * 1024)]).toString("base64");
    const image = Object.freeze({ type: "image", mimeType: "image/png", data });
    const message = Object.freeze({ role: "user", content: Object.freeze([image]) });
    const entries = [{ type: "message", id: "entry-1", message }];
    const runtime = fakeRuntime("session-1", {
      sessionManager: fakeSessionManager("/workspace", { getBranch: () => entries, getEntries: () => entries }),
    });
    const hub = new SessionEventHub();
    const service = new PiSessionService(hub, {
      agentDir: directory,
      modelRuntime: testModelRuntime,
      archiveStore: new SessionArchiveStore(join(directory, "archives.json")),
      sessionManager: sessionGateway([sessionRecord("session-1")]),
      createAgentRuntime: runtimeCreator(runtime.runtime),
      heartbeatIntervalMs: 60_000,
    });
    const daemon = Fastify({ logger: false });
    const gateway = Fastify({ logger: false });
    try {
      await daemon.register(fastifyWebsocket);
      registerSessionRoutes(daemon, service, hub);
      const url = await daemon.listen({ host: "127.0.0.1", port: 0 });
      vi.stubEnv("PI_WEB_SESSIOND_URL", url);
      await gateway.register(fastifyWebsocket);
      registerSessionProxyRoutes(gateway, new SessionDaemonClient(), "/api/machines/local");
      const base = "/api/machines/local/sessions/session-1";
      const inline = await gateway.inject({ url: `${base}/messages?cwd=%2Fworkspace` });
      expect(inline.json<MessagePage>().messages).toEqual([{ ...message, entryId: "entry-1" }]);
      const references = await gateway.inject({ url: `${base}/messages?cwd=%2Fworkspace&media=reference` });
      const page = references.json<MessagePage>();
      const first: unknown = page.messages[0];
      if (typeof first !== "object" || first === null || !("content" in first) || !Array.isArray(first.content)) throw new Error("Expected image content");
      const part: unknown = first.content[0];
      if (typeof part !== "object" || part === null || !("mediaId" in part) || !isSessionMediaId(part.mediaId)) throw new Error("Expected media reference");
      expect(part).toMatchObject({ width: 1, height: 1 });
      expect(references.body.length).toBeLessThan(inline.body.length / 100);
      expect(references.body).not.toContain(data);
      const served = await gateway.inject({ url: `${base}/media/${part.mediaId}?cwd=%2Fworkspace` });
      expect(served.statusCode).toBe(200);
      expect(served.rawPayload).toEqual(Buffer.from(data, "base64"));
      expect(served.headers["content-type"]).toBe("image/png");
      expect(served.headers["content-length"]).toBe(String(Buffer.from(data, "base64").byteLength));
      expect(served.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(served.headers["x-content-type-options"]).toBe("nosniff");
      expect(entries[0]?.message).toBe(message);
      expect(message.content).toEqual([image]);
    } finally {
      vi.unstubAllEnvs();
      await gateway.close();
      await daemon.close();
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
