import type { FastifyInstance } from "fastify";
import { MachineService, type CreateMachineInput, type UpdateMachineInput } from "./machineService.js";

export function registerMachineRoutes(app: FastifyInstance, machines = new MachineService()): void {
  app.get("/api/machines", async () => ({ machines: await machines.list() }));

  app.post<{ Body: CreateMachineInput }>("/api/machines", async (request, reply) => {
    try {
      return await machines.add(request.body);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Params: { machineId: string } }>("/api/machines/:machineId/health", async (request, reply) => {
    const health = await machines.health(request.params.machineId);
    if (health === undefined) return reply.code(404).send({ error: "Machine not found" });
    return health;
  });

  app.get<{ Params: { machineId: string }; Querystring: { refresh?: string } }>("/api/machines/:machineId/runtime", async (request, reply) => {
    const runtime = await machines.runtime(request.params.machineId, request.query.refresh === "1");
    if (runtime === undefined) return reply.code(404).send({ error: "Machine not found" });
    return runtime;
  });

  app.get<{ Params: { machineId: string } }>("/api/machines/:machineId", async (request, reply) => {
    const machine = await machines.get(request.params.machineId);
    if (machine === undefined) return reply.code(404).send({ error: "Machine not found" });
    return machine;
  });

  app.patch<{ Params: { machineId: string }; Body: UpdateMachineInput }>("/api/machines/:machineId", async (request, reply) => {
    try {
      const machine = await machines.update(request.params.machineId, request.body);
      if (machine === undefined) return await reply.code(404).send({ error: "Machine not found" });
      return machine;
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete<{ Params: { machineId: string } }>("/api/machines/:machineId", async (request, reply) => {
    try {
      const removed = await machines.remove(request.params.machineId);
      if (!removed) return await reply.code(404).send({ error: "Machine not found" });
      return { deleted: true };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
