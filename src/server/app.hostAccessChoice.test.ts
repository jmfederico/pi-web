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

const restricted = { mode: "restricted" as const, hosts: ["known.test"] };
const any = { mode: "any" as const };

describe("gateway Host access choice", () => {
  it.each([undefined, [], ["old.dev.test"], true].map((allowedHosts) => ({ allowedHosts })))("keeps fresh/legacy installs accessible with allowedHosts $allowedHosts", async ({ allowedHosts }) => {
    const original = JSON.stringify({ allowedHosts });
    if (allowedHosts !== undefined) await writeFile(configPath, original);
    const app = await start();
    const response = await app.inject({ url: "/api/config", headers: { host: "existing.public.test" } });
    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>().activeHostAccess).toBeNull();
    expect(response.json<PiWebConfigResponse>().effectiveConfig).not.toHaveProperty("hostAccess");
    if (allowedHosts === undefined) await expect(readFile(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(configPath, "utf8")).toBe(original);
    const foreign = await app.inject({ method: "POST", url: "/api/pi-web/health", headers: { host: "existing.public.test", origin: "https://foreign.test" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("reports saved versus active choices through restriction, host-list changes, any and reset", async () => {
    await writeFile(configPath, JSON.stringify({ allowedHosts: true }));
    let app = await start();
    const unknown = { host: "existing.public.test" };
    const known = { host: "known.test" };
    const enabled = await app.inject({ method: "PATCH", url: "/api/config", headers: unknown, payload: { set: { hostAccess: restricted } } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<PiWebConfigResponse>()).toMatchObject({ config: { hostAccess: restricted }, effectiveConfig: { hostAccess: restricted }, activeHostAccess: null });
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(200);

    app = await restart(app);
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(403);
    const changed = { mode: "restricted", hosts: ["replacement.test"] };
    const saved = await app.inject({ method: "PATCH", url: "/api/config", headers: known, payload: { set: { hostAccess: changed } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { hostAccess: changed }, activeHostAccess: restricted });
    expect((await app.inject({ url: "/api/pi-web/health", headers: { host: "replacement.test" } })).statusCode).toBe(403);
    app = await restart(app);
    expect((await app.inject({ url: "/api/pi-web/health", headers: known })).statusCode).toBe(403);
    const disabled = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostAccess: any } } });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<PiWebConfigResponse>()).toMatchObject({ effectiveConfig: { hostAccess: any }, activeHostAccess: changed });
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(403);

    app = await restart(app);
    expect((await app.inject({ url: "/api/pi-web/health", headers: unknown })).statusCode).toBe(200);
    const reset = await app.inject({ method: "PATCH", url: "/api/config", headers: unknown, payload: { unset: ["/hostAccess"] } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<PiWebConfigResponse>().config).not.toHaveProperty("hostAccess");
    expect(reset.json<PiWebConfigResponse>().effectiveConfig).not.toHaveProperty("hostAccess");
    expect(reset.json<PiWebConfigResponse>().activeHostAccess).toEqual(any);
    app = await restart(app);
    expect((await app.inject({ url: "/api/config", headers: unknown })).json<PiWebConfigResponse>().activeHostAccess).toBeNull();
  });

  it("rejects invalid choices and partial object updates without writing", async () => {
    const original = JSON.stringify({ allowedHosts: true });
    await writeFile(configPath, original);
    const app = await start();
    for (const hostAccess of [{ mode: "restricted" }, null, { mode: "any", hosts: [] }]) {
      const response = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostAccess } } });
      expect(response.statusCode).toBe(400);
      expect(await readFile(configPath, "utf8")).toBe(original);
    }
  });

  it("keeps gateway policy out of selected-machine config and locks the entire environment policy", async () => {
    await writeFile(configPath, JSON.stringify({ hostAccess: restricted }));
    const app = await start({ PI_WEB_HOST_ACCESS: JSON.stringify(any) });
    const gateway = (await app.inject("/api/config")).json<PiWebConfigResponse>();
    expect(gateway).toMatchObject({ config: { hostAccess: restricted }, effectiveConfig: { hostAccess: any }, activeHostAccess: any, enforcedSettings: { "/hostAccess": "PI_WEB_HOST_ACCESS" } });
    for (const payload of [{ set: { hostAccess: restricted } }, { unset: ["/hostAccess"] }]) {
      expect((await app.inject({ method: "PATCH", url: "/api/config", payload })).statusCode).toBe(400);
    }
    const replaced = await app.inject({ method: "PUT", url: "/api/config", payload: { config: {} } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<PiWebConfigResponse>().config.hostAccess).toEqual(restricted);
    const machine = (await app.inject("/api/machines/local/config")).json<PiWebConfigResponse>();
    expect(machine.effectiveConfig).not.toHaveProperty("hostAccess");
    expect(machine).not.toHaveProperty("activeHostAccess");
    expect((await app.inject({ method: "PATCH", url: "/api/machines/local/config", payload: { set: { hostAccess: any } } })).statusCode).toBe(400);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ hostAccess: restricted });
  });

  it("does not let legacy environment enforcement lock the new decision", async () => {
    const app = await start({ PI_WEB_ALLOWED_HOSTS: "true" });
    const response = await app.inject({ method: "PATCH", url: "/api/config", payload: { set: { hostAccess: restricted } } });
    expect(response.statusCode).toBe(200);
    expect(response.json<PiWebConfigResponse>().effectiveConfig.hostAccess).toEqual(restricted);
    expect((await app.inject({ method: "PATCH", url: "/api/config", payload: { unset: ["/hostAccess"] } })).statusCode).toBe(200);
  });
});
