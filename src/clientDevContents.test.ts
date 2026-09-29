import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("manual-refresh development client", () => {
  it("serves Vite helpers without starting the disabled live-reload transport", async () => {
    const server = await createServer({
      configFile: join(repoRoot, "vite.config.ts"),
      logLevel: "silent",
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const source = await readFile(join(repoRoot, "src/client/index.html"), "utf8");
      const html = await server.transformIndexHtml("/", source);
      // A pending Vite handshake serializes Chromium's subsequent application
      // WebSocket handshakes, leaving status badges stale despite working HTTP.
      expect(server.config.server.hmr).toBe(false);
      expect(server.config.server.ws).toBe(false);
      expect(html).toContain('src="/src/main.ts"');
      // The plugin loader's variable import needs Vite's injectQuery helper,
      // so removing only the HTML script still imports and starts the client.
      const loader = await server.transformRequest("/src/plugins/external.ts");
      expect(loader?.code).toContain("/@vite/client");
      const client = await server.transformRequest("/@vite/client");
      expect(client?.code).toContain("injectQuery");
      expect(client?.code).toContain("/* PI WEB uses manual browser refresh. */");
      expect(client?.code).not.toContain("transport.connect(createHMRHandler(handleMessage))");
    } finally {
      await server.close();
    }
  });
});
