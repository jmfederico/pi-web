import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("ships built-in palettes in the static theme package rather than the browser module graph", async () => {
    const packageDir = join(repoRoot, "dist/pi-web-plugins/themes");
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    const plugin = manifest.piWeb.plugins[0];
    expect(plugin.id).toBe("themes");
    expect(plugin.module).toBeUndefined();
    expect(plugin.serverModule).toBeUndefined();
    for (const id of ["classic", "pi-web-dark", "pi-web-light", "paper", "graphite"]) {
      const theme = plugin.themes.find((theme) => theme.id === id);
      expect(theme.stylesheets).toEqual([
        { id: "palette", path: `${id}.css` },
      ]);
      expect(await readFile(join(packageDir, plugin.browserRoot, theme.stylesheets[0].path), "utf8")).toContain("--pi-bg:");
      for (const sheet of theme.stylesheets) {
        expect((await readFile(join(packageDir, plugin.browserRoot, sheet.path), "utf8")).trim()).not.toBe("");
      }
    }
    const assets = await readdir(join(repoRoot, "dist/client/assets"));
    expect(assets.filter((file) => /^(classic|pi-web-dark|pi-web-light|paper|graphite|playground(?:-dark|-light)?)-.*\.css$/.test(file))).toEqual([]);
  });

  it("excludes the checkout-only Playground plugin and assets from release output", async () => {
    const files = await readdir(join(repoRoot, "dist"), { recursive: true });
    expect(files.filter((file) => /playground/i.test(file))).toEqual([]);
  });

  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = join(repoRoot, "dist/client");
    const html = await readFile(join(outDir, "index.html"), "utf8");
    // The backend fills this non-executable slot after the client build.
    const bootstrapSlot = /<script\b[^>]*\bid="pi-web-theme-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(bootstrapSlot?.[0]).toContain('type="application/json"');
    expect(bootstrapSlot?.[1]?.trim()).toBe("");
    const references = htmlAssetReferences(html);
    expect(references).toContain("./favicon.svg");
    expect(references).toContain("./apple-touch-icon.png");
    expect(references).toContain("./manifest.webmanifest");
    const manifestLink = /<link\b[^>]*\brel="manifest"[^>]*>/.exec(html)?.[0];
    expect(manifestLink).toBeDefined();
    expect(manifestLink).toContain('crossorigin="use-credentials"');
    expect(references).toContainEqual(expect.stringMatching(/^\.\/assets\/index-[^/]+\.js$/));
    expect(references.filter((reference) => reference.startsWith("/"))).toEqual([]);

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({
      start_url: "./",
      scope: "./",
      icons: [
        { src: "./pwa-icon-192.png" },
        { src: "./pwa-icon-512.png" },
      ],
    });
  });
});

function htmlAssetReferences(html) {
  return Array.from(html.matchAll(/\b(?:href|src)="([^"]+)"/g), (match) => match[1] ?? "");
}
