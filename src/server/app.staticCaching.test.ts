import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createFilePiWebConfigService } from "./configRoutes.js";

let clientDist: string;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), "pi-web-static-cache-"));
  await mkdir(join(clientDist, "assets"));
  await writeFile(join(clientDist, "index.html"), "<pi-web-app></pi-web-app>");
  await writeFile(join(clientDist, "assets", "index-Abc123_x.js"), "export {};");
  await writeFile(join(clientDist, "robots.txt"), "User-agent: *\nDisallow: /\n");
});

afterEach(async () => {
  await rm(clientDist, { recursive: true, force: true });
});

describe("client static caching", () => {
  it("guards actual static files and the SPA fallback with the effective startup host policy", async () => {
    const app = await buildApp({
      clientDist, logger: false,
      config: createFilePiWebConfigService({ env: { PI_WEB_CONFIG: join(clientDist, "absent-config.json"), PI_WEB_HOST_ACCESS: JSON.stringify({ mode: "restricted", hosts: ["public.example.test"] }) } }),
    });
    try {
      for (const url of ["/", "/assets/index-Abc123_x.js", "/robots.txt", "/sessions/example"]) {
        const accepted = await app.inject({ url, headers: { host: "public.example.test" } });
        expect(accepted.statusCode).toBe(200);
        const rejected = await app.inject({ url, headers: { host: "evil.example" } });
        expect(rejected.statusCode).toBe(403);
        expect(rejected.headers["content-type"]).toContain("application/json");
      }
    } finally {
      await app.close();
    }
  });

  it("marks content-hashed assets immutable", async () => {
    const app = await buildApp({ clientDist, logger: false });
    try {
      const asset = await app.inject({ method: "GET", url: "/assets/index-Abc123_x.js" });

      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe("export {};");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    } finally {
      await app.close();
    }
  });

  it.each(["/", "/sessions/example", "/assets/missing-old-hash.js"])("keeps the app shell revalidating at %s", async (url) => {
    const app = await buildApp({ clientDist, logger: false });
    try {
      const shell = await app.inject({ method: "GET", url });

      expect(shell.statusCode).toBe(200);
      expect(shell.headers["content-type"]).toContain("text/html");
      expect(shell.body).toBe("<pi-web-app></pi-web-app>");
      expect(shell.headers["cache-control"]).toBe("private, no-cache");
    } finally {
      await app.close();
    }
  });

  it("delivers HTML when theme discovery fails and the dev bootstrap endpoint returns no content", async () => {
    const source = '<script id="pi-web-theme-data" type="application/json"></script><pi-web-app></pi-web-app>';
    await writeFile(join(clientDist, "index.html"), source);
    const app = await buildApp({ clientDist, logger: false, themeCatalog: {
      themes: () => Promise.reject(new Error("unavailable")), readAsset: () => Promise.resolve(undefined),
    } });
    try {
      const shell = await app.inject("/");
      expect(shell.statusCode).toBe(200);
      expect(shell.body).toBe(source);
      expect((await app.inject("/api/theme-bootstrap")).statusCode).toBe(204);
    } finally { await app.close(); }
  });

  it.each(["stable", "dev"] as const)("delivers the %s deployment identity with the initial shell", async (flavor) => {
    await writeFile(join(clientDist, "index.html"), "<html><body><pi-web-app></pi-web-app></body></html>");
    const app = await buildApp({ clientDist, logger: false, deploymentFlavor: () => Promise.resolve(flavor) });
    try {
      for (const url of ["/", "/index.html", "/sessions/example"]) {
        const shell = await app.inject(url);
        expect(shell.statusCode).toBe(200);
        expect(shell.body.includes('data-pi-web-deployment="dev"')).toBe(flavor === "dev");
      }
    } finally { await app.close(); }
  });

  it("keeps unhashed static files revalidating", async () => {
    const app = await buildApp({ clientDist, logger: false });
    try {
      const file = await app.inject({ method: "GET", url: "/robots.txt" });

      expect(file.statusCode).toBe(200);
      expect(file.body).toBe("User-agent: *\nDisallow: /\n");
      expect(file.headers["cache-control"]).toBe("public, max-age=0");
    } finally {
      await app.close();
    }
  });
});
