import type { FastifyInstance } from "fastify";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { PiSessionService } from "./piSessionService.js";

interface PromptRequestBody {
  text?: unknown;
  streamingBehavior?: unknown;
}

export function registerSessionRoutes(app: FastifyInstance, sessions: PiSessionService, eventHub: SessionEventHub, prefix = ""): void {
  app.get<{ Querystring: { cwd?: string } }>(`${prefix}/sessions`, async (request, reply) => {
    if (request.query.cwd === undefined || request.query.cwd === "") return reply.code(400).send({ error: "cwd query parameter is required" });
    return sessions.list(request.query.cwd);
  });

  app.post<{ Body: { cwd: string } }>(`${prefix}/sessions`, async (request, reply) => {
    try {
      return await sessions.start(request.body.cwd);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { before?: string; limit?: string } }>(`${prefix}/sessions/:sessionId/messages`, async (request, reply) => {
    try {
      const page = { ...optionalField("before", optionalNumber(request.query.before)), ...optionalField("limit", optionalNumber(request.query.limit)) };
      return await sessions.messages(request.params.sessionId, page);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/status`, async (request, reply) => {
    try {
      return await sessions.status(request.params.sessionId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/models`, async (request, reply) => {
    try {
      return { models: await sessions.availableModels(request.params.sessionId) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { provider: string; modelId: string } }>(`${prefix}/sessions/:sessionId/model`, async (request, reply) => {
    try {
      return await sessions.setModel(request.params.sessionId, request.body.provider, request.body.modelId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { direction?: "forward" | "backward" } }>(`${prefix}/sessions/:sessionId/model/cycle`, async (request, reply) => {
    try {
      return await sessions.cycleModel(request.params.sessionId, request.body.direction ?? "forward");
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/thinking-levels`, async (request, reply) => {
    try {
      return { levels: await sessions.availableThinkingLevels(request.params.sessionId) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" } }>(`${prefix}/sessions/:sessionId/thinking-level`, async (request, reply) => {
    try {
      return await sessions.setThinkingLevel(request.params.sessionId, request.body.level);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/thinking-level/cycle`, async (request, reply) => {
    try {
      return await sessions.cycleThinkingLevel(request.params.sessionId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/commands`, async (request, reply) => {
    try {
      return await sessions.commands(request.params.sessionId);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: PromptRequestBody | undefined }>(`${prefix}/sessions/:sessionId/prompt`, async (request, reply) => {
    try {
      await sessions.prompt(request.params.sessionId, request.body?.text, request.body?.streamingBehavior);
      return { accepted: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { text: string } }>(`${prefix}/sessions/:sessionId/shell`, async (request, reply) => {
    try {
      await sessions.shell(request.params.sessionId, request.body.text);
      return { accepted: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { text: string } }>(`${prefix}/sessions/:sessionId/commands/run`, async (request, reply) => {
    try {
      return await sessions.runCommand(request.params.sessionId, request.body.text);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string }; Body: { requestId: string; value: string } }>(`${prefix}/sessions/:sessionId/commands/respond`, async (request, reply) => {
    try {
      return await sessions.respondToCommand(request.params.sessionId, request.body.requestId, request.body.value);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/abort`, async (request) => {
    await sessions.abort(request.params.sessionId);
    return { aborted: true };
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/stop`, (request) => {
    sessions.stop(request.params.sessionId);
    return { stopped: true };
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/archive`, async (request, reply) => {
    try {
      await sessions.archive(request.params.sessionId);
      return { archived: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/archive-tree`, async (request, reply) => {
    try {
      return await sessions.archiveTree(request.params.sessionId);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/restore`, async (request, reply) => {
    try {
      await sessions.restore(request.params.sessionId);
      return { restored: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId`, async (request, reply) => {
    try {
      await sessions.deleteArchived(request.params.sessionId);
      return { deleted: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/detach-parent`, async (request, reply) => {
    try {
      await sessions.detachParent(request.params.sessionId);
      return { detached: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>(`${prefix}/sessions/:sessionId/events`, { websocket: true }, (socket, request) => {
    eventHub.add(request.params.sessionId, socket);
  });

  app.get(`${prefix}/sessions/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });

  app.get(`${prefix}/events`, { websocket: true }, (socket) => {
    eventHub.addGlobal(socket);
  });
}

function optionalField<T>(key: string, value: T | undefined): Record<string, T> | object {
  return value === undefined ? {} : { [key]: value };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
