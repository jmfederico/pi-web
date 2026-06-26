import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigRoutes, type PiWebConfigService } from "./configRoutes.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";

let app: FastifyInstance;
let savedConfig: PiWebConfigValues;
let service: PiWebConfigService;

beforeEach(async () => {
  savedConfig = { host: "127.0.0.1", port: 8504, allowedHosts: [] };
  service = {
    read: vi.fn(() => responseFor(savedConfig, true)),
    write: vi.fn((config: PiWebConfigValues) => {
      savedConfig = config;
      return responseFor(savedConfig, true);
    }),
  };
  app = Fastify({ logger: false });
  registerConfigRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("config routes", () => {
  it("returns the PI WEB config contract", async () => {
    const response = await app.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>()).toEqual(responseFor(savedConfig, true));
  });

  it("updates config through the service", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { host: "0.0.0.0", port: 9000, allowedHosts: true, spawnSessions: true, subsessions: true, agent: { command: "omp", dir: "~/.omp/agent" }, shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { note: "hidden" } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "uploads\\manual" }, maxUploadBytes: 1234 } },
    });

    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual({ host: "0.0.0.0", port: 9000, allowedHosts: true, spawnSessions: true, subsessions: true, agent: { command: "omp", dir: "~/.omp/agent" }, shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false, settings: { note: "hidden" } } }, pathAccess: { allowedPaths: ["/tmp"] }, uploads: { defaultFolder: "uploads/manual" }, maxUploadBytes: 1234 });
    expect(response.json<PiWebConfigResponse>().config).toEqual(savedConfig);
  });

  it("rejects invalid config payloads before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { host: 42 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.write).not.toHaveBeenCalled();
  });

  it("rejects invalid path access payloads before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { pathAccess: { allowedPaths: [""] } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.write).not.toHaveBeenCalled();
  });

  it("rejects invalid max upload bytes before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { maxUploadBytes: 0 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.write).not.toHaveBeenCalled();
  });

  it("rejects invalid upload defaults before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { uploads: { defaultFolder: "/tmp" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
    expect(service.write).not.toHaveBeenCalled();
  });
});

function responseFor(config: PiWebConfigValues, exists: boolean): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
