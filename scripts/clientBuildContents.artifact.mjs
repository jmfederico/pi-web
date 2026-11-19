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

  it("links host imports to installed browser modules under the deployment prefix", async () => {
    const assets = join(repoRoot, "dist/client/assets");
    const prefix = "https://example.test/nested/pi/";
    const parserImports = new Set();
    for (const chunk of (await readdir(assets)).filter((file) => file.endsWith(".js"))) {
      const source = await readFile(join(assets, chunk), "utf8");
      for (const [, path] of source.matchAll(/\bfrom\s*["']([^"']*pi-web-dependencies\/[^"']+)["']/g)) {
        parserImports.add(new URL(path, `${prefix}assets/${chunk}`).href);
      }
    }
    const dependencies = `${prefix}pi-web-dependencies/`;
    const icu = `${dependencies}icu/`;
    expect(parserImports).toEqual(new Set([`${dependencies}marked.esm.js`, `${dependencies}csstree.esm.js`,
      `${icu}intl-messageformat.js`, `${icu}@formatjs/icu-messageformat-parser.js`]));

    // Native ESM resolution in installed ICU files can't use npm's resolver. Keep
    // their bare imports scoped so portable plugin modules don't inherit aliases.
    const html = await readFile(join(assets, "../index.html"), "utf8");
    const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)[1]);
    expect(map.imports).toBeUndefined();
    const [[scope, mappings]] = Object.entries(map.scopes);
    expect(new URL(scope, prefix).href).toBe(icu);
    for (const id of ["@formatjs/fast-memoize", "@formatjs/icu-messageformat-parser", "@formatjs/icu-skeleton-parser"]) {
      expect(new URL(mappings[id], prefix).href).toBe(`${icu}${id}.js`);
    }
  });

  it("serves installed Material SVGs instead of packing Vite copies", async () => {
    const client = join(repoRoot, "dist/client");
    const icons = new URL(".", import.meta.resolve("material-icon-theme/icons/file.svg"));
    const svgFiles = (await readdir(icons)).filter((file) => /^[\w-]+(?:\.clone)?\.svg$/u.test(file));
    // This entire installed SVG directory, not only files selected by the default
    // matcher set, is now the release's allowlisted image source.
    for (const file of svgFiles) {
      const svg = await readFile(new URL(file, icons), "utf8");
      expect(svg, file).not.toMatch(/<script\b|<foreignObject\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!#)/iu);
    }
    const names = new Set(svgFiles.map((file) => file.replace(/(?:\.clone)?\.svg$/, "")));
    const assets = await readdir(join(client, "assets"));
    expect(assets.filter((file) => file.endsWith(".svg") && names.has(file.replace(/-[^/]{8}\.svg$/, "")))).toEqual([]);
    const licenses = await readdir(join(client, "licenses/material-icon-theme"));
    expect(licenses).toEqual(expect.arrayContaining(["NOTICE.txt", "LICENSE-APACHE-2.0.txt", "LICENSE-MIT.txt"]));
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
