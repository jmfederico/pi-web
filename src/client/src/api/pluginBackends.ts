import type { JsonValue } from "../../../shared/apiTypes";
import { isPiWebPluginId } from "../../../shared/pluginIds";
import {
  cloneBoundedPluginBackendJson,
  parseBoundedPluginBackendJson,
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
  utf8ByteLength,
} from "../../../shared/pluginBackendProtocol";
import { resolveAppUrl, type AppUrlContext } from "../appUrl";

export interface PluginBackendRequestTarget {
  pluginId: string;
  backendRevision: string;
  machineId: string;
  projectId: string;
  workspaceId: string;
}

export function pluginBackendRequestPath(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
): string {
  if (!isPiWebPluginId(target.pluginId)) throw new Error(`Invalid PI WEB plugin id: ${target.pluginId}`);
  if (target.machineId === "") throw new Error("Machine id is required");
  if (target.projectId === "") throw new Error("Project id is required");
  if (target.workspaceId === "") throw new Error("Workspace id is required");
  const validatedOperation = requirePluginBackendOperation(operation);
  const prefix = target.machineId === "local"
    ? "api"
    : `api/machines/${encodeURIComponent(target.machineId)}`;
  return `${prefix}/plugin-backends/${encodeURIComponent(target.pluginId)}/projects/${encodeURIComponent(target.projectId)}/workspaces/${encodeURIComponent(target.workspaceId)}/${encodeURIComponent(validatedOperation)}`;
}

export function pluginBackendRequestUrl(
  target: Pick<PluginBackendRequestTarget, "pluginId" | "machineId" | "projectId" | "workspaceId">,
  operation: string,
  context?: AppUrlContext,
): string {
  const path = pluginBackendRequestPath(target, operation);
  return context === undefined ? resolveAppUrl(path) : resolveAppUrl(path, context);
}

export async function requestPluginBackend(
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
): Promise<JsonValue> {
  const revision = requirePluginBackendRevision(target.backendRevision);
  const clonedInput = cloneBoundedPluginBackendJson(input, "Plugin backend request input");
  const body = JSON.stringify({ revision, input: clonedInput });
  if (utf8ByteLength(body) > PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES) {
    throw new Error(`Plugin backend request exceeds the ${String(PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES)} byte wire limit`);
  }

  let response: Response;
  try {
    response = await fetch(pluginBackendRequestUrl(target, operation), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (error) {
    throw new Error(`Plugin backend request unavailable: ${errorMessage(error)}`, { cause: error });
  }

  const text = await readBoundedResponseText(response);
  if (!response.ok) {
    throw new Error(pluginBackendErrorMessage(text) ?? `Plugin backend request returned HTTP ${String(response.status)}`);
  }
  return parseBoundedPluginBackendJson(text, "Plugin backend response", PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES);
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`Plugin backend response exceeds the ${String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES)} byte wire limit`);
  }
  if (response.body === null) {
    const text = await response.text();
    if (utf8ByteLength(text) > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) throw responseTooLargeError();
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      byteLength += chunk.value.byteLength;
      if (byteLength > PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES) {
        await reader.cancel();
        throw responseTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseTooLargeError(): Error {
  return new Error(`Plugin backend response exceeds the ${String(PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES)} byte wire limit`);
}

function pluginBackendErrorMessage(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && typeof value["error"] === "string" ? value["error"] : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
