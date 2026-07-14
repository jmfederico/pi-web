import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePiWebConfigResponseBody, parseSelectedMachineConfigRequest, registerConfigRoutes, registerLocalMachineConfigRoutes, type PiWebConfigService } from "./configRoutes.js";
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
  registerLocalMachineConfigRoutes(app, service);
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
    const requestedConfig: PiWebConfigValues = {
      host: "0.0.0.0",
      port: 9000,
      allowedHosts: true,
      spawnSessions: true,
      subsessions: true,
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: { info: { enabled: false, settings: { note: "hidden" } } },
      pathAccess: { allowedPaths: ["/tmp"] },
      uploads: { defaultFolder: "uploads\\manual" },
      maxUploadBytes: 1234,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
    };
    const expectedConfig: PiWebConfigValues = {
      ...requestedConfig,
      uploads: { defaultFolder: "uploads/manual" },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: requestedConfig },
    });

    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(expectedConfig);
    expect(response.json<PiWebConfigResponse>().config).toEqual(expectedConfig);
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

  it.each([
    { agent: { command: "./agent", dir: "/srv/agent" }, error: "safe bare executable name or host-absolute executable path" },
    { agent: { command: "agent", dir: "/srv/agent", futureSetting: true }, error: 'agent contains unknown key "futureSetting"' },
  ])("rejects unsafe agent profile payloads before writing", async ({ agent, error }) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { agent } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain(error);
    expect(service.write).not.toHaveBeenCalled();
  });

  it("filters local machine config reads to selected-machine-safe keys", async () => {
    savedConfig = fullConfig();

    const response = await app.inject({ method: "GET", url: "/api/machines/local/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>()).toEqual({
      ...responseFor(savedConfig, true),
      config: selectedMachineConfig(),
      effectiveConfig: selectedMachineConfig(),
    });
  });

  it("merges local selected-machine config updates without dropping gateway-only keys", async () => {
    savedConfig = fullConfig();
    const selectedMachinePatch: PiWebConfigValues = {
      plugins: { info: { enabled: false } },
      uploads: { defaultFolder: "uploads\\manual" },
      spawnSessions: true,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: selectedMachinePatch },
    });

    const expectedConfig: PiWebConfigValues = {
      ...fullConfig(),
      plugins: { info: { enabled: false } },
      uploads: { defaultFolder: "uploads/manual" },
      spawnSessions: true,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    };
    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(expectedConfig);
    expect(service.write).toHaveBeenCalledWith(expectedConfig);
    expect(response.json<PiWebConfigResponse>().config).toEqual({
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/srv/repos"] },
      uploads: { defaultFolder: "uploads/manual" },
      maxUploadBytes: 1024,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    });
  });

  it("keeps foreign-platform agent paths portable at federation transport boundaries", () => {
    const agent = { command: "C:\\tools\\pi.exe", dir: "C:\\agent-profiles\\pi" };
    const response = {
      ...responseFor({ agent }, true),
      effectiveConfig: { agent },
    };

    expect(parsePiWebConfigResponseBody(response).config.agent).toEqual(agent);
    expect(parseSelectedMachineConfigRequest({ agent }, "portable").agent).toEqual(agent);
    if (process.platform !== "win32") {
      expect(() => parseSelectedMachineConfigRequest({ agent })).toThrow("host-absolute executable path");
    }
  });

  it("defaults missing agent override fields from older config responses", () => {
    const parsed = parsePiWebConfigResponseBody({
      path: "/tmp/pi-web/config.json",
      exists: true,
      config: {},
      effectiveConfig: {},
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false },
    });

    expect(parsed.envOverrides).toMatchObject({ agentCommand: false, agentDir: false, agentSessionDir: false });
  });

  it("retains the agent directory environment source across federation responses", () => {
    const parsed = parsePiWebConfigResponseBody({
      ...responseFor({}, false),
      envOverrides: {
        ...responseFor({}, false).envOverrides,
        agentDir: true,
        agentDirSource: "pi-compatibility",
      },
    });

    expect(parsed.envOverrides).toMatchObject({ agentDir: true, agentDirSource: "pi-compatibility" });
    expect(() => parsePiWebConfigResponseBody({
      ...responseFor({}, false),
      envOverrides: { ...responseFor({}, false).envOverrides, agentDirSource: "future-source" },
    })).toThrow("valid agent directory source");
  });

  it("rejects unsafe local selected-machine config keys before writing", async () => {
    savedConfig = fullConfig();

    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { host: "0.0.0.0", spawnSessions: true } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEB selected-machine config key is not allowed: host");
    expect(savedConfig).toEqual(fullConfig());
    expect(service.write).not.toHaveBeenCalled();
  });

  it("rejects invalid local selected-machine config values before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/machines/local/config",
      payload: { config: { spawnSessions: "yes" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("PI WEB selected-machine config spawnSessions must be a boolean");
    expect(service.write).not.toHaveBeenCalled();
  });
});

function fullConfig(): PiWebConfigValues {
  return {
    host: "127.0.0.1",
    port: 8504,
    allowedHosts: ["gateway.example.test"],
    shortcuts: { "core:view.chat": "mod+1" },
    plugins: { info: { enabled: true, settings: { note: "visible" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

function selectedMachineConfig(): PiWebConfigValues {
  return {
    plugins: { info: { enabled: true, settings: { note: "visible" } } },
    pathAccess: { allowedPaths: ["/srv/repos"] },
    uploads: { defaultFolder: "uploads" },
    maxUploadBytes: 1024,
    spawnSessions: false,
    subsessions: false,
    agent: { command: "agent-lab", dir: "/srv/agent-lab" },
  };
}

function responseFor(config: PiWebConfigValues, exists: boolean): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}
