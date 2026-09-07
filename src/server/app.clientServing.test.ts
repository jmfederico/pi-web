import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const tempDirectories: string[] = [];
const STOCK_MANIFEST = JSON.stringify({ name: "PI WEB", short_name: "PI WEB", theme_color: "#0d1117" });

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe("app client serving modes", () => {
  it("serves the built client with an SPA fallback in packaged mode", async () => {
    const clientDist = await createClientDist();
    const app = await buildApp({
      clientServing: { mode: "packaged", clientDist },
      logger: false,
    });

    try {
      const root = await app.inject({ method: "GET", url: "/" });
      const deepLink = await app.inject({ method: "GET", url: "/settings/safe-tunnel" });
      const unknownApi = await app.inject({ method: "GET", url: "/api/not-a-route" });

      expect(root.statusCode).toBe(200);
      expect(root.body).toBe("<html>PI WEB</html>");
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toBe("<html>PI WEB</html>");
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.json()).toEqual({
        message: "Route GET:/api/not-a-route not found",
        error: "Not Found",
        statusCode: 404,
      });
    } finally {
      await app.close();
    }
  });

  it("serves the detected deployment identity from the packaged client root", async () => {
    const clientDist = await createClientDist();
    const app = await buildApp({
      clientServing: { mode: "packaged", clientDist },
      deploymentFlavor: () => Promise.resolve("dev"),
      logger: false,
    });

    try {
      const favicon = await app.inject({ method: "GET", url: "/favicon.svg" });
      const manifest = await app.inject({ method: "GET", url: "/manifest.webmanifest" });

      expect(favicon.statusCode).toBe(200);
      expect(favicon.body).toBe("dev favicon");
      expect(manifest.json()).toMatchObject({
        name: "PI WEB (dev)",
        short_name: "PI WEB (dev)",
        theme_color: "#21132f",
      });
    } finally {
      await app.close();
    }
  });

  it("fails startup in packaged mode when the built client is missing", async () => {
    const clientDist = join(await createTempDirectory(), "dist", "client");

    await expect(buildApp({
      clientServing: { mode: "packaged", clientDist },
      logger: false,
    })).rejects.toThrow(/no built client found.*npm run build/u);
  });

  it("serves no client in development mode and points browsers at the dev server", async () => {
    const app = await buildApp({
      clientServing: { mode: "dev", browserEntrypointUrl: "http://127.0.0.1:8505" },
      logger: false,
    });

    try {
      const root = await app.inject({ method: "GET", url: "/" });
      const deepLink = await app.inject({ method: "GET", url: "/settings" });
      const unknownApi = await app.inject({ method: "GET", url: "/api/not-a-route" });

      expect(root.statusCode).toBe(404);
      expect(root.headers["content-type"]).toContain("text/plain");
      expect(root.body).toContain("http://127.0.0.1:8505");
      expect(root.body).not.toContain("%BASE_URL%");
      expect(deepLink.statusCode).toBe(404);
      expect(deepLink.body).toContain("http://127.0.0.1:8505");
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.json()).toEqual({
        message: "Route GET:/api/not-a-route not found",
        error: "Not Found",
        statusCode: 404,
      });
    } finally {
      await app.close();
    }
  });

  it("keeps the minimal API-only app when client serving is disabled", async () => {
    const app = await buildApp({ clientServing: false, logger: false });

    try {
      const root = await app.inject({ method: "GET", url: "/" });

      expect(root.statusCode).toBe(404);
      expect(root.json()).toEqual({
        message: "Route GET:/ not found",
        error: "Not Found",
        statusCode: 404,
      });
    } finally {
      await app.close();
    }
  });
});

async function createClientDist(): Promise<string> {
  const directory = await createTempDirectory();
  await Promise.all([
    writeFile(join(directory, "index.html"), "<html>PI WEB</html>", "utf8"),
    writeFile(join(directory, "favicon.svg"), "stock favicon", "utf8"),
    writeFile(join(directory, "favicon-dev.svg"), "dev favicon", "utf8"),
    writeFile(join(directory, "manifest.webmanifest"), STOCK_MANIFEST, "utf8"),
  ]);
  return directory;
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-client-serving-"));
  tempDirectories.push(directory);
  return directory;
}
