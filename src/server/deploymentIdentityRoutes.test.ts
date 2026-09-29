import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { PiWebDeploymentFlavor } from "./deploymentIdentity.js";
import { registerDeploymentIdentityAssetRoutes } from "./deploymentIdentityRoutes.js";

const STOCK_MANIFEST = JSON.stringify({
  name: "PI WEB",
  short_name: "PI WEB",
  theme_color: "#0d1117",
  icons: [{ src: "./pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" }],
});

let clientDist: string;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), "pi-web-identity-"));
  await writeFile(join(clientDist, "favicon.svg"), "stock favicon");
  await writeFile(join(clientDist, "favicon-dev.svg"), "dev favicon");
  await writeFile(join(clientDist, "pwa-icon-192.png"), "stock icon");
  await writeFile(join(clientDist, "pwa-icon-dev-192.png"), "dev icon");
  await writeFile(join(clientDist, "manifest.webmanifest"), STOCK_MANIFEST);
});

afterEach(async () => {
  await rm(clientDist, { recursive: true, force: true });
});

describe("deployment identity asset routes", () => {
  it("serves the dev favicon in place of the stock one on dev deployments", async () => {
    const app = await buildIdentityApp("dev");

    const response = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("dev favicon");
    expect(response.headers["content-type"]).toContain("image/svg+xml");
  });

  it("serves the dev PWA icon at the stock URL", async () => {
    const app = await buildIdentityApp("dev");

    const response = await app.inject({ method: "GET", url: "/pwa-icon-192.png" });
    expect(response.body).toBe("dev icon");
  });

  it("renames the PWA manifest on dev deployments", async () => {
    const app = await buildIdentityApp("dev");

    const response = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/manifest+json");
    expect(response.json()).toEqual({
      name: "PI WEB (dev)",
      short_name: "PI WEB (dev)",
      theme_color: "#21132f",
      icons: [{ src: "./pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" }],
    });
  });

  it("serves the stock assets unchanged on stable deployments", async () => {
    const app = await buildIdentityApp("stable");

    const favicon = await app.inject({ method: "GET", url: "/favicon.svg" });
    expect(favicon.body).toBe("stock favicon");
    const icon = await app.inject({ method: "GET", url: "/pwa-icon-192.png" });
    expect(icon.body).toBe("stock icon");
    const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(manifest.body).toBe(STOCK_MANIFEST);
  });

  it("leaves other static files to the static plugin", async () => {
    const app = await buildIdentityApp("dev");

    const response = await app.inject({ method: "GET", url: "/index.html" });
    expect(response.statusCode).toBe(404);
  });
});

async function buildIdentityApp(flavor: PiWebDeploymentFlavor): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: clientDist });
  registerDeploymentIdentityAssetRoutes(app, { clientDist, flavor: () => Promise.resolve(flavor) });
  await app.ready();
  return app;
}
