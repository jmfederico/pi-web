import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MachineStatusSnapshot } from "../../shared/machineStatus.js";
import { registerMachineStatusRoutes } from "./machineStatusRoutes.js";

const snapshot: MachineStatusSnapshot = {
  epochId: "epoch-1",
  revision: 4,
  machine: { "core:working": true },
  projects: { "project-1": { "core:working": true } },
  workspaces: { "workspace-1": { "core:working": true } },
  unattributed: {},
  generatedAt: "2026-07-27T00:00:00.000Z",
};

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("machine status routes", () => {
  it("serves the current snapshot unchanged, so an explicit refresh and the socket agree", async () => {
    registerMachineStatusRoutes(app, { snapshot: () => snapshot });

    const response = await app.inject({ method: "GET", url: "/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json<MachineStatusSnapshot>()).toEqual(snapshot);
  });
});
