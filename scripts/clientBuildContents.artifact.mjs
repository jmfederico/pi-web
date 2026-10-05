import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production client build contents", () => {
  it("ships the Heroicons MIT license with the client", async () => {
    const license = await readFile(join(repoRoot, "dist/client/licenses/Heroicons.txt"), "utf8");
    expect(license).toBe(await readFile(join(repoRoot, "src/client/public/licenses/Heroicons.txt"), "utf8"));
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) Tailwind Labs, Inc.");
  });

  it("ships both unmodified Inter faces, wired local CSS/preload and the font license", async () => {
    const outDir = join(repoRoot, "dist/client");
    const references = htmlAssetReferences(await readFile(join(outDir, "index.html"), "utf8"));
    const stylesheets = references.filter((reference) => reference.endsWith(".css"));
    expect(stylesheets.length).toBeGreaterThan(0);
    const css = (await Promise.all(stylesheets.map((reference) => readFile(join(outDir, reference), "utf8")))).join("\n");
    const faces = (await readdir(join(outDir, "assets"))).filter((name) => name.endsWith(".woff2"));
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const built = new Map(await Promise.all(faces.map(async (name) => [hash(await readFile(join(outDir, "assets", name))), name])));
    for (const source of ["InterVariable.woff2", "InterVariable-Italic.woff2"]) {
      const bytes = await readFile(join(repoRoot, "src/client/src/assets", source));
      expect(bytes.subarray(0, 4).toString()).toBe("wOF2");
      const name = built.get(hash(bytes));
      expect(name).toBeDefined();
      expect(css).toContain(name);
      if (source === "InterVariable.woff2") expect(references).toContain(`./assets/${name}`);
    }
    expect(css).toContain("InterVariable");
    expect(css).toMatch(/font-display:\s*swap/);
    expect(css).not.toMatch(/url\(["']?https?:/);
    const license = await readFile(join(outDir, "licenses/Inter.txt"), "utf8");
    expect(license).toBe(await readFile(join(repoRoot, "src/client/public/licenses/Inter.txt"), "utf8"));
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("emits deployment-relative HTML and PWA URLs", async () => {
    const outDir = join(repoRoot, "dist/client");
    const html = await readFile(join(outDir, "index.html"), "utf8");
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
