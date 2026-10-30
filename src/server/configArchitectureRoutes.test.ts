import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFilePiWebConfigService, parsePiWebConfigResponseBody, registerConfigRoutes, registerLocalMachineConfigRoutes } from "./configRoutes.js";
import type { PiWebConfigResponse } from "../shared/apiTypes.js";

let app: FastifyInstance;
let directory: string;
let writable: string;
let defaults: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-web-config-architecture-"));
  writable = join(directory, "config.json");
  defaults = join(directory, "defaults.json");
});

afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

function start(env: NodeJS.ProcessEnv = {}): void {
  app = Fastify({ logger: false });
  const service = createFilePiWebConfigService({ env: { PI_WEB_CONFIG: writable, PI_WEB_DEFAULTS_CONFIG: defaults, ...env } });
  registerConfigRoutes(app, service);
  registerLocalMachineConfigRoutes(app, service);
}

describe("layered config updates", () => {
  it("resets sessionMessages to deployment defaults without persisting effective values", async () => {
    writeFileSync(defaults, JSON.stringify({ sessionMessages: false }));
    writeFileSync(writable, JSON.stringify({ spawnSessions: false, subsessions: false }));
    start();
    const url = "/api/machines/local/config";
    const saved = await app.inject({ method: "PATCH", url, payload: { set: { sessionMessages: true } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PiWebConfigResponse>().effectiveConfig.sessionMessages).toBe(true);
    const reset = await app.inject({ method: "PATCH", url, payload: { unset: ["/sessionMessages"] } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { sessionMessages: false }, configSources: { "/sessionMessages": "defaults" } });
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ spawnSessions: false, subsessions: false });
  });

  it("enforces sessionMessages while preserving the hidden saved choice", async () => {
    writeFileSync(defaults, "{}");
    writeFileSync(writable, JSON.stringify({ sessionMessages: true }));
    start({ PI_WEB_SESSION_MESSAGES: "false" });
    const url = "/api/machines/local/config";
    const read = await app.inject({ method: "GET", url });
    expect(parsePiWebConfigResponseBody(read.json())).toMatchObject({
      config: { sessionMessages: true }, effectiveConfig: { sessionMessages: false },
      envOverrides: { sessionMessages: true }, enforcedSettings: { "/sessionMessages": "PI_WEB_SESSION_MESSAGES" },
      configSources: { "/sessionMessages": "PI_WEB_SESSION_MESSAGES" },
    });
    for (const payload of [{ set: { sessionMessages: false } }, { unset: ["/sessionMessages"] }]) {
      const rejected = await app.inject({ method: "PATCH", url, payload });
      expect(rejected.statusCode).toBe(400);
    }
    const replaced = await app.inject({ method: "PUT", url, payload: { config: { spawnSessions: false } } });
    expect(replaced.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ sessionMessages: true, spawnSessions: false });
  });

  it.each(["/api/config", "/api/machines/local/config"])("protects hidden overrides during legacy PUT through %s", async (url) => {
    writeFileSync(defaults, "{}");
    const saved = { installationName: "Hidden", sessionNaming: { model: "provider/hidden", maxTokens: 64 }, askUser: false, quietMode: true };
    writeFileSync(writable, JSON.stringify(saved));
    start({ PI_WEB_INSTALLATION_NAME: "Enforced", PI_WEB_SESSION_NAMING: '{"model":"provider/enforced"}' });
    const read = await app.inject({ method: "GET", url });
    const roundtrip = await app.inject({ method: "PUT", url, payload: { config: read.json<PiWebConfigResponse>().config } });
    expect(roundtrip.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual(saved);
    for (const config of [{ installationName: "New" }, { sessionNaming: { model: "provider/new" } }]) {
      const rejected = await app.inject({ method: "PUT", url, payload: { config } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<{ error: string }>().error).toContain("enforced by");
      expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual(saved);
    }
    const result = await app.inject({ method: "PUT", url, payload: { config: { sessionNaming: { timeoutMs: 1000 } } } });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({
      ...(url === "/api/config" ? {} : { askUser: false, quietMode: true }),
      installationName: "Hidden", sessionNaming: { model: "provider/hidden", timeoutMs: 1000 },
    });
    expect(result.json<PiWebConfigResponse>().effectiveConfig).toMatchObject({ installationName: "Enforced", sessionNaming: { model: "provider/enforced", timeoutMs: 1000 } });
  });

  it.each(["/api/config", "/api/machines/local/config"])("does not materialize absent enforced saved settings through %s", async (url) => {
    writeFileSync(defaults, "{}");
    writeFileSync(writable, "{}");
    start({ PI_WEB_INSTALLATION_NAME: "Enforced", PI_WEB_SESSION_NAMING: '{"model":"provider/enforced"}' });
    const result = await app.inject({ method: "PUT", url, payload: { config: { sessionNaming: { maxTokens: 32 } } } });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ sessionNaming: { maxTokens: 32 } });
  });

  it("saves and resets in one request without copying defaults or modifying the defaults file", async () => {
    const deployment = { installationName: "Office", quietMode: true, uploads: { defaultFolder: "deployment" } };
    writeFileSync(defaults, JSON.stringify(deployment));
    writeFileSync(writable, JSON.stringify({ installationName: "Personal", extensionDialogsTimeoutMs: 0, environmentFacts: false }));
    start();
    const result = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { quietMode: false }, unset: ["/installationName"] } });
    expect(result.statusCode).toBe(200);
    const response = parsePiWebConfigResponseBody(result.json());
    expect(response.effectiveConfig).toMatchObject({ installationName: "Office", quietMode: false, extensionDialogsTimeoutMs: 0, environmentFacts: false });
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ quietMode: false, extensionDialogsTimeoutMs: 0, environmentFacts: false });
    expect(JSON.parse(readFileSync(defaults, "utf8"))).toEqual(deployment);
    expect(response.defaultsPath).toBe(defaults);
    expect(response.defaultsConfig).toEqual(deployment);
  });

  it("updates namespace leaves independently and resets escaped plugin keys", async () => {
    writeFileSync(defaults, JSON.stringify({ defaultLocalization: { language: "en", timeZone: "UTC" }, plugins: { git: { settings: { options: { one: true } } } } }));
    writeFileSync(writable, JSON.stringify({ plugins: { git: { enabled: false, settings: { "a/b": [1], options: {} } } }, defaultLocalization: { language: "fr" } }));
    start();
    const result = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { defaultLocalization: { hourCycle: "h12" } }, unset: ["/plugins/git/settings/a~1b"] } });
    expect(result.statusCode).toBe(200);
    expect(result.json<PiWebConfigResponse>().effectiveConfig).toMatchObject({ defaultLocalization: { language: "fr", timeZone: "UTC", hourCycle: "h12" }, plugins: { git: { enabled: false, settings: { options: {} } } } });
    expect(result.json<PiWebConfigResponse>().config.plugins?.["git"]?.settings).not.toHaveProperty("a/b");
  });

  it("rejects policy writes but preserves hidden values on unrelated saves", async () => {
    writeFileSync(defaults, "{}");
    writeFileSync(writable, JSON.stringify({ installationName: "Personal" }));
    start({ PI_WEB_INSTALLATION_NAME: "Enforced" });
    const rejected = await app.inject({ method: "PATCH", url: "/api/config", payload: { unset: ["/installationName"] } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toContain("PI_WEB_INSTALLATION_NAME");
    const result = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { quietMode: true } } });
    expect(result.statusCode).toBe(200);
    expect(result.json<PiWebConfigResponse>().config.installationName).toBe("Personal");
    expect(result.json<PiWebConfigResponse>().effectiveConfig.installationName).toBe("Enforced");
    expect(result.json<PiWebConfigResponse>().enforcedSettings).toMatchObject({ "/installationName": "PI_WEB_INSTALLATION_NAME" });
  });

  it.each([
    { set: { quietMode: false }, unset: ["/quietMode"] },
    { set: { quietMode: true }, unset: ["/unknown"] },
    { set: { quietMode: "false" } },
    { set: { typo: true } },
    { unset: null },
    { unset: ["/sessionNaming/unknown"] },
  ])("rejects an invalid complete update before writing: %j", async (payload) => {
    writeFileSync(defaults, "{}");
    writeFileSync(writable, "{}");
    start();
    const result = await app.inject({ method: "PATCH", url: "/api/config", payload });
    expect(result.statusCode).toBe(400);
    expect(readFileSync(writable, "utf8")).toBe("{}");
  });

  it("saves and resets independent naming fields without touching enforced siblings", async () => {
    writeFileSync(defaults, JSON.stringify({ sessionNaming: { model: "provider/deployed", maxTokens: 24, timeoutMs: 12000 } }));
    writeFileSync(writable, JSON.stringify({ sessionNaming: { model: "provider/hidden", maxTokens: 64 } }));
    start({ PI_WEB_SESSION_NAMING: '{"model":"provider/enforced"}' });
    const saved = await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { set: { sessionNaming: { maxTokens: 32 } } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PiWebConfigResponse>().effectiveConfig.sessionNaming).toEqual({ model: "provider/enforced", maxTokens: 32, timeoutMs: 12000 });
    expect(saved.json<PiWebConfigResponse>().config.sessionNaming).toEqual({ model: "provider/hidden", maxTokens: 32 });
    expect(saved.json<PiWebConfigResponse>().enforcedSettings).toEqual({ "/sessionNaming/model": "PI_WEB_SESSION_NAMING" });
    const reset = await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { unset: ["/sessionNaming/maxTokens"] } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<PiWebConfigResponse>().effectiveConfig.sessionNaming).toEqual({ model: "provider/enforced", maxTokens: 24, timeoutMs: 12000 });
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ sessionNaming: { model: "provider/hidden" } });
    const rejected = await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { unset: ["/sessionNaming"] } });
    expect(rejected.statusCode).toBe(400);
  });

  it("inherits through empty folder containers and resets a leaf to deployment defaults", async () => {
    writeFileSync(defaults, JSON.stringify({ uploads: { defaultFolder: "deployment" }, attachments: { defaultFolder: "deployed-attachments" } }));
    writeFileSync(writable, JSON.stringify({ uploads: {}, attachments: {} }));
    start({ PI_WEB_UPLOADS: "{}" });
    const initial = await app.inject({ method: "GET", url: "/api/config" });
    expect(initial.json<PiWebConfigResponse>().effectiveConfig.uploads).toEqual({ defaultFolder: "deployment" });
    expect(initial.json<PiWebConfigResponse>().enforcedSettings).toEqual({});
    const saved = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { uploads: { defaultFolder: "personal" } } } });
    expect(saved.statusCode).toBe(200);
    const reset = await app.inject({ method: "PATCH", url: "/api/config", payload: { unset: ["/uploads/defaultFolder"] } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<PiWebConfigResponse>().effectiveConfig.uploads).toEqual({ defaultFolder: "deployment" });
    expect(reset.json<PiWebConfigResponse>().config).not.toHaveProperty("uploads");
  });

  it("retains selected-machine isolation and supports machine override removal", async () => {
    writeFileSync(defaults, JSON.stringify({ installationName: "Office", defaultTheme: { themeId: "themes:pi-web-dark", auto: false } }));
    writeFileSync(writable, JSON.stringify({ host: "localhost", installationName: "Personal" }));
    start({ PI_WEB_HOST: "127.0.0.1" });
    const rejected = await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { unset: ["/host"] } });
    expect(rejected.statusCode).toBe(400);
    const result = await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { unset: ["/installationName"] } });
    expect(result.statusCode).toBe(200);
    const response = result.json<PiWebConfigResponse>();
    expect(response.effectiveConfig.installationName).toBe("Office");
    expect(response.defaultsConfig).not.toHaveProperty("defaultTheme");
    expect(response.enforcedSettings).not.toHaveProperty("/host");
    expect(JSON.parse(readFileSync(writable, "utf8"))).toEqual({ host: "localhost" });
  });
});
