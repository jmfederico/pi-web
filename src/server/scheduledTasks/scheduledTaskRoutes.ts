import type { FastifyInstance } from "fastify";
import type { ScheduledTaskCreateRequest, ScheduledTaskSchedule, ScheduledTaskSessionMode, ScheduledTaskUpdateRequest } from "../../shared/apiTypes.js";
import type { ScheduledTaskScheduler } from "./scheduledTaskScheduler.js";
import type { ScheduledTaskService } from "./scheduledTaskService.js";

export function registerScheduledTaskRoutes(app: FastifyInstance, service: ScheduledTaskService, scheduler: ScheduledTaskScheduler, prefix = ""): void {
  app.get(`${prefix}/scheduled-tasks`, async (_request, reply) => {
    try {
      return await service.list();
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Body: unknown }>(`${prefix}/scheduled-tasks`, async (request, reply) => {
    try {
      const created = await service.create(parseCreateRequest(request.body));
      scheduler.reschedule(created);
      return await reply.code(201).send(created);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>(`${prefix}/scheduled-tasks/:id`, async (request, reply) => {
    try {
      return await service.get(request.params.id);
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(`${prefix}/scheduled-tasks/:id`, async (request, reply) => {
    try {
      const updated = await service.update(request.params.id, parseUpdateRequest(request.body));
      scheduler.reschedule(updated);
      return updated;
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { id: string } }>(`${prefix}/scheduled-tasks/:id`, async (request, reply) => {
    try {
      scheduler.unschedule(request.params.id);
      await service.remove(request.params.id);
      return { deleted: true };
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>(`${prefix}/scheduled-tasks/:id/run`, async (request, reply) => {
    try {
      return await scheduler.runNow(request.params.id);
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { id: string } }>(`${prefix}/scheduled-tasks/:id/runs`, async (request, reply) => {
    try {
      return await service.runsForTask(request.params.id);
    } catch (error) {
      return reply.code(mutationErrorStatus(error)).send({ error: errorMessage(error) });
    }
  });
}

function parseCreateRequest(body: unknown): ScheduledTaskCreateRequest {
  const record = requireRecord(body);
  const workspaceId = record["workspaceId"];
  const sessionMode = record["sessionMode"];
  const notifyOnComplete = record["notifyOnComplete"];
  const enabled = record["enabled"];
  return {
    name: requireString(record, "name"),
    projectId: requireString(record, "projectId"),
    prompt: requireString(record, "prompt"),
    schedule: parseSchedule(record["schedule"]),
    ...(typeof workspaceId === "string" && workspaceId !== "" ? { workspaceId } : {}),
    ...(sessionMode !== undefined ? { sessionMode: requireSessionMode(sessionMode) } : {}),
    ...(typeof notifyOnComplete === "boolean" ? { notifyOnComplete } : {}),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
  };
}

function parseUpdateRequest(body: unknown): ScheduledTaskUpdateRequest {
  const record = requireRecord(body);
  const name = record["name"];
  const projectId = record["projectId"];
  const workspaceId = record["workspaceId"];
  const clearWorkspaceId = record["clearWorkspaceId"];
  const prompt = record["prompt"];
  const schedule = record["schedule"];
  const sessionMode = record["sessionMode"];
  const notifyOnComplete = record["notifyOnComplete"];
  const enabled = record["enabled"];
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof projectId === "string" ? { projectId } : {}),
    ...(typeof workspaceId === "string" && workspaceId !== "" ? { workspaceId } : {}),
    ...(clearWorkspaceId === true ? { clearWorkspaceId: true } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
    ...(schedule !== undefined ? { schedule: parseSchedule(schedule) } : {}),
    ...(sessionMode !== undefined ? { sessionMode: requireSessionMode(sessionMode) } : {}),
    ...(typeof notifyOnComplete === "boolean" ? { notifyOnComplete } : {}),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
  };
}

function parseSchedule(value: unknown): ScheduledTaskSchedule {
  const record = requireRecord(value);
  return { cron: requireString(record, "cron"), timezone: requireString(record, "timezone") };
}

function requireSessionMode(value: unknown): ScheduledTaskSessionMode {
  if (value !== "new" && value !== "continue-latest") throw new Error('sessionMode must be "new" or "continue-latest"');
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Request body must be an object");
  return value;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") throw new Error(`${field} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutationErrorStatus(error: unknown): 400 | 404 {
  return isNotFoundError(error) ? 404 : 400;
}

function isNotFoundError(error: unknown): boolean {
  const message = errorMessage(error);
  return message === "Scheduled task not found" || message === "Project not found" || message === "Workspace not found";
}
