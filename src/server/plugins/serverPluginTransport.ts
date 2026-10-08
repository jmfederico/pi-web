import type { ServerPluginTransportRequest, ServerPluginTransportV1 } from "../../server-plugin-api.js";
import {
  cloneBoundedPluginBackendJson,
  parseBoundedPluginBackendJson,
  PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
  PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
} from "../../shared/pluginBackendProtocol.js";
import { readBoundedRemoteBody } from "../machines/boundedRemoteBody.js";
import type { MachineService } from "../machines/machineService.js";
import type { ServerPluginHostCapabilityContext } from "./serverPluginRuntime.js";

/** Captures only host-attributed plugin identity; never accepts a URL or another plugin id. */
export function createServerPluginTransport(
  context: ServerPluginHostCapabilityContext,
  machines: Pick<MachineService, "remoteClient">,
): ServerPluginTransportV1 {
  return Object.freeze({
    version: 1,
    async request(request: ServerPluginTransportRequest) {
      if (!(request.signal instanceof AbortSignal)) throw new Error("Plugin transport requires an operation signal");
      const machineId = request.machineId;
      if (typeof machineId !== "string" || machineId === "" || machineId === "local" || machineId.length > 512) {
        throw new Error("Plugin transport requires a registered remote machine id");
      }
      const operation = requirePluginBackendOperation(request.operation);
      const input = cloneBoundedPluginBackendJson(request.input, "Plugin transport input");
      const deadline = new AbortController();
      const signal = AbortSignal.any([request.signal, context.lifetimeSignal, deadline.signal]);
      const timer = setTimeout(() => {
        deadline.abort(new Error("Plugin transport request timed out"));
      }, PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS);
      timer.unref();
      try {
        signal.throwIfAborted();
        const client = await machines.remoteClient(machineId);
        signal.throwIfAborted();
        if (client === undefined) throw new Error(`Registered machine not found: ${machineId}`);
        const path = `/api/plugin-backends/${encodeURIComponent(context.pluginId)}/${encodeURIComponent(operation)}`;
        const response = await client.request("POST", path, { version: 1, input }, {
          signal,
          timeoutMs: PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
        });
        if (response.body === undefined) throw new Error("Remote plugin backend returned an empty response");
        const body = await readBoundedRemoteBody(
          response.body,
          PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES,
          PLUGIN_BACKEND_FEDERATION_TIMEOUT_MS,
          signal,
        );
        const result = parseBoundedPluginBackendJson(body.toString("utf8"), "Remote plugin backend response", PLUGIN_BACKEND_RESPONSE_BODY_MAX_BYTES);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = result !== null && typeof result === "object" && !Array.isArray(result)
            && "error" in result && typeof result["error"] === "string" ? result["error"].slice(0, 2_048) : "Request failed";
          throw new Error(`Server plugin ${context.pluginId} on machine ${machineId} returned HTTP ${String(response.statusCode)}: ${detail}`);
        }
        return cloneBoundedPluginBackendJson(result, "Remote plugin backend result", PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES);
      } finally {
        clearTimeout(timer);
        if (!deadline.signal.aborted) deadline.abort(new DOMException("Plugin transport request settled", "AbortError"));
      }
    },
  });
}
