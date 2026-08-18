import type { FastifyInstance } from "fastify";
import type { MachineStatusSnapshot } from "../../shared/machineStatus.js";

export interface MachineStatusRouteService {
  snapshot(): MachineStatusSnapshot;
}

/**
 * Serves the same snapshot the realtime socket delivers, for the browser's
 * explicit refresh paths and for the federated HTTP route.
 */
export function registerMachineStatusRoutes(app: FastifyInstance, status: MachineStatusRouteService, prefix = ""): void {
  app.get(`${prefix}/status`, () => status.snapshot());
}
