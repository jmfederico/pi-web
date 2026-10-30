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
  it.each(["/api/config", "/api/machines/local/config"])("exposes and validates sessionMessages through %s", async (url) => {
    const saved = await app.inject({ method: "PUT", url, payload: { config: { sessionMessages: false } } });
    expect(saved.statusCode).toBe(200);
    expect(parsePiWebConfigResponseBody(saved.json())).toMatchObject({ config: { sessionMessages: false }, effectiveConfig: { sessionMessages: false } });
    const read = await app.inject({ method: "GET", url });
    expect(read.json<PiWebConfigResponse>().config.sessionMessages).toBe(false);
    vi.mocked(service.write).mockClear();
    const rejected = await app.inject({ method: "PATCH", url, payload: { set: { sessionMessages: "false" } } });
    expect(rejected.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
  });

  it("accepts canonical localization defaults and empty resets through the gateway API", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config: {
      defaultLocalization: { language: "EN-us", formatLocale: "de-de", timeZone: "utc", hourCycle: "h12" },
    } } });
    expect(response.statusCode).toBe(200);
    const config = { defaultLocalization: { language: "en-US", formatLocale: "de-DE", timeZone: "UTC", hourCycle: "h12" } };
    expect(savedConfig).toEqual(config);
    expect(parsePiWebConfigResponseBody(response.json())).toMatchObject({ config, effectiveConfig: config });
    const reset = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { defaultLocalization: {} } } });
    expect(reset.statusCode).toBe(200);
    expect(savedConfig.defaultLocalization).toEqual({});
  });

  it.each([null, [], { language: "en_US" }, { language: "ar-XB" }, { formatLocale: "en-XA" }, { timeZone: "invalid" }, { hourCycle: "12" }, { extra: true }])("rejects invalid localization defaults %j in API updates and responses", async (defaultLocalization) => {
    const config = { defaultLocalization };
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("defaultLocalization");
    expect(service.write).not.toHaveBeenCalled();
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...responseFor({}, true), [field]: config })).toThrow("defaultLocalization");
    }
  });

  it("isolates gateway localization defaults from selected-machine reads and writes", async () => {
    const defaultLocalization = { language: "fr", timeZone: "UTC" };
    savedConfig.defaultLocalization = defaultLocalization;
    const read = await app.inject({ method: "GET", url: "/api/machines/local/config" });
    expect(read.json<PiWebConfigResponse>().config).not.toHaveProperty("defaultLocalization");
    expect(read.json<PiWebConfigResponse>().effectiveConfig).not.toHaveProperty("defaultLocalization");
    const rejected = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { defaultLocalization: {} } } });
    expect(rejected.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
    const accepted = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { askUser: false } } });
    expect(accepted.statusCode).toBe(200);
    expect(savedConfig.defaultLocalization).toEqual(defaultLocalization);
    expect(accepted.json<PiWebConfigResponse>().config).not.toHaveProperty("defaultLocalization");
  });

  it.each(["/api/config", "/api/machines/local/config"])("updates and clears installation identity through %s", async (url) => {
    const response = await app.inject({ method: "PUT", url, payload: { config: { installationName: "  Build lab  " } } });
    expect(response.statusCode).toBe(200);
    expect(parsePiWebConfigResponseBody(response.json()).config.installationName).toBe("Build lab");
    const cleared = await app.inject({ method: "PUT", url, payload: { config: { installationName: "" } } });
    expect(cleared.statusCode).toBe(200);
    expect(savedConfig.installationName).toBe("");
  });

  it.each([null, 42, "x".repeat(121), "Lab\nOffice"])("rejects malformed installation identity %j", async (installationName) => {
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { installationName } } });
    expect(response.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
  });
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
      defaultTheme: { themeId: "themes:pi-web-light", auto: false },
      plugins: { info: { enabled: false, settings: { note: "hidden" } } },
      pathAccess: { allowedPaths: ["/tmp"] },
      uploads: { defaultFolder: "uploads\\manual" },
      attachments: { defaultFolder: "attachments\\saved" },
      maxUploadBytes: 1234,
      sessionArchive: { directory: "/external/archives" },
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
    };
    const expectedConfig: PiWebConfigValues = {
      ...requestedConfig,
      uploads: { defaultFolder: "uploads/manual" },
      attachments: { defaultFolder: "attachments/saved" },
    };

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: requestedConfig },
    });

    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(expectedConfig);
    expect(response.json<PiWebConfigResponse>().config).toEqual(expectedConfig);
    expect(parsePiWebConfigResponseBody(response.json()).config).toEqual(expectedConfig);
  });

  it.each(["/api/config", "/api/machines/local/config"])("saves and resets session naming through %s", async (url) => {
    const sessionNaming = { model: "provider/org/model", maxTokens: 64, thinkingLevel: "off" as const, timeoutMs: 2147483647 };
    const saved = await app.inject({ method: "PUT", url, payload: { config: { sessionNaming } } });
    expect(saved.statusCode).toBe(200);
    expect(parsePiWebConfigResponseBody(saved.json()).config.sessionNaming).toEqual(sessionNaming);
    expect(parsePiWebConfigResponseBody(saved.json()).effectiveConfig.sessionNaming).toEqual(sessionNaming);
    const reset = await app.inject({ method: "PUT", url, payload: { config: { sessionNaming: {} } } });
    expect(reset.statusCode).toBe(200);
    expect(savedConfig.sessionNaming).toEqual({});
  });

  it("preserves session naming on unrelated selected-machine saves", async () => {
    const sessionNaming = { model: "provider/model", maxTokens: 48, thinkingLevel: "high" as const, timeoutMs: 15000 };
    savedConfig.sessionNaming = sessionNaming;
    const response = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { spawnSessions: false } } });
    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>().config.sessionNaming).toEqual(sessionNaming);
    expect(savedConfig.sessionNaming).toEqual(sessionNaming);
  });

  it.each(["/api/config", "/api/machines/local/config"])("validates session naming before writing through %s", async (url) => {
    const response = await app.inject({ method: "PUT", url, payload: { config: { sessionNaming: { maxTokens: 0 } } } });
    expect(response.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
  });

  it.each(["", "ultra", null, false, 42, {}, []])("rejects invalid naming thinking level %j before writing and in remote responses", async (thinkingLevel) => {
    const config = { sessionNaming: { thinkingLevel } };
    for (const url of ["/api/config", "/api/machines/local/config"]) {
      const result = await app.inject({ method: "PUT", url, payload: { config } });
      expect(result.statusCode).toBe(400);
      expect(result.json<{ error: string }>().error).toContain("sessionNaming.thinkingLevel");
    }
    expect(service.write).not.toHaveBeenCalled();
    const response = responseFor({}, true);
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...response, [field]: config })).toThrow("sessionNaming.thinkingLevel");
    }
  });

  it.each([0, -1, 1.5, 2147483648, "10000", null, false, {}, []])("rejects invalid naming timeout %j before writing and in remote responses", async (timeoutMs) => {
    const config = { sessionNaming: { timeoutMs } };
    for (const url of ["/api/config", "/api/machines/local/config"]) {
      const result = await app.inject({ method: "PUT", url, payload: { config } });
      expect(result.statusCode).toBe(400);
      expect(result.json<{ error: string }>().error).toContain("sessionNaming.timeoutMs");
    }
    expect(service.write).not.toHaveBeenCalled();
    const response = responseFor({}, true);
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...response, [field]: config })).toThrow("sessionNaming.timeoutMs");
    }
  });

  it("rejects invalid session naming in remote config responses", () => {
    const response = responseFor({}, true);
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...response, [field]: { sessionNaming: { model: "/missing" } } })).toThrow("sessionNaming.model");
    }
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

  it.each(["steer", "followUp"] as const)("accepts defaultStreamingBehavior %s through config routes and response parsing", async (defaultStreamingBehavior) => {
    const config = { defaultStreamingBehavior };
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config } });
    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(config);
    expect(parsePiWebConfigResponseBody(response.json())).toMatchObject({ config, effectiveConfig: config });
  });

  it.each(["", "followup", "queue", null, false, 42, {}, []])("rejects invalid defaultStreamingBehavior %j before writing and in responses", async (defaultStreamingBehavior) => {
    const config = { defaultStreamingBehavior };
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("defaultStreamingBehavior");
    expect(service.write).not.toHaveBeenCalled();
    const valid = responseFor({}, true);
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...valid, [field]: config })).toThrow("defaultStreamingBehavior");
    }
  });

  it("keeps defaultStreamingBehavior gateway-only", async () => {
    savedConfig.defaultStreamingBehavior = "steer";
    const read = await app.inject({ method: "GET", url: "/api/machines/local/config" });
    expect(read.json<PiWebConfigResponse>().config).not.toHaveProperty("defaultStreamingBehavior");
    expect(read.json<PiWebConfigResponse>().effectiveConfig).not.toHaveProperty("defaultStreamingBehavior");
    const write = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { defaultStreamingBehavior: "followUp" } } });
    expect(write.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
    expect(savedConfig.defaultStreamingBehavior).toBe("steer");
  });

  it.each([true, false])("accepts quietMode %s through config routes and response parsing", async (quietMode) => {
    const config = { quietMode };
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config } });
    expect(response.statusCode).toBe(200);
    expect(savedConfig).toEqual(config);
    expect(parsePiWebConfigResponseBody(response.json())).toMatchObject({ config, effectiveConfig: config });
  });

  it.each(["true", 1, null, {}, []])("rejects invalid quietMode %j before writing and in responses", async (quietMode) => {
    const config = { quietMode };
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("quietMode");
    expect(service.write).not.toHaveBeenCalled();
    const valid = responseFor({}, true);
    for (const field of ["config", "effectiveConfig"]) {
      expect(() => parsePiWebConfigResponseBody({ ...valid, [field]: config })).toThrow("quietMode");
    }
  });

  it("keeps quietMode gateway-only", async () => {
    savedConfig.quietMode = true;
    const read = await app.inject({ method: "GET", url: "/api/machines/local/config" });
    expect(read.json<PiWebConfigResponse>().config).not.toHaveProperty("quietMode");
    expect(read.json<PiWebConfigResponse>().effectiveConfig).not.toHaveProperty("quietMode");
    const write = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { quietMode: false } } });
    expect(write.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
    expect(savedConfig.quietMode).toBe(true);
  });

  it("rejects malformed theme defaults before writing", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/config", payload: { config: { defaultTheme: { themeId: "themes:pi-web-dark", auto: "yes" } } } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("defaultTheme");
    expect(service.write).not.toHaveBeenCalled();
  });

  it("keeps theme defaults gateway-only in selected-machine reads and writes", async () => {
    savedConfig.defaultTheme = { themeId: "themes:pi-web-light", auto: true };
    const read = await app.inject({ method: "GET", url: "/api/machines/local/config" });
    expect(read.json<PiWebConfigResponse>().config).not.toHaveProperty("defaultTheme");
    const write = await app.inject({ method: "PUT", url: "/api/machines/local/config", payload: { config: { defaultTheme: { themeId: "themes:classic", auto: false } } } });
    expect(write.statusCode).toBe(400);
    expect(service.write).not.toHaveBeenCalled();
    expect(savedConfig.defaultTheme.themeId).toBe("themes:pi-web-light");
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

  it("rejects invalid attachment defaults before writing", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { config: { attachments: { defaultFolder: "../outside" } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain("attachments.defaultFolder");
    expect(service.write).not.toHaveBeenCalled();
  });

  it.each([
    { agent: { command: "agent", dir: "relative/agent" }, error: "agent.dir must be a host-absolute path" },
    { agent: { command: "agent", dir: "/srv/agent", futureSetting: true }, error: 'agent accepts only the deprecated keys "command" and "dir"; unknown key "futureSetting"' },
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
      attachments: { defaultFolder: "attachments\\saved" },
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
      attachments: { defaultFolder: "attachments/saved" },
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
      attachments: { defaultFolder: "attachments/saved" },
      maxUploadBytes: 1024,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "alternate-agent", dir: "/srv/alternate-agent" },
    });
  });

  it("keeps foreign-platform agent paths portable at federation transport boundaries", () => {
    const agent = { command: "C:\\tools\\pi.exe", dir: "C:\\pi-profiles\\work" };
    const response = {
      ...responseFor({ agent }, true),
      effectiveConfig: { agent },
    };

    expect(parsePiWebConfigResponseBody(response).config.agent).toEqual(agent);
    expect(parseSelectedMachineConfigRequest({ agent }, "portable").agent).toEqual(agent);
    if (process.platform !== "win32") {
      expect(() => parseSelectedMachineConfigRequest({ agent })).toThrow("agent.dir must be a host-absolute path");
    }
  });

  it("accepts older peer responses without the sessionMessages override flag but rejects invalid supplied values", () => {
    const response = responseFor({}, false);
    const legacyOverrides = Object.fromEntries(Object.entries(response.envOverrides).filter(([key]) => key !== "sessionMessages"));
    expect(parsePiWebConfigResponseBody({ ...response, envOverrides: legacyOverrides }).envOverrides.sessionMessages).toBe(false);
    for (const sessionMessages of [null, "false", 0]) {
      expect(() => parsePiWebConfigResponseBody({ ...response, envOverrides: { ...legacyOverrides, sessionMessages } })).toThrow("field must be a boolean: sessionMessages");
    }
  });

  it("rejects config responses missing a required override flag", () => {
    for (const flag of ["host", "port", "allowedHosts", "spawnSessions", "subsessions", "askUser"] as const) {
      const envOverrides = Object.fromEntries(Object.entries(responseFor({}, false).envOverrides).filter(([key]) => key !== flag));
      expect(() => parsePiWebConfigResponseBody({ ...responseFor({}, false), envOverrides })).toThrow(`field must be a boolean: ${flag}`);
    }
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
    attachments: { defaultFolder: "attachments" },
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
    attachments: { defaultFolder: "attachments" },
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
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, sessionMessages: false, subsessions: false, askUser: false },
  };
}
