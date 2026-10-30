import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PiWebThemeCatalogResponse } from "../shared/themeCatalog.js";
import type { PiWebThemePreference } from "../shared/apiTypes.js";
import { DEFAULT_THEME_PREFERENCE, parseThemePreference } from "../shared/themePreference.js";
import { isPiWebPluginId } from "../shared/pluginIds.js";
import { PiWebPluginCatalog, readPiWebPluginPackageArtifact, type PiWebPluginCatalogEntry, type PiWebPluginPackageArtifact } from "./piWebPluginCatalog.js";
import type { PiWebConfigService } from "./configRoutes.js";
import { createThemeBootstrap } from "./themeBootstrap.js";

interface ThemeArtifact extends PiWebPluginPackageArtifact {
  pluginId: string;
  packageRoot: string;
  browserRootPath: string;
  browserRootDirectoryPath: string;
}

/** Gateway-owned static assets never depend on plugin runtime activation. */
export class PiWebThemeCatalog {
  private readonly artifacts = new Map<string, ThemeArtifact>();
  private artifactBytes = 0;

  constructor(private readonly catalog: PiWebPluginCatalog) {}

  themes(): Promise<PiWebThemeCatalogResponse> {
    return this.collect();
  }

  selection(preference: PiWebThemePreference): Promise<PiWebThemeCatalogResponse> {
    return this.collect(preference);
  }

  private async collect(preference?: PiWebThemePreference): Promise<PiWebThemeCatalogResponse> {
    const response: PiWebThemeCatalogResponse = { themes: [], themePairs: [] };
    for (const plugin of (await this.catalog.snapshot()).plugins) {
      if (!plugin.enabled || plugin.themes === undefined || plugin.themes.length === 0) continue;
      if (preference !== undefined && !preference.themeId.startsWith(`${plugin.id}:`)) continue;
      const localId = preference?.themeId.slice(plugin.id.length + 1);
      const pair = preference === undefined ? undefined : plugin.themePairs?.find((pair) => pair.light === localId || pair.dark === localId);
      const ids = pair === undefined ? [localId] : [localId, pair.light, pair.dark];
      const selected = preference === undefined ? plugin.themes : plugin.themes.filter((theme) => ids.includes(theme.id));
      if (selected.length === 0) continue;
      const pairs = preference === undefined ? plugin.themePairs ?? [] : pair === undefined ? [] : [pair];
      const artifact = await this.capture(plugin);
      if (artifact === undefined) continue;
      const qualify = (id: string) => `${plugin.id}:${id}`;
      response.themes.push(...selected.map((theme) => ({
        ...theme, id: qualify(theme.id), pluginId: plugin.id,
        stylesheets: theme.stylesheets.map(({ id, path, order }) => ({
          id: qualify(id), url: themeAssetPath(plugin.id, artifact.revision, path),
          ...(order === undefined ? {} : { order }),
        })),
      })));
      response.themePairs.push(...pairs.map((pair) => ({
        ...pair, pluginId: plugin.id, id: qualify(pair.id), light: qualify(pair.light), dark: qualify(pair.dark),
      })));
    }
    return response;
  }

  async readAsset(pluginId: string, path: string, revision?: string): Promise<{ content: Buffer; contentType: string } | undefined> {
    if (!isPiWebPluginId(pluginId)) return undefined;
    // Recheck desired enablement and package identity even for retained snapshots.
    const plugin = (await this.catalog.snapshot()).plugins.find((entry) => entry.id === pluginId && entry.enabled && (entry.themes?.length ?? 0) > 0);
    if (plugin?.browserRoot === undefined) return undefined;
    let artifact = revision === undefined ? undefined : this.artifacts.get(this.key(pluginId, revision));
    if (artifact !== undefined && (artifact.packageRoot !== plugin.packageRoot
      || artifact.browserRootPath !== plugin.browserRoot.path
      || artifact.browserRootDirectoryPath !== plugin.browserRoot.directoryPath)) return undefined;
    artifact ??= await this.capture(plugin);
    if (artifact === undefined || (revision !== undefined && artifact.revision !== revision)) return undefined;
    return this.readArtifact(artifact, path);
  }

  /** Bootstrap-only read of an immutable artifact referenced by this request's catalog.
   * HTTP asset routes must use readAsset(), which rechecks current enablement.
   */
  readCapturedAsset(pluginId: string, path: string, revision: string): { content: Buffer; contentType: string } | undefined {
    const artifact = this.artifacts.get(this.key(pluginId, revision));
    return artifact === undefined ? undefined : this.readArtifact(artifact, path);
  }

  private readArtifact(artifact: ThemeArtifact, path: string): { content: Buffer; contentType: string } | undefined {
    const packagePath = artifact.browserRootPath === "." ? path : `${artifact.browserRootPath}/${path}`;
    const content = artifact.files.get(packagePath);
    if (content === undefined) return undefined;
    this.touch(artifact);
    return { content, contentType: contentTypeFor(path) };
  }

  private async capture(plugin: PiWebPluginCatalogEntry): Promise<ThemeArtifact | undefined> {
    const root = plugin.browserRoot;
    if (root === undefined || plugin.themeRevision === undefined) return undefined;
    const key = this.key(plugin.id, plugin.themeRevision);
    const cached = this.artifacts.get(key);
    if (cached?.packageRoot === plugin.packageRoot
      && cached.browserRootPath === root.path && cached.browserRootDirectoryPath === root.directoryPath) {
      this.touch(cached);
      return cached;
    }
    const snapshot = await readPiWebPluginPackageArtifact(plugin.packageRoot, root).catch(() => undefined);
    if (snapshot?.revision !== plugin.themeRevision) return undefined;
    for (const theme of plugin.themes ?? []) {
      if (theme.stylesheets.some((sheet) => !snapshot.files.has(root.path === "." ? sheet.path : `${root.path}/${sheet.path}`))) return undefined;
    }
    const artifact: ThemeArtifact = {
      ...snapshot, pluginId: plugin.id, packageRoot: plugin.packageRoot,
      browserRootPath: root.path, browserRootDirectoryPath: root.directoryPath,
    };
    if (artifact.byteLength > 64 * 1024 * 1024) return undefined;
    const previous = this.artifacts.get(key);
    if (previous !== undefined) { this.artifacts.delete(key); this.artifactBytes -= previous.byteLength; }
    while (this.artifacts.size >= 32 || this.artifactBytes + artifact.byteLength > 64 * 1024 * 1024) {
      const oldest = this.artifacts.entries().next().value;
      if (oldest === undefined) break;
      this.artifacts.delete(oldest[0]);
      this.artifactBytes -= oldest[1].byteLength;
    }
    this.artifacts.set(key, artifact);
    this.artifactBytes += artifact.byteLength;
    return artifact;
  }

  private key(pluginId: string, revision: string): string { return `${pluginId}/${revision}`; }
  private touch(artifact: ThemeArtifact): void {
    const key = this.key(artifact.pluginId, artifact.revision);
    this.artifacts.delete(key);
    this.artifacts.set(key, artifact);
  }
}

function themeAssetPath(pluginId: string, revision: string, path: string): string {
  // A path revision (not a query) is inherited by CSS relative imports, fonts,
  // and images. Paths are browserRoot-relative and must stay inside that root.
  return `pi-web-theme-assets/${encodeURIComponent(pluginId)}/revisions/${encodeURIComponent(revision)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function registerThemeCatalogRoutes(
  app: FastifyInstance,
  themes: Pick<PiWebThemeCatalog, "themes" | "readAsset"> & Partial<Pick<PiWebThemeCatalog, "readCapturedAsset" | "selection">>,
  config: Pick<PiWebConfigService, "read">,
): void {
  const readCatalog = () => readThemeCatalog(themes, config);
  const readSelection = (preference?: PiWebThemePreference) => readThemeSelection(themes, config, preference);
  app.get("/api/theme-bootstrap", async (_request, reply) => {
    const bootstrap = await createThemeBootstrap(readSelection, themes);
    reply.header("Cache-Control", "private, no-cache");
    return bootstrap === undefined ? reply.code(204).send() : sendThemeJson(_request, reply, bootstrap);
  });
  app.get<{ Querystring: { themeId?: unknown; auto?: unknown } }>("/api/theme", async (request, reply) => {
    reply.header("Cache-Control", "private, no-cache");
    const { themeId, auto } = request.query;
    const preference = auto === "true" || auto === "false"
      ? parseThemePreference({ themeId, auto: auto === "true" }) : undefined;
    if (preference === undefined) return reply.code(400).send({ error: "Expected a qualified themeId and auto=true or auto=false" });
    const bootstrap = await createThemeBootstrap(readSelection, themes, preference);
    return bootstrap === undefined ? reply.code(204).send() : sendThemeJson(request, reply, bootstrap);
  });
  app.get("/api/themes", async (request, reply) => sendThemeJson(request, reply, await readCatalog()));
  app.get<{ Params: { pluginId: string; revision: string; "*": string } }>("/pi-web-theme-assets/:pluginId/revisions/:revision/*", async (request, reply) => {
    const asset = await themes.readAsset(request.params.pluginId, request.params["*"], request.params.revision);
    if (asset === undefined) return reply.header("Cache-Control", "no-store").code(404).send({ error: "Theme asset not found" });
    return reply.header("Cache-Control", "private, max-age=31536000, immutable").type(asset.contentType).send(asset.content);
  });
  app.get<{ Params: { pluginId: string; "*": string } }>("/pi-web-theme-assets/:pluginId/*", async (request, reply) => {
    const asset = await themes.readAsset(request.params.pluginId, request.params["*"]);
    if (asset === undefined) return reply.header("Cache-Control", "no-store").code(404).send({ error: "Theme asset not found" });
    return reply.header("Cache-Control", "private, no-cache").type(asset.contentType).send(asset.content);
  });
}

function sendThemeJson(request: FastifyRequest, reply: FastifyReply, value: unknown): FastifyReply {
  const body = JSON.stringify(value);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  reply.header("Cache-Control", "private, no-cache").header("ETag", etag);
  const condition = request.headers["if-none-match"];
  if (typeof condition === "string" && condition.split(",").some((entry) => {
    const tag = entry.trim();
    return tag === etag || tag === `W/${etag}` || tag === "*";
  })) return reply.code(304).send();
  return reply.type("application/json; charset=utf-8").send(body);
}

export async function readThemeSelection(
  themes: Pick<PiWebThemeCatalog, "themes"> & Partial<Pick<PiWebThemeCatalog, "selection">>,
  config: Pick<PiWebConfigService, "read">,
  requested?: PiWebThemePreference,
): Promise<PiWebThemeCatalogResponse> {
  const policy = await config.read();
  const preference = requested ?? policy.effectiveConfig.defaultTheme ?? DEFAULT_THEME_PREFERENCE;
  const catalog = themes.selection === undefined ? await themes.themes() : await themes.selection(preference);
  return {
    ...catalog,
    ...(policy.effectiveConfig.defaultTheme === undefined ? {} : { defaultTheme: policy.effectiveConfig.defaultTheme }),
    ...(policy.enforcedSettings?.["/defaultTheme"] === undefined ? {} : { enforcedBy: policy.enforcedSettings["/defaultTheme"] }),
  };
}

export async function readThemeCatalog(
  themes: Pick<PiWebThemeCatalog, "themes">,
  config: Pick<PiWebConfigService, "read">,
): Promise<PiWebThemeCatalogResponse> {
  const [catalog, policy] = await Promise.all([themes.themes(), config.read()]);
  const defaultTheme = policy.effectiveConfig.defaultTheme;
  const enforcedBy = policy.enforcedSettings?.["/defaultTheme"];
  return {
    ...catalog,
    ...(defaultTheme === undefined ? {} : { defaultTheme }),
    ...(enforcedBy === undefined ? {} : { enforcedBy }),
  };
}

function contentTypeFor(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}
