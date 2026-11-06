import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiWebConfigResponse } from "../shared/apiTypes.js";
import { buildApp } from "./app.js";
import { createFilePiWebConfigService } from "./configRoutes.js";

let directory: string;
let configPath: string;
const apps = new Set<FastifyInstance>();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-web-host-choice-"));
  configPath = join(directory, "config.json");
});
afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
  await rm(directory, { recursive: true, force: true });
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    logger: false, clientDist: false,
    config: createFilePiWebConfigService({ env: { PI_WEB_CONFIG: configPath, ...env } }),
  });
  apps.add(app);
  return app;
}

async function restart(app: FastifyInstance): Promise<FastifyInstance> {
  await app.close();
  apps.delete(app);
  return start();
}

describe("gateway Host validation choice", () => {
  it.each([undefined, [], ["old.dev.test"], true])("keeps fresh/legacy installs accessible with allowedHosts %j", async (allowedHosts) => {
    if (allowedHosts !== undefined) await writeFile(configPath, JSON.stringify({ allowedHosts }));
    const app = await start();
    const response = await app.inject({ url: "/api/config", headers: { host: "existing.public.test" } });
    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { hostValidation: "pending" }, activeHostValidation: "pending" });
    const foreign = await app.inject({ method: "POST", url: "/api/pi-web/health", headers: { host: "existing.public.test", origin: "https://foreign.test" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("reports saved versus active choices through enable, disable and reset", async () => {
    await writeFile(configPath, JSON.stringify({ allowedHosts: ["known.test"] }));
    let app = await start();
    const unknown = { host: "existing.public.test" };
    const known = { host: "known.test" };
    const enabled = await app.inject({ method: "PATCH", url: "/api/config", headers: unknown, payload: { set: { hostValidation: "enabled" } } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<PiWebConfigResponse>()).toMatchObject({ config: { hostValidation: "enabled" }, effectiveConfig: { hostValidation: "enabled" }, activeHostValidation: "pending" });
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(200);

    app = await restart(app);
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(403);
    const running = await app.inject({ url: "/api/config", headers: known });
    expect(running.json<PiWebConfigResponse>().activeHostValidation).toBe("enabled");
    const disabled = await app.inject({ method: "PATCH", url: "/api/config", headers: known, payload: { set: { hostValidation: "disabled" } } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { hostValidation: "disabled" }, activeHostValidation: "enabled" });
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(403);

    app = await restart(app);
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(200);
    const decided = await app.inject({ url: "/api/config", headers: unknown });
    expect(decided.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { hostValidation: "disabled" }, activeHostValidation: "disabled" });
    const reset = await app.inject({ method: "PATCH", url: "/api/config", headers: unknown, payload: { unset: ["/hostValidation"] } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<PiWebConfigResponse>().config).not.toHaveProperty("hostValidation");
    expect(reset.json<PiWebConfigResponse>().effectiveConfig.hostValidation).toBe("pending");
    app = await restart(app);
    expect((await app.inject({ url: "/api/config", headers: unknown })).json<PiWebConfigResponse>().activeHostValidation).toBe("pending");
  });

  it("rejects contradictory or invalid choices without writing, and accepts an atomic enable plus list", async () => {
    const original = JSON.stringify({ allowedHosts: true });
    await writeFile(configPath, original);
    const app = await start();
    for (const hostValidation of ["enabled", "unknown", null, false]) {
      const response = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostValidation } } });
      expect(response.statusCode).toBe(400);
      expect(await readFile(configPath, "utf8")).toBe(original);
    }
    const response = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostValidation: "enabled", allowedHosts: ["public.test"] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>()).toMatchObject({ config: { hostValidation: "enabled", allowedHosts: ["public.test"] }, activeHostValidation: "pending" });
  });

  it("keeps gateway policy out of selected-machine config and honors environment enforcement", async () => {
    const app = await start({ PI_WEB_HOST_VALIDATION: "disabled" });
    const gateway = (await app.inject("/api/config")).json<PiWebConfigResponse>();
    expect(gateway).toMatchObject({ effectiveConfig: { hostValidation: "disabled" }, activeHostValidation: "disabled", enforcedSettings: { "/hostValidation": "PI_WEB_HOST_VALIDATION" } });
    expect((await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostValidation: "enabled" } } })).statusCode).toBe(400);
    const machine = (await app.inject("/api/machines/local/config")).json<PiWebConfigResponse>();
    expect(machine.effectiveConfig).not.toHaveProperty("hostValidation");
    expect(machine).not.toHaveProperty("activeHostValidation");
    expect((await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { set: { hostValidation: "disabled" } } })).statusCode).toBe(400);
  });
});
