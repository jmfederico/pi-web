import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  AutomationDraft,
  AutomationModelPolicy,
  AutomationScopeRequest,
  AutomationThinkingPolicy,
  AutomationTrigger,
  UpdateAutomationRequest,
} from "../../shared/apiTypes.js";
import { AutomationService, AutomationServiceError } from "./automationService.js";

export function registerAutomationRoutes(app: FastifyInstance, service: AutomationService): void {
  app.get<{ Querystring: Record<string, unknown> }>("/automations", async (request, reply) => {
    try {
      const scope = parseScope(request.query);
      return { automations: await service.list(scope), generatedAt: new Date().toISOString() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/automations", async (request, reply) => {
    try {
      return await reply.code(201).send({ automation: await service.create(parseDraft(request.body)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { automationId: string }; Body: unknown }>("/automations/:automationId", async (request, reply) => {
    try {
      return { automation: await service.update(request.params.automationId, parseUpdate(request.body)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete<{ Params: { automationId: string }; Querystring: Record<string, unknown> }>("/automations/:automationId", async (request, reply) => {
    try {
      await service.delete(request.params.automationId, parseScope(request.query));
      return { deleted: true };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { automationId: string }; Body: unknown }>("/automations/:automationId/run", async (request, reply) => {
    try {
      return await reply.code(202).send({ run: await service.runNow(request.params.automationId, parseScope(request.body)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/automation-runs", async (request, reply) => {
    try {
      const scope = parseScope(request.query);
      const automationId = optionalString(request.query["automationId"]);
      const limit = optionalInteger(request.query["limit"]);
      const runs = await service.listRuns(scope, {
        ...(automationId === undefined ? {} : { automationId }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { runs, generatedAt: new Date().toISOString() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { runId: string }; Body: unknown }>("/automation-runs/:runId/cancel", async (request, reply) => {
    try {
      return await reply.code(202).send({ run: await service.cancel(request.params.runId, parseScope(request.body)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/automation-models", () => service.models());
}

function parseDraft(value: unknown): AutomationDraft {
  const record = requireRecord(value);
  return {
    ...parseScope(record),
    name: requireString(record["name"], "name"),
    ...(record["description"] === undefined ? {} : { description: requireString(record["description"], "description") }),
    prompt: requireString(record["prompt"], "prompt"),
    trigger: parseTrigger(record["trigger"]),
    model: parseModel(record["model"]),
    thinking: parseThinking(record["thinking"]),
    ...(record["timeoutMs"] === undefined ? {} : { timeoutMs: requireInteger(record["timeoutMs"], "timeoutMs") }),
  };
}

function parseUpdate(value: unknown): UpdateAutomationRequest {
  const record = requireRecord(value);
  return {
    ...parseScope(record),
    expectedRevision: requireInteger(record["expectedRevision"], "expectedRevision"),
    ...(record["name"] === undefined ? {} : { name: requireString(record["name"], "name") }),
    ...(record["description"] === undefined ? {} : { description: requireString(record["description"], "description") }),
    ...(record["prompt"] === undefined ? {} : { prompt: requireString(record["prompt"], "prompt") }),
    ...(record["trigger"] === undefined ? {} : { trigger: parseTrigger(record["trigger"]) }),
    ...(record["model"] === undefined ? {} : { model: parseModel(record["model"]) }),
    ...(record["thinking"] === undefined ? {} : { thinking: parseThinking(record["thinking"]) }),
    ...(record["timeoutMs"] === undefined ? {} : { timeoutMs: requireInteger(record["timeoutMs"], "timeoutMs") }),
    ...(record["enabled"] === undefined ? {} : { enabled: requireBoolean(record["enabled"], "enabled") }),
  };
}

function parseScope(value: unknown): AutomationScopeRequest {
  const record = requireRecord(value);
  if (record["cwd"] !== undefined) throw new Error("cwd is not accepted; use a registered projectId and workspaceId");
  return {
    projectId: requireString(record["projectId"], "projectId"),
    workspaceId: requireString(record["workspaceId"], "workspaceId"),
  };
}

function parseTrigger(value: unknown): AutomationTrigger {
  const record = requireRecord(value);
  const type = requireString(record["type"], "trigger.type");
  if (type === "manual") return { type };
  if (type === "once") return { type, at: requireString(record["at"], "trigger.at") };
  if (type === "interval") return { type, intervalMs: requireInteger(record["intervalMs"], "trigger.intervalMs") };
  if (type === "cron") {
    return {
      type,
      expression: requireString(record["expression"], "trigger.expression"),
      timeZone: requireString(record["timeZone"], "trigger.timeZone"),
    };
  }
  throw new Error("trigger.type must be manual, once, interval, or cron");
}

function parseModel(value: unknown): AutomationModelPolicy {
  const record = requireRecord(value);
  const mode = requireString(record["mode"], "model.mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") {
    return {
      mode,
      provider: requireString(record["provider"], "model.provider"),
      id: requireString(record["id"], "model.id"),
      ...(record["name"] === undefined ? {} : { name: requireString(record["name"], "model.name") }),
    };
  }
  throw new Error("model.mode must be default or fixed");
}

function parseThinking(value: unknown): AutomationThinkingPolicy {
  const record = requireRecord(value);
  const mode = requireString(record["mode"], "thinking.mode");
  if (mode === "default") return { mode };
  if (mode === "fixed") return { mode, level: requireString(record["level"], "thinking.level") };
  throw new Error("thinking.mode must be default or fixed");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Request body must be a JSON object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Query value must be a string");
  return value;
}

function requireInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" && value !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function optionalInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : requireInteger(value, "limit");
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const statusCode = error instanceof AutomationServiceError ? error.statusCode : 400;
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(statusCode).send({ error: message });
}
