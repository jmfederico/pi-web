import { mkdtemp, mkdir, writeFile, rm, symlink, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiWebConfig } from "../config.js";
import type { PiWebThemeBootstrap, PiWebThemeCatalogResponse } from "../shared/themeCatalog.js";
import { defaultPluginRoots, PiWebPluginCatalog } from "./piWebPluginCatalog.js";
import { PiWebThemeCatalog } from "./themeCatalog.js";
import { buildApp } from "./app.js";
import { parseThemeMetadata } from "./themeMetadata.js";

const metadata = {
  id: "palette", browserRoot: "public",
  themes: [
    { id: "day", name: "Day", colorScheme: "light", stylesheets: [{ id: "base", path: "css/day #1.css", order: -1 }] },
    { id: "night", name: "Night", colorScheme: "dark", description: "A dark palette", order: 2, stylesheets: [{ id: "base", path: "night.css" }] },
  ],
  themePairs: [{ id: "system", name: "System", light: "day", dark: "night" }],
};

let root: string;
let config: PiWebConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "theme-catalog-"));
  config = {};
  await mkdir(join(root, "public", "css"), { recursive: true });
  await mkdir(join(root, "public", "fonts"));
  await writeFile(join(root, "package.json"), JSON.stringify({ piWeb: { plugins: [metadata] } }));
  await writeFile(join(root, "public", "css", "day #1.css"), "@font-face { src: url('../fonts/font.woff2'); }");
  await writeFile(join(root, "public", "night.css"), ":root { color-scheme: dark; }");
  await writeFile(join(root, "public", "fonts", "font.woff2"), "font bytes");
  await writeFile(join(root, "secret.txt"), "private");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function catalog() {
  return new PiWebPluginCatalog({
    roots: [],
    // A configured local Pi package needs no JS entry or runtime snapshot.
    packageProvider: { listPackages: () => [{ source: root, scope: "user", installedPath: root }], getInstalledPath: () => root },
    configProvider: () => config,
    warningSink: () => { /* Diagnostics are asserted by the caller. */ },
  });
}

describe("static gateway theme catalog", () => {
  it("discovers Playground only in a source checkout and publishes it only when enabled", async () => {
    await cp(new URL("../../plugins/playground", import.meta.url), join(root, "plugins", "playground"), { recursive: true });
    const checkoutRoots = () => defaultPluginRoots(root).filter((entry) => entry.source === "dev");
    expect(checkoutRoots()).toEqual([]);
    await mkdir(join(root, "src", "server"), { recursive: true });
    await writeFile(join(root, "src", "server", "index.ts"), "");
    const plugins = new PiWebPluginCatalog({ roots: checkoutRoots(), packageProvider: false, configProvider: () => config });
    expect((await plugins.snapshot()).plugins).toMatchObject([{ id: "playground", enabled: false, defaultEnabled: false, source: "dev" }]);
    const themes = new PiWebThemeCatalog(plugins);
    expect(await themes.themes()).toEqual({ themes: [], themePairs: [] });
    expect(await themes.readAsset("playground", "playground.css")).toBeUndefined();

    config = { plugins: { playground: { enabled: true } } };
    const enabled = await themes.themes();
    expect(enabled.themes.map(({ id }) => id)).toEqual(["playground:playground-dark", "playground:playground-light"]);
    expect(enabled.themePairs).toMatchObject([{ id: "playground:playground", light: "playground:playground-light", dark: "playground:playground-dark" }]);
    expect((await themes.readAsset("playground", "playground.css"))?.content.toString()).toContain("--playground-speaker-shape");
    config = { plugins: { playground: { enabled: false } } };
    expect(await themes.themes()).toEqual({ themes: [], themePairs: [] });
    expect(await themes.readAsset("playground", "playground.css")).toBeUndefined();
  });

  it("publishes qualified themes and pairs without any runtime and serves revision-in-path dependencies", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ piWeb: { plugins: [{
      ...metadata, themes: [...metadata.themes, { ...metadata.themes[1], id: "extra", name: "Extra" }],
    }] } }));
    const service = new PiWebThemeCatalog(catalog());
    await writeFile(join(root, "index.html"), '<script id="pi-web-theme-data" type="application/json"></script>');
    const app = await buildApp({
      themeCatalog: service, clientDist: root, logger: false,
      agentProfileProvider: { getActiveAgentProfile: () => { throw new Error("Static themes must not wait for sessiond"); } },
      config: {
        read: () => ({ path: "config.json", exists: true, config: {}, effectiveConfig: { defaultTheme: { themeId: "palette:day", auto: true } }, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false }, enforcedSettings: { "/defaultTheme": "PI_WEB_DEFAULT_THEME" } }),
        write: () => { throw new Error("Unexpected config write"); },
      },
    });
    try {
      const response = await app.inject("/api/themes");
      expect(response.statusCode).toBe(200);
      const body = response.json<PiWebThemeCatalogResponse>();
      expect(body).toMatchObject({
        themes: [{ id: "palette:day", pluginId: "palette", name: "Day", colorScheme: "light" }, { id: "palette:night", description: "A dark palette", order: 2 }, { id: "palette:extra" }],
        themePairs: [{ id: "palette:system", light: "palette:day", dark: "palette:night", pluginId: "palette" }],
        defaultTheme: { themeId: "palette:day", auto: true }, enforcedBy: "PI_WEB_DEFAULT_THEME",
      });
      expect(response.headers["cache-control"]).toBe("private, no-cache");
      const bootstrap = (await app.inject("/api/theme-bootstrap")).json<PiWebThemeBootstrap>();
      expect(bootstrap.catalog).toEqual({ ...body, themes: body.themes.slice(0, 2) });
      expect(bootstrap.stylesheets.map((sheet) => sheet.url)).toEqual(body.themes.slice(0, 2).flatMap((theme) => theme.stylesheets.map((sheet) => sheet.url)));
      const targeted = await app.inject("/api/theme?themeId=palette%3Aextra&auto=false");
      expect(targeted.statusCode).toBe(200);
      const targetedData = targeted.json<PiWebThemeBootstrap>();
      expect(targetedData.catalog.themes.map((theme) => theme.id)).toEqual(["palette:extra"]);
      expect(targetedData.catalog.defaultTheme).toEqual(body.defaultTheme);
      expect(targetedData.catalog.enforcedBy).toBe("PI_WEB_DEFAULT_THEME");
      expect(targetedData.stylesheets).toHaveLength(1);
      expect(bootstrap.stylesheets[0]?.cssText).toContain("url('../fonts/font.woff2')");
      for (const path of ["/", "/index.html", "/workspace/deep/link"]) {
        const html = await app.inject(path);
        expect(html.statusCode).toBe(200);
        expect(html.headers["cache-control"]).toBe("private, no-cache");
        const data = /<script[^>]*>([\s\S]*?)<\/script>/u.exec(html.body)?.[1] ?? "";
        expect(JSON.parse(data)).toEqual(bootstrap);
      }
      const stylesheet = body.themes[0]?.stylesheets[0];
      expect(stylesheet).toMatchObject({ id: "palette:base", order: -1 });
      expect(stylesheet?.url).toMatch(/^pi-web-theme-assets\/palette\/revisions\/sha256%3A[a-f\d]{64}\/css\/day%20%231.css$/u);
      const cssUrl = new URL(stylesheet?.url ?? "", "https://example.test/nested/");
      const css = await app.inject(cssUrl.pathname.replace("/nested", ""));
      expect(css.statusCode).toBe(200);
      expect(css.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
      expect(css.headers["content-type"]).toContain("text/css");
      const fontUrl = new URL("../fonts/font.woff2", cssUrl);
      const font = await app.inject(fontUrl.pathname.replace("/nested", ""));
      expect(font.body).toBe("font bytes");
      expect(font.headers["cache-control"]).toContain("immutable");
      expect(font.headers["content-type"]).toBe("font/woff2");
      const badRevision = await app.inject(cssUrl.pathname.replace("/nested", "").replace(/sha256%3A[a-f\d]{64}/u, "unknown"));
      expect(badRevision.statusCode).toBe(404);
      expect(badRevision.headers["cache-control"]).toBe("no-store");
      const unversioned = await app.inject("/pi-web-theme-assets/palette/night.css");
      expect(unversioned.headers["cache-control"]).toBe("private, no-cache");
      expect((await app.inject("/pi-web-theme-assets/palette/secret.txt")).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it.each(["legacy:runtime", "palette:missing"])("delivers Classic in initial HTML for unavailable default %s while preserving intended policy", async (themeId) => {
    const bundledRoot = join(root, "bundled");
    const packageRoot = join(bundledRoot, "themes");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ piWeb: { plugins: [{
      id: "themes", browserRoot: ".",
      themes: [{ id: "classic", name: "Classic", colorScheme: "dark", stylesheets: [{ id: "palette", path: "classic.css" }] }],
    }] } }));
    const cssText = ":root { --pi-bg: #123456; }";
    await writeFile(join(packageRoot, "classic.css"), cssText);
    await writeFile(join(root, "index.html"), '<script id="pi-web-theme-data" type="application/json"></script>');
    const service = new PiWebThemeCatalog(new PiWebPluginCatalog({
      roots: [{ path: bundledRoot, source: "bundled", scope: "bundled" }], packageProvider: false,
    }));
    const defaultTheme = { themeId, auto: true };
    const app = await buildApp({
      themeCatalog: service, clientDist: root, logger: false,
      config: {
        read: () => ({ path: "config.json", exists: true, config: {}, effectiveConfig: { defaultTheme }, envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false }, enforcedSettings: { "/defaultTheme": "PI_WEB_DEFAULT_THEME" } }),
        write: () => { throw new Error("Unexpected config write"); },
      },
    });
    try {
      const bootstrap = (await app.inject("/api/theme-bootstrap")).json<PiWebThemeBootstrap>();
      expect(bootstrap.catalog).toMatchObject({ defaultTheme, enforcedBy: "PI_WEB_DEFAULT_THEME", themePairs: [] });
      expect(bootstrap.catalog.themes.map((theme) => theme.id)).toEqual(["themes:classic"]);
      expect(bootstrap.stylesheets).toEqual([{ url: bootstrap.catalog.themes[0]?.stylesheets[0]?.url, cssText }]);
      const html = await app.inject("/");
      expect(html.statusCode).toBe(200);
      expect(JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/u.exec(html.body)?.[1] ?? "")).toEqual(bootstrap);
      const explicit = await app.inject(`/api/theme?themeId=${encodeURIComponent(themeId)}&auto=true`);
      expect(explicit.statusCode).toBe(200);
      expect(explicit.json()).toEqual({ catalog: { themes: [], themePairs: [], defaultTheme, enforcedBy: "PI_WEB_DEFAULT_THEME" }, stylesheets: [] });
    } finally { await app.close(); }
  });

  it("serves targeted static metadata and CSS, leaving unknown runtime themes unresolved", async () => {
    const app = await buildApp({
      themeCatalog: new PiWebThemeCatalog(catalog()), logger: false,
      agentProfileProvider: { getActiveAgentProfile: () => { throw new Error("No runtime required"); } },
    });
    try {
      for (const auto of [false, true]) {
        const response = await app.inject(`/api/theme?themeId=palette%3Aday&auto=${String(auto)}`);
        expect(response.statusCode).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, no-cache");
        const bootstrap = response.json<PiWebThemeBootstrap>();
        expect(bootstrap.catalog.themes.map((theme) => theme.id)).toEqual(["palette:day", "palette:night"]);
        expect(bootstrap.catalog.themePairs).toHaveLength(1);
        expect(bootstrap.stylesheets).toHaveLength(auto ? 2 : 1);
      }
      for (const themeId of ["legacy:runtime", "palette:missing", "palette:system"]) {
        const response = await app.inject(`/api/theme?themeId=${encodeURIComponent(themeId)}&auto=true`);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ catalog: { themes: [], themePairs: [] }, stylesheets: [] });
      }
      for (const query of ["", "?themeId=palette%3Aday", "?auto=true", "?themeId=day&auto=true", "?themeId=palette%3Aday%3Aextra&auto=true", "?themeId=palette%3Aday&auto=1", "?themeId=palette%3Aday&auto=True", "?themeId=palette%3Aday&auto=", "?themeId=palette%3Aday&auto=true&auto=false", "?themeId=palette%3Aday&themeId=palette%3Anight&auto=true"]) {
        expect((await app.inject(`/api/theme${query}`)).statusCode, query).toBe(400);
      }
    } finally { await app.close(); }
  });

  it("revalidates targeted response caches without resending unchanged CSS and invalidates changed or disabled themes", async () => {
    const app = await buildApp({ themeCatalog: new PiWebThemeCatalog(catalog()), logger: false, clientDist: false });
    const url = "/api/theme?themeId=palette%3Aday&auto=false";
    try {
      const first = await app.inject(url);
      const etag = first.headers.etag;
      if (typeof etag !== "string") throw new Error("Expected theme response validator");
      const cached = await app.inject({ url, headers: { "if-none-match": etag } });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
      await writeFile(join(root, "public", "css", "day #1.css"), ":root { --pi-bg: #abc; }");
      const changed = await app.inject({ url, headers: { "if-none-match": etag } });
      expect(changed.statusCode).toBe(200);
      expect(changed.headers.etag).not.toBe(etag);
      expect(changed.json<PiWebThemeBootstrap>().stylesheets[0]?.cssText).toContain("#abc");
      config = { plugins: { palette: { enabled: false } } };
      const disabled = await app.inject({ url, headers: { "if-none-match": String(changed.headers.etag) } });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json<PiWebThemeBootstrap>().catalog.themes).toEqual([]);
    } finally { await app.close(); }
  });

  it("retains validated immutable bytes but revalidates unversioned assets and enablement", async () => {
    const service = new PiWebThemeCatalog(catalog());
    const initial = await service.themes();
    const revision = decodeURIComponent(initial.themes[0]?.stylesheets[0]?.url.split("/")[3] ?? "");
    const initialCss = (await service.readAsset("palette", "night.css", revision))?.content.toString();
    await writeFile(join(root, "public", "night.css"), "updated");
    expect((await service.readAsset("palette", "night.css", revision))?.content.toString()).toBe(initialCss);
    expect((await service.readAsset("palette", "night.css"))?.content.toString()).toBe("updated");
    const refreshed = await service.themes();
    expect(refreshed.themes[0]?.stylesheets[0]?.url).not.toBe(initial.themes[0]?.stylesheets[0]?.url);
    config = { plugins: { palette: { enabled: false } } };
    expect(await service.themes()).toEqual({ themes: [], themePairs: [] });
    expect(await service.readAsset("palette", "night.css", revision)).toBeUndefined();
  });

  it.each(["../secret.txt", "/etc/passwd", "css/../night.css", "C:\\escape.css"])("rejects unsafe stylesheet metadata %s", async (path) => {
    const changed = structuredClone(metadata);
    const sheet = changed.themes[0]?.stylesheets[0];
    if (sheet === undefined) throw new Error("Missing fixture stylesheet");
    sheet.path = path;
    await writeFile(join(root, "package.json"), JSON.stringify({ piWeb: { plugins: [changed] } }));
    const snapshot = await catalog().snapshot();
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.diagnostics).toHaveLength(1);
  });

  it("accepts the reserved themes ID only from a trusted bundled root", async () => {
    const bundledRoot = join(root, "bundled");
    const packageRoot = join(bundledRoot, "themes");
    await mkdir(packageRoot, { recursive: true });
    await cp(join(root, "public"), join(packageRoot, "public"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ piWeb: { plugins: [{ ...metadata, id: "themes" }] } }));
    const bundled = new PiWebThemeCatalog(new PiWebPluginCatalog({ roots: [{ path: bundledRoot, source: "bundled", scope: "bundled" }], packageProvider: false }));
    expect((await bundled.themes()).themes.map((theme) => theme.id)).toEqual(["themes:day", "themes:night"]);
    const external = new PiWebPluginCatalog({ roots: [{ path: bundledRoot, source: "external", scope: "local" }], packageProvider: false, warningSink: () => { /* Expected reserved-ID diagnostic. */ } });
    const rejected = await external.snapshot();
    expect(rejected.plugins).toEqual([]);
    expect(rejected.diagnostics[0]?.code).toBe("reserved-id");
  });

  it("rejects missing stylesheets and symlinks outside browserRoot", async () => {
    await rm(join(root, "public", "night.css"));
    expect((await catalog().snapshot()).plugins).toEqual([]);
    await symlink(join(root, "secret.txt"), join(root, "public", "night.css"));
    expect((await catalog().snapshot()).plugins).toEqual([]);
  });
});

describe("theme metadata validation", () => {
  it.each([
    { themes: {} },
    { themes: [{ ...metadata.themes[0], colorScheme: "system" }] },
    { themes: [{ ...metadata.themes[0], order: Infinity }] },
    { themes: [{ ...metadata.themes[0], stylesheets: [] }] },
    { themes: [metadata.themes[0], metadata.themes[0]] },
    { themes: [{ ...metadata.themes[0], id: "plugin:qualified" }] },
    { ...metadata, themePairs: [{ id: "system", name: "System", light: "night", dark: "day" }] },
    { ...metadata, themePairs: [{ id: "day", name: "Collision", light: "day", dark: "night" }] },
  ])("rejects malformed or ambiguous metadata %#", (entry) => {
    expect(() => parseThemeMetadata(entry, "package.json")).toThrow("Invalid PI WEB theme metadata");
  });
});
