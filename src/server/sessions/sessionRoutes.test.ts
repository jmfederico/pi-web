import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH } from "../../shared/apiTypes.js";
import type {
  MessagePage,
  SessionBulkArchiveResponse,
  SessionBulkDeleteArchivedResponse,
  SessionBulkMutationRef,
  SessionCleanupExecuteResponse,
  SessionCleanupPreviewResponse,
  SessionNotificationDismissAllRequest,
  SessionNotificationDismissRequest,
  SessionNotificationInboxSnapshot,
  SessionRef,
  SessionStatus,
  SessionStreamSnapshot,
  SessionTreeNavigateRequest,
  SessionUnreadAcknowledgeRequest,
  SessionUnreadCatalogSnapshot,
  SessionTreeNavigateResult,
} from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { PiSessionService, type PiSessionManagerGateway } from "./piSessionService.js";
import { testModelRuntime } from "./piSessionService.testSupport.js";
import { SessionNotificationStore } from "./sessionNotificationStore.js";
import type { SessionRouteLookup, SessionRouteService } from "./sessionService.js";
import { registerSessionRoutes } from "./sessionRoutes.js";
import type { NormalizedSessionCleanupRequest } from "./sessionCleanup.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";

let app: FastifyInstance;
let service: PiSessionService;
let sessionManager: RejectingSessionManager;

beforeEach(async () => {
  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  sessionManager = new RejectingSessionManager();
  const eventHub = new SessionEventHub();
  service = new PiSessionService(eventHub, { agentDir: TEST_AGENT_DIR, sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime), sessionManager, heartbeatIntervalMs: 60_000 });
  registerSessionRoutes(app, service, eventHub);
});

afterEach(async () => {
  await service.dispose();
  await app.close();
});

describe("session routes", () => {
  it("returns notification catalog and selected-inbox snapshots with required cwd context", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const catalog = await routeApp.inject({ method: "GET", url: "/sessions/notifications" });
      const inbox = await routeApp.inject({ method: "GET", url: `/sessions/session-1/notifications?cwd=${encodeURIComponent(requestCwd)}` });

      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toEqual({ daemonInstanceId: "daemon-test", catalogRevision: 0, sessions: [] });
      expect(inbox.statusCode).toBe(200);
      expect(inbox.json()).toMatchObject({ daemonInstanceId: "daemon-test", summary: { sessionId: "session-1", cwd: requestCwd } });
      expect(routeService.notificationInboxCalls).toEqual([{ id: "session-1", cwd: requestCwd }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("returns unread snapshots and validates race-safe acknowledgement cutoffs", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const catalog = await routeApp.inject({ method: "GET", url: "/sessions/unread" });
      const acknowledged = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/unread/acknowledge",
        payload: { cwd: requestCwd, catalogId: "catalog-test", throughCompletionOrder: 7 },
      });
      const invalid = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/unread/acknowledge",
        payload: { cwd: requestCwd, catalogId: "catalog-test", throughCompletionOrder: 0 },
      });
      const oversized = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/unread/acknowledge",
        payload: {
          cwd: requestCwd,
          catalogId: "x".repeat(SESSION_UNREAD_CATALOG_ID_MAX_LENGTH + 1),
          throughCompletionOrder: 7,
        },
      });

      expect(catalog.statusCode).toBe(200);
      expect(catalog.json()).toEqual(routeService.unreadCatalogResponse);
      expect(acknowledged.statusCode).toBe(200);
      expect(acknowledged.json()).toEqual(routeService.unreadCatalogResponse);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: "throughCompletionOrder field must be positive" });
      expect(oversized.statusCode).toBe(400);
      expect(oversized.json()).toEqual({ error: "catalogId field is too long" });
      expect(routeService.acknowledgeUnreadCalls).toEqual([{
        sessionId: "session-1",
        request: { cwd: requestCwd, catalogId: "catalog-test", throughCompletionOrder: 7 },
      }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("reports unread backend failures as unavailable while keeping validation errors at 400", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    routeService.unreadError = new Error("unread persistence unavailable");
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const catalog = await routeApp.inject({ method: "GET", url: "/sessions/unread" });
      const acknowledgement = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/unread/acknowledge",
        payload: { cwd: resolve("/repo"), catalogId: "catalog-test", throughCompletionOrder: 7 },
      });
      const invalid = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/unread/acknowledge",
        payload: { cwd: "relative", catalogId: "catalog-test", throughCompletionOrder: 7 },
      });

      expect(catalog.statusCode).toBe(503);
      expect(acknowledgement.statusCode).toBe(503);
      expect(catalog.json()).toEqual({ error: "unread persistence unavailable" });
      expect(acknowledgement.json()).toEqual({ error: "unread persistence unavailable" });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("validates and forwards idempotent notification dismissal cutoffs", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const dismiss = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/notifications/dismiss",
        payload: { cwd: requestCwd, daemonInstanceId: "daemon-test", notificationId: "notice-1" },
      });
      const dismissAll = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/notifications/dismiss-all",
        payload: { cwd: requestCwd, daemonInstanceId: "daemon-test", throughOrder: 12, throughOverflowWatermark: 3 },
      });

      expect(dismiss.statusCode).toBe(200);
      expect(dismissAll.statusCode).toBe(200);
      expect(routeService.dismissNotificationCalls).toEqual([{
        ref: { id: "session-1", cwd: requestCwd },
        request: { daemonInstanceId: "daemon-test", notificationId: "notice-1" },
      }]);
      expect(routeService.dismissAllNotificationCalls).toEqual([{
        ref: { id: "session-1", cwd: requestCwd },
        request: { daemonInstanceId: "daemon-test", throughOrder: 12, throughOverflowWatermark: 3 },
      }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("keeps stale notification mutations harmless and rejects mismatched ownership", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const requestCwd = resolve("/repo");
    const notificationStore = new SessionNotificationStore({ daemonInstanceId: "daemon-current" });
    const registration = notificationStore.registerSession("session-1", requestCwd);
    notificationStore.addNotification(registration.generation, "keep", "warning");
    const routeService = new PiSessionService(eventHub, {
      agentDir: TEST_AGENT_DIR,
      sessionModelRuntimeFactory: () => Promise.resolve(testModelRuntime),
      notificationStore,
      sessionManager: new RejectingSessionManager(),
      heartbeatIntervalMs: 60_000,
    });
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const stale = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/notifications/dismiss-all",
        payload: { cwd: requestCwd, daemonInstanceId: "daemon-old", throughOrder: Number.MAX_SAFE_INTEGER, throughOverflowWatermark: Number.MAX_SAFE_INTEGER },
      });
      const mismatch = await routeApp.inject({ method: "GET", url: `/sessions/session-1/notifications?cwd=${encodeURIComponent(resolve("/other"))}` });
      const missing = await routeApp.inject({ method: "GET", url: `/sessions/missing/notifications?cwd=${encodeURIComponent(requestCwd)}` });

      expect(stale.statusCode).toBe(200);
      expect(stale.json()).toMatchObject({ summary: { retainedCount: 1, inboxRevision: 1 } });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toEqual({ error: "Session cwd mismatch" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "Session not found" });
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects malformed notification requests before calling the service", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const missingCwd = await routeApp.inject({ method: "GET", url: "/sessions/session-1/notifications" });
      const unsafeCutoff = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/notifications/dismiss-all",
        payload: { cwd: "/repo", daemonInstanceId: "daemon-test", throughOrder: Number.MAX_SAFE_INTEGER + 1, throughOverflowWatermark: 0 },
      });

      expect(missingCwd.statusCode).toBe(400);
      expect(missingCwd.json()).toEqual({ error: "cwd field must be a string" });
      expect(unsafeCutoff.statusCode).toBe(400);
      expect(unsafeCutoff.json()).toEqual({ error: "throughOrder field must be a non-negative safe integer" });
      expect(routeService.notificationInboxCalls).toEqual([]);
      expect(routeService.dismissAllNotificationCalls).toEqual([]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("strictly parses cwd-scoped session tree navigation requests", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/tree/navigate",
        payload: {
          cwd: "/repo/./",
          targetId: "entry-2",
          expectedLeafId: null,
          summary: { mode: "custom", instructions: "  focus on tests  " },
        },
      });

      const withoutSummary = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/tree/navigate",
        payload: { cwd: "/repo", targetId: "entry-1", expectedLeafId: "leaf-1", summary: { mode: "none" } },
      });
      const withDefaultSummary = await routeApp.inject({
        method: "POST",
        url: "/sessions/session-1/tree/navigate",
        payload: { cwd: "/repo", targetId: "entry-3", expectedLeafId: "leaf-2", summary: { mode: "default" } },
      });

      expect([response.statusCode, withoutSummary.statusCode, withDefaultSummary.statusCode]).toEqual([200, 200, 200]);
      expect(response.json()).toEqual({ cancelled: false, editorText: "edit this" });
      expect(routeService.navigateTreeCalls).toEqual([
        {
          lookup: { id: "session-1", cwd: resolve("/repo") },
          request: { targetId: "entry-2", expectedLeafId: null, summary: { mode: "custom", instructions: "focus on tests" } },
        },
        {
          lookup: { id: "session-1", cwd: resolve("/repo") },
          request: { targetId: "entry-1", expectedLeafId: "leaf-1", summary: { mode: "none" } },
        },
        {
          lookup: { id: "session-1", cwd: resolve("/repo") },
          request: { targetId: "entry-3", expectedLeafId: "leaf-2", summary: { mode: "default" } },
        },
      ]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects malformed session tree navigation unions before calling the service", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);
    const base = { targetId: "entry-2", expectedLeafId: "leaf-1", summary: { mode: "none" } };
    const malformed: Record<string, unknown>[] = [
      { targetId: "entry-2", summary: { mode: "none" } },
      { ...base, expectedLeafId: 1 },
      { ...base, summary: { mode: "future" } },
      { ...base, summary: { mode: "none", instructions: "not allowed" } },
      { ...base, summary: { mode: "default", instructions: "not allowed" } },
      { ...base, summary: { mode: "custom" } },
      { ...base, summary: { mode: "custom", instructions: "   " } },
      { ...base, summary: { mode: "custom", instructions: "x".repeat(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1) } },
      { ...base, summary: { mode: "custom", instructions: "focus", extra: true } },
    ];

    try {
      for (const payload of malformed) {
        const response = await routeApp.inject({ method: "POST", url: "/sessions/session-1/tree/navigate", payload });
        expect(response.statusCode).toBe(400);
      }
      expect(routeService.navigateTreeCalls).toEqual([]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects prompt payloads that omit text without opening a session", async () => {
    const response = await app.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { body: "Build the thing" } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Prompt text is required" });
    expect(sessionManager.calls).toEqual({ create: 0, list: 0, listAll: 0, open: 0 });
  });

  it("keeps legacy per-session routes usable without cwd", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const statusResponse = await routeApp.inject({ method: "GET", url: "/sessions/session-1/status" });
      const promptResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { text: "hello" } });

      expect(statusResponse.statusCode).toBe(200);
      expect(promptResponse.statusCode).toBe(200);
      expect(routeService.calls).toEqual(["session-1", { lookup: "session-1", text: "hello" }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("omits thinking signatures from browser history without mutating service messages", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    const thinkingBlock = { type: "thinking", thinking: "private chain", thinkingSignature: "opaque-provider-payload", redacted: true };
    const message = { role: "assistant", content: [thinkingBlock, { type: "text", text: "visible answer" }] };
    routeService.messagesResponse = { messages: [message], start: 0, total: 1 };
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "GET", url: "/sessions/session-1/messages?limit=20" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private chain", redacted: true }, { type: "text", text: "visible answer" }] }],
        start: 0,
        total: 1,
      });
      expect(thinkingBlock.thinkingSignature).toBe("opaque-provider-payload");
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("forwards prompt attachments and supports the save-attachments route", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    const attachments = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];
    try {
      const promptResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { text: "look", attachments } });
      expect(promptResponse.statusCode).toBe(200);
      expect(routeService.calls.at(-1)).toEqual({ lookup: "session-1", text: "look", attachments });

      const saveResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/attachments", payload: { attachments, folder: "uploads" } });
      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toEqual({ attachments: [{ path: "uploads/shot.png", mimeType: "image/png", size: 3 }] });
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("passes cwd when per-session routes include workspace context", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      // The route normalizes the request cwd, so the service sees the resolved
      // absolute path (drive-qualified on Windows).
      const requestCwd = resolve("/repo");
      const statusResponse = await routeApp.inject({ method: "GET", url: `/sessions/session-1/status?cwd=${encodeURIComponent(requestCwd)}` });
      const promptResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/prompt", payload: { cwd: requestCwd, text: "hello" } });

      expect(statusResponse.statusCode).toBe(200);
      expect(promptResponse.statusCode).toBe(200);
      expect(routeService.calls).toEqual([{ id: "session-1", cwd: requestCwd }, { lookup: { id: "session-1", cwd: requestCwd }, text: "hello" }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("reloads a session through the reload route, forwarding workspace context", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const reloadResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/reload", payload: { cwd: requestCwd } });

      expect(reloadResponse.statusCode).toBe(200);
      expect(reloadResponse.json()).toEqual({ reloaded: true });
      expect(routeService.reloadCalls).toEqual([{ id: "session-1", cwd: requestCwd }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("maps reload failures to a mutation error status", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    routeService.reloadError = new Error("Stop current session activity before reloading");
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const reloadResponse = await routeApp.inject({ method: "POST", url: "/sessions/session-1/reload", payload: {} });

      expect(reloadResponse.statusCode).toBe(400);
      expect(reloadResponse.json()).toEqual({ error: "Stop current session activity before reloading" });
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("returns the join-time stream snapshot, forwarding workspace context", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    routeService.streamSnapshotResponse = { seq: 7, partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } };
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const response = await routeApp.inject({ method: "GET", url: `/sessions/session-1/stream-snapshot?cwd=${encodeURIComponent(requestCwd)}` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ seq: 7, partial: { role: "assistant", content: [{ type: "text", text: "partial" }] } });
      expect(routeService.streamSnapshotCalls).toEqual([{ id: "session-1", cwd: requestCwd }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("maps stream-snapshot lookup failures to 404", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    routeService.streamSnapshot = () => Promise.reject(new Error("Session not found"));
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "GET", url: "/sessions/missing/stream-snapshot" });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Session not found" });
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("clears a session queue with workspace context and returns fresh status", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const response = await routeApp.inject({ method: "POST", url: "/sessions/session-1/queue/clear", payload: { cwd: requestCwd } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        sessionId: "session-1",
        isStreaming: true,
        isCompacting: false,
        isBashRunning: false,
        pendingMessageCount: 0,
        queuedMessages: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      });
      expect(routeService.clearQueueCalls).toEqual([{ id: "session-1", cwd: requestCwd }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("dismisses a session warning with workspace context and returns fresh status", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const response = await routeApp.inject({ method: "POST", url: "/sessions/session-1/warnings/dismiss", payload: { cwd: requestCwd, dismissId: "anthropicExtraUsage" } });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sessionId: "session-1" });
      expect(routeService.dismissWarningCalls).toEqual([{ lookup: { id: "session-1", cwd: requestCwd }, dismissId: "anthropicExtraUsage" }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects a warning dismiss without a dismissId", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "POST", url: "/sessions/session-1/warnings/dismiss", payload: {} });

      expect(response.statusCode).toBe(400);
      expect(routeService.dismissWarningCalls).toEqual([]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("maps archived queue-clear failures to a mutation error without requiring a body", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    routeService.clearQueueError = new Error("Archived sessions are read-only. Restore the session to continue.");
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "POST", url: "/sessions/session-1/queue/clear" });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Archived sessions are read-only. Restore the session to continue." });
      expect(routeService.clearQueueCalls).toEqual(["session-1"]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("normalizes cleanup requests for preview and execute routes", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const previewResponse = await routeApp.inject({ method: "POST", url: "/sessions/cleanup/preview", payload: { archiveIdleDays: 30, deleteArchivedDays: null, projectCwds: ["/repo-a", "/repo-a"] } });
      const executeResponse = await routeApp.inject({ method: "POST", url: "/sessions/cleanup", payload: { archiveIdleDays: null, deleteArchivedDays: 7, projectCwds: ["/repo-b"] } });

      expect(previewResponse.statusCode).toBe(200);
      expect(executeResponse.statusCode).toBe(200);
      expect(routeService.cleanupPreviewCalls).toEqual([{ thresholds: { archiveIdleDays: 30 }, projectCwds: ["/repo-a"] }]);
      expect(routeService.cleanupCalls).toEqual([{ thresholds: { deleteArchivedDays: 7 }, projectCwds: ["/repo-b"] }]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects invalid cleanup thresholds before calling the service", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "POST", url: "/sessions/cleanup", payload: { archiveIdleDays: -1 } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "archiveIdleDays field must be a non-negative integer" });
      expect(routeService.cleanupCalls).toEqual([]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("routes bulk archive and delete requests with normalized session refs", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const requestCwd = resolve("/repo");
      const archiveResponse = await routeApp.inject({ method: "POST", url: "/sessions/bulk/archive", payload: { sessions: [{ id: "s1", cwd: requestCwd }, { id: "s2" }] } });
      const deleteResponse = await routeApp.inject({ method: "POST", url: "/sessions/bulk/delete-archived", payload: { sessions: [{ id: "s1", cwd: requestCwd }] } });

      expect(archiveResponse.statusCode).toBe(200);
      expect(archiveResponse.json()).toMatchObject({ archived: true, archivedSessionIds: ["s1", "s2"], failures: [] });
      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toMatchObject({ deleted: true, deletedSessionIds: ["s1"], failures: [] });
      expect(routeService.bulkArchiveCalls).toEqual([[{ id: "s1", cwd: requestCwd }, { id: "s2" }]]);
      expect(routeService.bulkDeleteCalls).toEqual([[{ id: "s1", cwd: requestCwd }]]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });

  it("rejects malformed bulk mutation bodies before calling the service", async () => {
    const routeApp = Fastify({ logger: false });
    await routeApp.register(fastifyWebsocket);
    const eventHub = new SessionEventHub();
    const routeService = new CapturingRouteSessionService();
    registerSessionRoutes(routeApp, routeService, eventHub);

    try {
      const response = await routeApp.inject({ method: "POST", url: "/sessions/bulk/archive", payload: { sessions: [{ cwd: "/repo" }] } });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "id field must be a string" });
      expect(routeService.bulkArchiveCalls).toEqual([]);
    } finally {
      await routeService.dispose();
      await routeApp.close();
    }
  });
});

class CapturingRouteSessionService implements SessionRouteService {
  readonly calls: unknown[] = [];
  readonly reloadCalls: SessionRouteLookup[] = [];
  readonly clearQueueCalls: SessionRouteLookup[] = [];
  readonly dismissWarningCalls: { lookup: SessionRouteLookup; dismissId: string }[] = [];
  readonly notificationInboxCalls: SessionRef[] = [];
  readonly acknowledgeUnreadCalls: { sessionId: string; request: SessionUnreadAcknowledgeRequest }[] = [];
  readonly unreadCatalogResponse: SessionUnreadCatalogSnapshot = { catalogId: "catalog-test", catalogRevision: 1, sessions: [] };
  readonly dismissNotificationCalls: { ref: SessionRef; request: Omit<SessionNotificationDismissRequest, "cwd"> }[] = [];
  readonly dismissAllNotificationCalls: { ref: SessionRef; request: Omit<SessionNotificationDismissAllRequest, "cwd"> }[] = [];
  dismissWarningError: Error | undefined;
  unreadError: Error | undefined;
  messagesResponse: unknown[] | MessagePage = [];
  streamSnapshotResponse: SessionStreamSnapshot = { seq: 0, partial: null };
  readonly streamSnapshotCalls: SessionRouteLookup[] = [];
  readonly cleanupPreviewCalls: NormalizedSessionCleanupRequest[] = [];
  readonly cleanupCalls: NormalizedSessionCleanupRequest[] = [];
  readonly bulkArchiveCalls: SessionBulkMutationRef[][] = [];
  readonly bulkDeleteCalls: SessionBulkMutationRef[][] = [];
  readonly navigateTreeCalls: { lookup: SessionRouteLookup; request: SessionTreeNavigateRequest }[] = [];
  reloadError: Error | undefined;
  clearQueueError: Error | undefined;

  cleanupPreview(request: NormalizedSessionCleanupRequest): Promise<SessionCleanupPreviewResponse> {
    this.cleanupPreviewCalls.push(request);
    return Promise.resolve({ generatedAt: "2026-06-25T00:00:00.000Z", thresholds: request.thresholds, projects: [], totals: { archiveCount: 0, deleteCount: 0 } });
  }

  cleanup(request: NormalizedSessionCleanupRequest): Promise<SessionCleanupExecuteResponse> {
    this.cleanupCalls.push(request);
    return Promise.resolve({ generatedAt: "2026-06-25T00:00:00.000Z", thresholds: request.thresholds, projects: [], totals: { archiveCount: 0, deleteCount: 0 }, archivedSessionIds: [], deletedSessionIds: [] });
  }

  archiveMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkArchiveResponse> {
    this.bulkArchiveCalls.push([...refs]);
    return Promise.resolve({ archived: true, archivedSessionIds: refs.map((ref) => ref.id), failures: [], generatedAt: "2026-06-25T00:00:00.000Z" });
  }

  deleteArchivedMany(refs: readonly SessionBulkMutationRef[]): Promise<SessionBulkDeleteArchivedResponse> {
    this.bulkDeleteCalls.push([...refs]);
    return Promise.resolve({ deleted: true, deletedSessionIds: refs.map((ref) => ref.id), failures: [], generatedAt: "2026-06-25T00:00:00.000Z" });
  }

  reload(lookup: SessionRouteLookup): Promise<void> {
    this.reloadCalls.push(lookup);
    if (this.reloadError !== undefined) return Promise.reject(this.reloadError);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  notificationCatalog() {
    return { daemonInstanceId: "daemon-test", catalogRevision: 0, sessions: [] };
  }

  unreadCatalog(): Promise<SessionUnreadCatalogSnapshot> {
    return this.unreadError === undefined
      ? Promise.resolve(this.unreadCatalogResponse)
      : Promise.reject(this.unreadError);
  }

  acknowledgeUnread(sessionId: string, request: SessionUnreadAcknowledgeRequest): Promise<SessionUnreadCatalogSnapshot> {
    this.acknowledgeUnreadCalls.push({ sessionId, request });
    return this.unreadError === undefined
      ? Promise.resolve(this.unreadCatalogResponse)
      : Promise.reject(this.unreadError);
  }

  notificationInbox(ref: SessionRef): SessionNotificationInboxSnapshot {
    this.notificationInboxCalls.push(ref);
    return notificationSnapshot(ref);
  }

  dismissNotification(ref: SessionRef, request: Omit<SessionNotificationDismissRequest, "cwd">): SessionNotificationInboxSnapshot {
    this.dismissNotificationCalls.push({ ref, request });
    return notificationSnapshot(ref);
  }

  dismissAllNotifications(ref: SessionRef, request: Omit<SessionNotificationDismissAllRequest, "cwd">): SessionNotificationInboxSnapshot {
    this.dismissAllNotificationCalls.push({ ref, request });
    return notificationSnapshot(ref);
  }

  list(): never { throw unusedRouteMethod("list"); }
  start(): never { throw unusedRouteMethod("start"); }

  dismissWarning(lookup: SessionRouteLookup, dismissId: string): Promise<SessionStatus> {
    this.dismissWarningCalls.push({ lookup, dismissId });
    if (this.dismissWarningError !== undefined) return Promise.reject(this.dismissWarningError);
    return Promise.resolve({
      sessionId: sessionIdFromLookup(lookup),
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }

  clearQueue(lookup: SessionRouteLookup): Promise<SessionStatus> {
    this.clearQueueCalls.push(lookup);
    if (this.clearQueueError !== undefined) return Promise.reject(this.clearQueueError);
    return Promise.resolve({
      sessionId: sessionIdFromLookup(lookup),
      isStreaming: true,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }

  messages(): Promise<unknown[] | MessagePage> {
    return Promise.resolve(this.messagesResponse);
  }

  status(lookup: SessionRouteLookup) {
    this.calls.push(lookup);
    return Promise.resolve({
      sessionId: sessionIdFromLookup(lookup),
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      pendingMessageCount: 0,
      queuedMessages: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    });
  }

  streamSnapshot(lookup: SessionRouteLookup): Promise<SessionStreamSnapshot> {
    this.streamSnapshotCalls.push(lookup);
    return Promise.resolve(this.streamSnapshotResponse);
  }

  availableModels(): Promise<[]> { return Promise.resolve([]); }
  setModel(): never { throw unusedRouteMethod("setModel"); }
  cycleModel(): never { throw unusedRouteMethod("cycleModel"); }
  availableThinkingLevels(): Promise<[]> { return Promise.resolve([]); }
  setThinkingLevel(): never { throw unusedRouteMethod("setThinkingLevel"); }
  cycleThinkingLevel(): never { throw unusedRouteMethod("cycleThinkingLevel"); }
  commands(): Promise<[]> { return Promise.resolve([]); }

  prompt(lookup: SessionRouteLookup, text: unknown, _streamingBehavior?: unknown, attachments?: unknown): Promise<void> {
    this.calls.push(attachments === undefined ? { lookup, text } : { lookup, text, attachments });
    return Promise.resolve();
  }

  saveAttachments(_lookup: SessionRouteLookup, attachments: unknown, folder?: string) {
    const list = Array.isArray(attachments) ? attachments : [];
    return Promise.resolve(list.map((attachment: { mimeType: string; data: string; name?: string }) => ({
      path: `${folder ?? ".pi-web/attachments"}/${attachment.name ?? "file.png"}`,
      mimeType: attachment.mimeType,
      size: Buffer.from(attachment.data, "base64").byteLength,
    })));
  }

  shell(): never { throw unusedRouteMethod("shell"); }
  runCommand(): never { throw unusedRouteMethod("runCommand"); }
  respondToCommand(): never { throw unusedRouteMethod("respondToCommand"); }
  navigateTree(lookup: SessionRouteLookup, request: SessionTreeNavigateRequest): Promise<SessionTreeNavigateResult> {
    this.navigateTreeCalls.push({ lookup, request });
    return Promise.resolve({ cancelled: false, editorText: "edit this" });
  }
  abort(): never { throw unusedRouteMethod("abort"); }
  stop(): never { throw unusedRouteMethod("stop"); }
  archive(): never { throw unusedRouteMethod("archive"); }
  archiveTree(): never { throw unusedRouteMethod("archiveTree"); }
  restore(): never { throw unusedRouteMethod("restore"); }
  deleteArchived(): never { throw unusedRouteMethod("deleteArchived"); }


  detachParent(): never { throw unusedRouteMethod("detachParent"); }
}

class RejectingSessionManager implements PiSessionManagerGateway {
  readonly calls = { create: 0, list: 0, listAll: 0, open: 0 };

  list() {
    this.calls.list += 1;
    return Promise.resolve([]);
  }

  create(): never {
    this.calls.create += 1;
    throw new Error("Session manager should not create sessions for invalid prompt payloads");
  }

  listAll() {
    this.calls.listAll += 1;
    return Promise.resolve([]);
  }

  open(): never {
    this.calls.open += 1;
    throw new Error("Session manager should not open sessions for invalid prompt payloads");
  }
}

function notificationSnapshot(ref: SessionRef): SessionNotificationInboxSnapshot {
  return {
    daemonInstanceId: "daemon-test",
    catalogRevision: 0,
    summary: { sessionId: ref.id, cwd: ref.cwd, inboxRevision: 0, retainedCount: 0, discardedCount: 0 },
    notifications: [],
    dismissThrough: { order: 0, overflowWatermark: 0 },
  };
}

function sessionIdFromLookup(lookup: SessionRouteLookup): string {
  return typeof lookup === "string" ? lookup : lookup.id;
}

function unusedRouteMethod(name: string): Error {
  return new Error(`Route test did not expect ${name} to be called`);
}
