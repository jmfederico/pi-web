import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiPackageInfo } from "../shared/apiTypes.js";
import { ActiveAgentProfileAccessError } from "./activeAgentProfileProvider.js";
import type { PiPackageService } from "./piPackageService.js";
import { registerPiPackageRoutes } from "./piPackageRoutes.js";

let app: FastifyInstance;
let service: PiPackageService;
let serviceMocks: ReturnType<typeof fakePiPackageService>;

beforeEach(async () => {
  serviceMocks = fakePiPackageService();
  service = serviceMocks.service;
  app = Fastify({ logger: false });
  registerPiPackageRoutes(app, service);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("registerPiPackageRoutes", () => {
  it("lists configured Pi packages", async () => {
    const response = await app.inject({ method: "GET", url: "/api/pi-packages" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" }] });
    expect(serviceMocks.list).toHaveBeenCalledOnce();
  });

  it("registers package routes under a custom API prefix", async () => {
    const prefixedApp = Fastify({ logger: false });
    const prefixedMocks = fakePiPackageService();
    registerPiPackageRoutes(prefixedApp, prefixedMocks.service, "/api/machines/local");
    await prefixedApp.ready();

    try {
      const response = await prefixedApp.inject({ method: "GET", url: "/api/machines/local/pi-packages" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ packages: [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" }] });
      expect(prefixedMocks.list).toHaveBeenCalledOnce();
    } finally {
      await prefixedApp.close();
    }
  });

  it("installs a trimmed Pi package source without accepting a scope", async () => {
    const response = await app.inject({ method: "POST", url: "/api/pi-packages/install", payload: { source: "  npm:@acme/new-tools  " } });
    const scopedResponse = await app.inject({ method: "POST", url: "/api/pi-packages/install", payload: { source: "npm:@acme/new-tools", scope: "project" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: "install", source: "npm:@acme/new-tools" });
    expect(scopedResponse.statusCode).toBe(400);
    expect(scopedResponse.json()).toEqual({ error: "Pi package install scope is not supported; installs use Pi's default package location" });
    expect(serviceMocks.install).toHaveBeenCalledOnce();
    expect(serviceMocks.install).toHaveBeenCalledWith("npm:@acme/new-tools");
  });

  it("removes from an explicitly listed package scope", async () => {
    const response = await app.inject({ method: "POST", url: "/api/pi-packages/remove", payload: { source: "../project-tools", scope: "project" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: "remove", source: "../project-tools", scope: "project", removed: true });
    expect(serviceMocks.remove).toHaveBeenCalledWith("../project-tools", "project");
  });

  it("updates all packages when source is omitted and one package when source is provided", async () => {
    const allResponse = await app.inject({ method: "POST", url: "/api/pi-packages/update" });
    const oneResponse = await app.inject({ method: "POST", url: "/api/pi-packages/update", payload: { source: " npm:@acme/tools " } });

    expect(allResponse.statusCode).toBe(200);
    expect(oneResponse.statusCode).toBe(200);
    expect(serviceMocks.update).toHaveBeenNthCalledWith(1);
    expect(serviceMocks.update).toHaveBeenNthCalledWith(2, "npm:@acme/tools");
  });

  it("returns stable 400 errors for invalid requests before calling the service", async () => {
    const missingSource = await app.inject({ method: "POST", url: "/api/pi-packages/install", payload: {} });
    const blankSource = await app.inject({ method: "POST", url: "/api/pi-packages/remove", payload: { source: "  " } });
    const invalidScope = await app.inject({ method: "POST", url: "/api/pi-packages/remove", payload: { source: "npm:@acme/tools", scope: "temporary" } });
    const invalidUpdate = await app.inject({ method: "POST", url: "/api/pi-packages/update", payload: { source: "" } });

    expect(missingSource.statusCode).toBe(400);
    expect(missingSource.json()).toEqual({ error: "Pi package source must be a non-empty string" });
    expect(blankSource.statusCode).toBe(400);
    expect(blankSource.json()).toEqual({ error: "Pi package source must be a non-empty string" });
    expect(invalidScope.statusCode).toBe(400);
    expect(invalidScope.json()).toEqual({ error: "Pi package scope must be \"user\" or \"project\"" });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(invalidUpdate.json()).toEqual({ error: "Pi package source must be a non-empty string" });
    expect(serviceMocks.install).not.toHaveBeenCalled();
    expect(serviceMocks.remove).not.toHaveBeenCalled();
    expect(serviceMocks.update).not.toHaveBeenCalled();
  });

  it("returns 503 when the daemon-owned active profile is unavailable", async () => {
    serviceMocks.list.mockRejectedValueOnce(new ActiveAgentProfileAccessError({ status: "unavailable", error: "connect ECONNREFUSED" }));

    const response = await app.inject({ method: "GET", url: "/api/pi-packages" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Active agent profile is unavailable: connect ECONNREFUSED" });
  });

  it("returns stable 500 errors for package-manager failures", async () => {
    serviceMocks.install.mockRejectedValueOnce(new Error("install failed"));

    const response = await app.inject({ method: "POST", url: "/api/pi-packages/install", payload: { source: "npm:@acme/fails" } });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "install failed" });
  });
});

function fakePiPackageService() {
  const packages: PiPackageInfo[] = [{ source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" }];
  const list = vi.fn<PiPackageService["list"]>(() => Promise.resolve({ packages: [...packages] }));
  const install = vi.fn<PiPackageService["install"]>((source) => Promise.resolve({ action: "install", source, packages: [...packages] }));
  const remove = vi.fn<PiPackageService["remove"]>((source, scope = "user") => Promise.resolve({ action: "remove", source, scope, removed: true, packages: [...packages] }));
  const update = vi.fn<PiPackageService["update"]>((source) => Promise.resolve({ action: "update", ...(source === undefined ? {} : { source }), packages: [...packages] }));
  const service: PiPackageService = { list, install, remove, update };
  return { service, list, install, remove, update };
}
