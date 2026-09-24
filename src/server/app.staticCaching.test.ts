import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let clientDist: string;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), "pi-web-static-cache-"));
  await mkdir(join(clientDist, "assets"));
  await writeFile(join(clientDist, "index.html"), "<pi-web-app></pi-web-app>");
  await writeFile(join(clientDist, "assets", "index-Abc123_x.js"), "export {};");
});

afterEach(async () => {
  await rm(clientDist, { recursive: true, force: true });
});

describe("client static caching", () => {
  it("marks content-hashed assets immutable while keeping the app shell revalidating", async () => {
    const app = await buildApp({ clientDist, logger: false });
    try {
      const asset = await app.inject({ method: "GET", url: "/assets/index-Abc123_x.js" });
      const shell = await app.inject({ method: "GET", url: "/" });
      const deepLink = await app.inject({ method: "GET", url: "/?session=s1" });

      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(shell.statusCode).toBe(200);
      expect(shell.headers["cache-control"]).not.toContain("immutable");
      expect(deepLink.headers["cache-control"]).not.toContain("immutable");
    } finally {
      await app.close();
    }
  });
});
