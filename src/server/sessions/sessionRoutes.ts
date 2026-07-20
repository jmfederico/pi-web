import type { FastifyInstance } from "fastify";
import { SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH, SESSION_UNREAD_CATALOG_ID_MAX_LENGTH, SESSION_UNREAD_CWD_MAX_LENGTH, SESSION_UNREAD_SESSION_ID_MAX_LENGTH, type SessionBulkMutationRequest, type SessionBulkMutationRef, type SessionCleanupRequest, type SessionTreeNavigateRequest, type SessionTreeSummaryChoice, type SessionUnreadAcknowledgeRequest } from "../../shared/apiTypes.js";
import { projectBrowserMessageResponse } from "../browserMessageProjection.js";
import { normalizeRequestCwd } from "../workingDirectory.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { SessionRouteLookup, SessionRouteService } from "./sessionService.js";
import { normalizeSessionCleanupRequest } from "./sessionCleanup.js";

type SessionLookup = SessionRouteLookup;

interface SessionQuery {
  cwd?: string;
}

interface MessageQuery extends SessionQuery {
  before?: string;
  limit?: string;
}

interface PromptRequestBody {
  cwd?: unknown;
  text?: unknown;
  streamingBehavior?: unknown;
  attachments?: unknown;
}

interface AttachmentsRequestBody {
  cwd?: unknown;
  attachments?: unknown;
  folder?: unknown;
}

const MAX_NOTIFICATION_SESSION_ID_LENGTH = 512;
const MAX_NOTIFICATION_CWD_LENGTH = 32 * 1024;
const MAX_NOTIFICATION_DAEMON_ID_LENGTH = 512;
const MAX_NOTIFICATION_ID_LENGTH = 1024;

export function registerSessionRoutes(app: FastifyInstance, sessions: SessionRouteService, eventHub: SessionEventHub, prefix = ""): void {
  app.get<{ Querystring: SessionQuery }>(`${prefix}/sessions`, async (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    try {
      return await sessions.list(normalizeRequestCwd(request.query.cwd));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.start(normalizeRequestCwd(requireString(body, "cwd")));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get(`${prefix}/sessions/notifications`, async (_request, reply) => {
    try {
      return await sessions.notificationCatalog();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get(`${prefix}/sessions/unread`, async (_request, reply) => {
    try {
      return await sessions.unreadCatalog();
    } catch (error) {
      return reply.code(503).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: Record<string, unknown> | undefined }>(`${prefix}/sessions/:sessionId/unread/acknowledge`, async (request, reply) => {
    let sessionId: string;
    let acknowledgement: SessionUnreadAcknowledgeRequest;
    try {
      const body = requireRecord(request.body);
      sessionId = requireNonEmptyBoundedString(request.params.sessionId, "sessionId", SESSION_UNREAD_SESSION_ID_MAX_LENGTH);
      acknowledgement = {
        cwd: normalizeRequestCwd(requireNonEmptyBoundedString(body["cwd"], "cwd", SESSION_UNREAD_CWD_MAX_LENGTH)),
        catalogId: requireNonEmptyBoundedString(body["catalogId"], "catalogId", SESSION_UNREAD_CATALOG_ID_MAX_LENGTH),
        throughCompletionOrder: requirePositiveSafeInteger(body["throughCompletionOrder"], "throughCompletionOrder"),
      };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
    try {
      return await sessions.acknowledgeUnread(sessionId, acknowledgement);
    } catch (error) {
      return reply.code(503).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: SessionCleanupRequest | undefined }>(`${prefix}/sessions/cleanup/preview`, async (request, reply) => {
    try {
      return await sessions.cleanupPreview(normalizeSessionCleanupRequest(optionalRecord(request.body)));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: SessionCleanupRequest | undefined }>(`${prefix}/sessions/cleanup`, async (request, reply) => {
    try {
      return await sessions.cleanup(normalizeSessionCleanupRequest(optionalRecord(request.body)));
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: SessionBulkMutationRequest | undefined }>(`${prefix}/sessions/bulk/archive`, async (request, reply) => {
    try {
      return await sessions.archiveMany(bulkMutationRefsFromBody(request.body));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: SessionBulkMutationRequest | undefined }>(`${prefix}/sessions/bulk/delete-archived`, async (request, reply) => {
    try {
      return await sessions.deleteArchivedMany(bulkMutationRefsFromBody(request.body));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/notifications`, async (request, reply) => {
    try {
      return await sessions.notificationInbox(notificationRefFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(notificationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: Record<string, unknown> | undefined }>(`${prefix}/sessions/:sessionId/notifications/dismiss`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const ref = notificationRefFromBody(request.params.sessionId, body);
      return await sessions.dismissNotification(ref, {
        daemonInstanceId: requireNonEmptyBoundedString(body["daemonInstanceId"], "daemonInstanceId", MAX_NOTIFICATION_DAEMON_ID_LENGTH),
        notificationId: requireNonEmptyBoundedString(body["notificationId"], "notificationId", MAX_NOTIFICATION_ID_LENGTH),
      });
    } catch (error) {
      return reply.code(notificationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: Record<string, unknown> | undefined }>(`${prefix}/sessions/:sessionId/notifications/dismiss-all`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      const ref = notificationRefFromBody(request.params.sessionId, body);
      return await sessions.dismissAllNotifications(ref, {
        daemonInstanceId: requireNonEmptyBoundedString(body["daemonInstanceId"], "daemonInstanceId", MAX_NOTIFICATION_DAEMON_ID_LENGTH),
        throughOrder: requireNonNegativeSafeInteger(body["throughOrder"], "throughOrder"),
        throughOverflowWatermark: requireNonNegativeSafeInteger(body["throughOverflowWatermark"], "throughOverflowWatermark"),
      });
    } catch (error) {
      return reply.code(notificationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: MessageQuery }>(`${prefix}/sessions/:sessionId/messages`, async (request, reply) => {
    try {
      const page = { ...optionalField("before", optionalNumber(request.query.before)), ...optionalField("limit", optionalNumber(request.query.limit)) };
      const messages = await sessions.messages(sessionLookupFromQuery(request.params.sessionId, request.query), page);
      return projectBrowserMessageResponse(messages);
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/status`, async (request, reply) => {
    try {
      return await sessions.status(sessionLookupFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/stream-snapshot`, async (request, reply) => {
    try {
      return await sessions.streamSnapshot(sessionLookupFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/models`, async (request, reply) => {
    try {
      return { models: await sessions.availableModels(sessionLookupFromQuery(request.params.sessionId, request.query)) };
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; provider?: unknown; modelId?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/model`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      return await sessions.setModel(sessionLookupFromBody(request.params.sessionId, body), requireString(body, "provider"), requireString(body, "modelId"));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; direction?: "forward" | "backward" } | undefined }>(`${prefix}/sessions/:sessionId/model/cycle`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      const direction = body["direction"];
      if (direction !== undefined && direction !== "forward" && direction !== "backward") throw new Error("direction must be forward or backward");
      return await sessions.cycleModel(sessionLookupFromBody(request.params.sessionId, body), direction ?? "forward");
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/thinking-levels`, async (request, reply) => {
    try {
      return { levels: await sessions.availableThinkingLevels(sessionLookupFromQuery(request.params.sessionId, request.query)) };
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; level?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/thinking-level`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      // The level string is validated against the session's live available levels
      // in the service, so it stays correct if pi changes the set.
      return await sessions.setThinkingLevel(sessionLookupFromBody(request.params.sessionId, body), requireThinkingLevel(body["level"]));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/thinking-level/cycle`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      return await sessions.cycleThinkingLevel(sessionLookupFromBody(request.params.sessionId, body));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/commands`, async (request, reply) => {
    try {
      return await sessions.commands(sessionLookupFromQuery(request.params.sessionId, request.query));
    } catch (error) {
      return reply.code(404).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: PromptRequestBody | undefined }>(`${prefix}/sessions/:sessionId/prompt`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      await sessions.prompt(sessionLookupFromBody(request.params.sessionId, body), body["text"], body["streamingBehavior"], body["attachments"]);
      return { accepted: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/queue/clear`, async (request, reply) => {
    try {
      return await sessions.clearQueue(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; dismissId?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/warnings/dismiss`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      return await sessions.dismissWarning(sessionLookupFromBody(request.params.sessionId, body), requireString(body, "dismissId"));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: AttachmentsRequestBody | undefined }>(`${prefix}/sessions/:sessionId/attachments`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      const folder = body["folder"];
      if (folder !== undefined && typeof folder !== "string") throw new Error("folder field must be a string");
      const attachments = await sessions.saveAttachments(sessionLookupFromBody(request.params.sessionId, body), body["attachments"], folder);
      return { attachments };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; text?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/shell`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      await sessions.shell(sessionLookupFromBody(request.params.sessionId, body), requireString(body, "text"));
      return { accepted: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; text?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/commands/run`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      return await sessions.runCommand(sessionLookupFromBody(request.params.sessionId, body), requireString(body, "text"));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown; requestId?: unknown; value?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/commands/respond`, async (request, reply) => {
    try {
      const body = optionalRecord(request.body);
      return await sessions.respondToCommand(sessionLookupFromBody(request.params.sessionId, body), requireString(body, "requestId"), requireString(body, "value"));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: unknown }>(`${prefix}/sessions/:sessionId/tree/navigate`, async (request, reply) => {
    try {
      const body = requireRecord(request.body);
      return await sessions.navigateTree(sessionLookupFromBody(request.params.sessionId, body), sessionTreeNavigateRequestFromBody(body));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/abort`, async (request, reply) => {
    try {
      await sessions.abort(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { aborted: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/stop`, async (request, reply) => {
    try {
      await sessions.stop(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { stopped: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/archive`, async (request, reply) => {
    try {
      await sessions.archive(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { archived: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/archive-tree`, async (request, reply) => {
    try {
      return await sessions.archiveTree(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/restore`, async (request, reply) => {
    try {
      await sessions.restore(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { restored: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId`, async (request, reply) => {
    try {
      await sessions.deleteArchived(sessionLookupFromQuery(request.params.sessionId, request.query));
      return { deleted: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/reload`, async (request, reply) => {
    try {
      await sessions.reload(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { reloaded: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { cwd?: unknown } | undefined }>(`${prefix}/sessions/:sessionId/detach-parent`, async (request, reply) => {
    try {
      await sessions.detachParent(sessionLookupFromBody(request.params.sessionId, optionalRecord(request.body)));
      return { detached: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: SessionQuery }>(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    // Only the id matters for event subscription; cwd is intentionally ignored
    // so a malformed value cannot throw inside the websocket handler.
    eventHub.add(request.params.sessionId, socket);
  });

  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });

  app.get(`${prefix}/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });
}

function bulkMutationRefsFromBody(body: SessionBulkMutationRequest | undefined): SessionBulkMutationRef[] {
  const record = requireRecord(body);
  const sessions = record["sessions"];
  if (!Array.isArray(sessions)) throw new Error("sessions field must be an array");
  return sessions.map(parseBulkMutationRef);
}

function parseBulkMutationRef(value: unknown): SessionBulkMutationRef {
  const record = requireRecord(value);
  const id = requireString(record, "id").trim();
  if (id === "") throw new Error("id field must not be empty");
  const cwd = record["cwd"];
  if (cwd === undefined || cwd === "") return { id };
  if (typeof cwd !== "string") throw new Error("cwd field must be a string");
  return { id, cwd: normalizeRequestCwd(cwd) };
}

function notificationRefFromQuery(id: string, query: SessionQuery): { id: string; cwd: string } {
  const cwd = requireNonEmptyBoundedString(query.cwd, "cwd", MAX_NOTIFICATION_CWD_LENGTH);
  return notificationRef(id, cwd);
}

function notificationRefFromBody(id: string, body: Record<string, unknown>): { id: string; cwd: string } {
  const cwd = requireNonEmptyBoundedString(body["cwd"], "cwd", MAX_NOTIFICATION_CWD_LENGTH);
  return notificationRef(id, cwd);
}

function notificationRef(id: string, cwd: string): { id: string; cwd: string } {
  return {
    id: requireNonEmptyBoundedString(id, "sessionId", MAX_NOTIFICATION_SESSION_ID_LENGTH),
    cwd: normalizeRequestCwd(cwd),
  };
}

function sessionLookupFromQuery(id: string, query: SessionQuery): SessionLookup {
  return sessionLookupFromCwd(id, query.cwd);
}

function sessionLookupFromBody(id: string, body: Record<string, unknown>): SessionLookup {
  const cwd = body["cwd"];
  if (cwd === undefined || cwd === "") return id;
  if (typeof cwd !== "string") throw new Error("cwd field must be a string");
  return { id, cwd: normalizeRequestCwd(cwd) };
}

function sessionLookupFromCwd(id: string, cwd: string | undefined): SessionLookup {
  // Legacy id-only lookups (no cwd) remain supported; a supplied cwd is
  // normalized here so everything past the route layer sees canonical paths.
  return cwd === undefined || cwd === "" ? id : { id, cwd: normalizeRequestCwd(cwd) };
}

function sessionTreeNavigateRequestFromBody(body: Record<string, unknown>): SessionTreeNavigateRequest {
  const targetId = requireNonEmptyString(body, "targetId");
  const expectedLeafId = requireNullableString(body, "expectedLeafId");
  return { targetId, expectedLeafId, summary: sessionTreeSummaryChoice(body["summary"]) };
}

function sessionTreeSummaryChoice(value: unknown): SessionTreeSummaryChoice {
  const summary = requireRecord(value);
  const mode = requireString(summary, "mode");
  if (mode === "none" || mode === "default") {
    if (Object.hasOwn(summary, "instructions")) throw new Error(`instructions field is not valid for ${mode} summary mode`);
    requireExactFields(summary, ["mode"], "summary");
    return { mode };
  }
  if (mode === "custom") {
    requireExactFields(summary, ["mode", "instructions"], "summary");
    const instructions = requireString(summary, "instructions");
    if (instructions.trim() === "") throw new Error("instructions field must not be blank");
    if (instructions.length > SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
      throw new Error(`instructions field must be at most ${String(SESSION_TREE_CUSTOM_INSTRUCTIONS_MAX_LENGTH)} characters`);
    }
    return { mode, instructions: instructions.trim() };
  }
  throw new Error("summary mode is invalid");
}

function requireExactFields(record: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(record).find((field) => !allowed.has(field));
  if (unexpected !== undefined) throw new Error(`${label} field contains unsupported property: ${unexpected}`);
}

function optionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return requireRecord(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("request body must be an object");
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${field} field must be a string`);
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = requireString(record, field);
  if (value.trim() === "") throw new Error(`${field} field must not be empty`);
  return value;
}

function requireNullableString(record: Record<string, unknown>, field: string): string | null {
  if (!Object.hasOwn(record, field)) throw new Error(`${field} field is required`);
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} field must be a string or null`);
  if (value.trim() === "") throw new Error(`${field} field must not be empty`);
  return value;
}

function requireNonEmptyBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} field must be a string`);
  if (value === "") throw new Error(`${field} field must not be empty`);
  if (value.length > maxLength) throw new Error(`${field} field is too long`);
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} field must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeSafeInteger(value, field);
  if (parsed === 0) throw new Error(`${field} field must be positive`);
  return parsed;
}

function requireThinkingLevel(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("level field is invalid");
  return value;
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> | object {
  return value === undefined ? {} : { [key]: value };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutationErrorStatus(error: unknown): 400 | 404 {
  return isSessionNotFoundError(error) ? 404 : 400;
}

function notificationErrorStatus(error: unknown): 400 | 404 {
  return isSessionNotFoundError(error) ? 404 : 400;
}

function isSessionNotFoundError(error: unknown): boolean {
  const message = errorMessage(error);
  return message === "Session not found" || message === "Archived session not found";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
