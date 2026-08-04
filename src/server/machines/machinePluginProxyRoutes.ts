import type { FastifyInstance, FastifyReply } from "fastify";
import { machineScopedPluginId, parseMachineScopedPluginId, type MachineScopedPluginIdParts } from "../../shared/machinePluginIds.js";
import { PI_WEB_PLUGIN_LIFECYCLE_VERSION } from "../../shared/apiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import { requirePluginBackendRevision } from "../../shared/pluginBackendProtocol.js";
import { RemoteMachineRequestError, type MachineClient } from "./machineClient.js";
import { MachineService } from "./machineService.js";

interface RemotePluginManifestEntry {
  id: string;
  module: string;
  backendRevision?: string;
  source?: string;
  scope?: string;
  machineSpecific?: boolean;
}

interface RemotePluginManifest {
  lifecycleVersion: typeof PI_WEB_PLUGIN_LIFECYCLE_VERSION;
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
    if (request.params.machineId === "local") return { lifecycleVersion: PI_WEB_PLUGIN_LIFECYCLE_VERSION, plugins: [] };

    const client = await machines.remoteClient(request.params.machineId);
    if (client === undefined) return reply.code(404).send({ error: "Machine not found" });

    try {
      const response = await client.requestJson("GET", "/pi-web-plugins/manifest.json", undefined, { timeoutMs: MACHINE_PLUGIN_MANIFEST_TIMEOUT_MS });
      if (response.statusCode === 404) {
        return await sendLifecycleCompatibilityError(reply, request.params.machineId, "The remote machine does not expose a versioned plugin manifest. Update and restart PI WEB on the remote machine.");
      }
      if (response.statusCode < 200 || response.statusCode >= 300) return await reply.code(response.statusCode).send(response.body);
      return rewriteRemotePluginManifest(request.params.machineId, parseRemoteManifest(response.body));
    } catch (error) {
      if (error instanceof RemotePluginLifecycleCompatibilityError) {
        return sendLifecycleCompatibilityError(reply, request.params.machineId, error.message);
      }
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
    lifecycleVersion: manifest.lifecycleVersion,
    plugins: manifest.plugins.flatMap((plugin) => {
      const modulePath = remotePluginModulePath(plugin.id, plugin.module);
      if (modulePath === undefined) return [];
      return [{
        ...plugin,
        module: `../../../../pi-web-plugins/${encodeURIComponent(machineScopedPluginId(machineId, plugin.id))}/${modulePath.path}${modulePath.query}`,
      }];
    }),
  };
}

function remotePluginModulePath(pluginId: string, module: string): { path: string; query: string } | undefined {
  if (!isPiWebPluginId(pluginId)) return undefined;
  const prefix = `/pi-web-plugins/${encodeURIComponent(pluginId)}/`;
  const pluginRootUrl = new URL(prefix, "http://pi-web.local");
  const manifestUrl = new URL("/pi-web-plugins/manifest.json", pluginRootUrl);
  try {
    // An explicit ./<plugin-id>/ prefix is manifest-relative; bare paths retain the legacy plugin-root-relative contract.
    const baseUrl = module.startsWith("./") ? manifestUrl : pluginRootUrl;
    const url = new URL(module, baseUrl);
    if (url.origin !== pluginRootUrl.origin || !url.pathname.startsWith(prefix)) return undefined;
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
  const lifecycleVersion = parseRemoteLifecycleVersion(value["lifecycleVersion"]);
  const plugins = value["plugins"].map((entry) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || !isPiWebPluginId(entry["id"]) || typeof entry["module"] !== "string" || entry["module"] === "") {
      throw new Error("Invalid remote PI WEB plugin manifest entry");
    }
    return {
      id: entry["id"],
      module: entry["module"],
      ...(parseRemoteBackendRevision(entry["backendRevision"])),
      ...(typeof entry["source"] === "string" ? { source: entry["source"] } : {}),
      ...(typeof entry["scope"] === "string" ? { scope: entry["scope"] } : {}),
      ...(parseRemoteMachineSpecific(entry["machineSpecific"])),
    };
  });
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) throw new Error(`Duplicate remote PI WEB plugin id: ${plugin.id}`);
    ids.add(plugin.id);
  }
  return { lifecycleVersion, plugins };
}

function parseRemoteLifecycleVersion(value: unknown): typeof PI_WEB_PLUGIN_LIFECYCLE_VERSION {
  if (value === undefined) {
    throw new RemotePluginLifecycleCompatibilityError("The remote plugin manifest has no lifecycle version. Update and restart PI WEB on the remote machine.");
  }
  if (value !== PI_WEB_PLUGIN_LIFECYCLE_VERSION) {
    throw new RemotePluginLifecycleCompatibilityError(`Unsupported remote plugin lifecycle version: ${formatUnknownValue(value)}`);
  }
  return value;
}

class RemotePluginLifecycleCompatibilityError extends Error {
  override name = "RemotePluginLifecycleCompatibilityError";
}

function parseRemoteBackendRevision(value: unknown): { backendRevision?: string } {
  if (value === undefined) return {};
  try {
    return { backendRevision: requirePluginBackendRevision(value) };
  } catch {
    throw new Error("Invalid remote PI WEB plugin manifest entry");
  }
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

function sendLifecycleCompatibilityError(reply: FastifyReply, machineId: string, detail: string): FastifyReply {
  return reply.code(409).send({
    error: "Remote machine plugin lifecycle is incompatible",
    code: "plugin-lifecycle-incompatible",
    machineId,
    detail,
  });
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

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
