import type { FastifyInstance, FastifyReply } from "fastify";
import { machineScopedPluginId, parseMachineScopedPluginId, type MachineScopedPluginIdParts } from "../../shared/machinePluginIds.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { RemoteMachineRequestError, type MachineClient } from "./machineClient.js";
import { MachineService } from "./machineService.js";

interface RemotePluginManifestEntry {
  id: string;
  module: string;
  source?: string;
  scope?: string;
  machineSpecific?: boolean;
}

interface RemotePluginManifest {
  plugins: RemotePluginManifestEntry[];
}

interface MachinePluginProxyMachines {
  remoteClient(id: string): Promise<MachineClient | undefined>;
}

const MACHINE_PLUGIN_MANIFEST_TIMEOUT_MS = 10_000;

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "last-modified",
  "etag",
  "content-security-policy",
  "x-content-type-options",
]);

export function registerMachinePluginProxyRoutes(app: FastifyInstance, machines: MachinePluginProxyMachines = new MachineService()): void {
  app.get<{ Params: { machineId: string } }>("/api/machines/:machineId/pi-web-plugins/manifest.json", async (request, reply) => {
    if (request.params.machineId === "local") return { plugins: [] };

    const client = await machines.remoteClient(request.params.machineId);
    if (client === undefined) return reply.code(404).send({ error: "Machine not found" });

    try {
      const response = await client.requestJson("GET", "/pi-web-plugins/manifest.json", undefined, { timeoutMs: MACHINE_PLUGIN_MANIFEST_TIMEOUT_MS });
      if (response.statusCode === 404) return { plugins: [] };
      if (response.statusCode < 200 || response.statusCode >= 300) return await reply.code(response.statusCode).send(response.body);
      return rewriteRemotePluginManifest(request.params.machineId, parseRemoteManifest(response.body));
    } catch (error) {
      return sendGatewayError(reply, request.params.machineId, error);
    }
  });
}

export async function proxyMachinePluginAsset(machines: MachinePluginProxyMachines, scopedPluginId: string, assetPath: string, requestUrl: string, reply: FastifyReply): Promise<boolean> {
  const remotePlugin = parseMachineScopedPluginId(scopedPluginId);
  if (remotePlugin === undefined) return false;

  const client = await machines.remoteClient(remotePlugin.machineId);
  if (client === undefined) {
    await reply.code(404).send({ error: "Machine not found" });
    return true;
  }

  const requestPath = remotePluginAssetRequestPath(remotePlugin, assetPath, requestUrl);
  if (requestPath === undefined) {
    await reply.code(400).send({ error: "Invalid remote PI WEB plugin asset path" });
    return true;
  }

  try {
    const upstream = await client.request("GET", requestPath);
    reply.code(upstream.statusCode);
    applySafeHeaders(reply, upstream.headers);
    if (upstream.body === undefined) await reply.send();
    else await reply.send(upstream.body);
    return true;
  } catch (error) {
    sendGatewayError(reply, remotePlugin.machineId, error);
    return true;
  }
}

function rewriteRemotePluginManifest(machineId: string, manifest: RemotePluginManifest): RemotePluginManifest {
  return {
    plugins: manifest.plugins.flatMap((plugin) => {
      const modulePath = remotePluginModulePath(plugin.id, plugin.module);
      if (modulePath === undefined) return [];
      return [{
        ...plugin,
        module: `${piWebBasePath()}/pi-web-plugins/${encodeURIComponent(machineScopedPluginId(machineId, plugin.id))}/${modulePath.path}${modulePath.query}`,
      }];
    }),
  };
}

function remotePluginModulePath(pluginId: string, module: string): { path: string; query: string } | undefined {
  if (!isPiWebPluginId(pluginId)) return undefined;
  const prefix = `/pi-web-plugins/${encodeURIComponent(pluginId)}/`;
  const base = new URL(prefix, "http://pi-web.local");
  try {
    const url = new URL(module, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return undefined;
    const path = safeRemotePluginAssetPath(url.pathname.slice(prefix.length));
    return path === undefined ? undefined : { path, query: url.search };
  } catch {
    return undefined;
  }
}

function remotePluginAssetRequestPath(remotePlugin: MachineScopedPluginIdParts, assetPath: string, requestUrl: string): string | undefined {
  const path = safeRemotePluginAssetPath(assetPath);
  if (path === undefined) return undefined;
  const query = requestUrl.includes("?") ? requestUrl.slice(requestUrl.indexOf("?")) : "";
  return `/pi-web-plugins/${encodeURIComponent(remotePlugin.pluginId)}/${path}${query}`;
}

function safeRemotePluginAssetPath(path: string): string | undefined {
  const segments: string[] = [];
  for (const rawSegment of path.split("/")) {
    const segment = safeRemotePluginAssetPathSegment(rawSegment);
    if (segment === undefined) return undefined;
    if (segment === "") continue;
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function safeRemotePluginAssetPathSegment(rawSegment: string): string | undefined {
  if (rawSegment === "" || rawSegment === ".") return "";
  if (/%(?:2f|5c)/iu.test(rawSegment)) return undefined;
  let segment: string;
  try {
    segment = decodeURIComponent(rawSegment);
  } catch {
    return undefined;
  }
  if (segment === "" || segment === ".") return "";
  if (segment === ".." || segment.includes("/") || segment.includes("\\") || hasControlCharacter(segment)) return undefined;
  return segment;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseRemoteManifest(value: unknown): RemotePluginManifest {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) throw new Error("Invalid remote PI WEB plugin manifest");
  return {
    plugins: value["plugins"].map((entry) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || !isPiWebPluginId(entry["id"]) || typeof entry["module"] !== "string" || entry["module"] === "") {
        throw new Error("Invalid remote PI WEB plugin manifest entry");
      }
      return {
        id: entry["id"],
        module: entry["module"],
        ...(typeof entry["source"] === "string" ? { source: entry["source"] } : {}),
        ...(typeof entry["scope"] === "string" ? { scope: entry["scope"] } : {}),
        ...(parseRemoteMachineSpecific(entry["machineSpecific"])),
      };
    }),
  };
}

function parseRemoteMachineSpecific(value: unknown): { machineSpecific?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error("Invalid remote PI WEB plugin manifest entry");
  return { machineSpecific: value };
}

function applySafeHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (!SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    reply.header(name, value);
  }
}

function sendGatewayError(reply: FastifyReply, machineId: string, error: unknown): FastifyReply {
  const statusCode = error instanceof RemoteMachineRequestError ? error.statusCode : 502;
  const label = statusCode === 504 ? "Remote machine timeout" : "Remote machine unavailable";
  return reply.code(statusCode).send({
    error: label,
    machineId,
    statusCode,
    detail: error instanceof Error ? error.message : String(error),
  });
}

function piWebBasePath(): string {
  const basePath = process.env["PI_WEB_BASE_PATH"] ?? "";
  return basePath.replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
