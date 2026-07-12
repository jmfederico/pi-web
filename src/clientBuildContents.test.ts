import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "pi-web-client-build-"));
    try {
      await build({
        configFile: join(repoRoot, "vite.config.ts"),
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });

      const html = await readFile(join(outDir, "index.html"), "utf8");
      const references = htmlAssetReferences(html);
      expect(references).toContain("./favicon.svg");
      expect(references).toContain("./apple-touch-icon.png");
      expect(references).toContain("./manifest.webmanifest");
      expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
      expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

      const manifest: unknown = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
      expect(manifest).toMatchObject({
        start_url: "./",
        scope: "./",
        icons: [
          { src: "./pwa-icon-192.png" },
          { src: "./pwa-icon-512.png" },
        ],
      });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

function htmlAssetReferences(html: string): string[] {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
