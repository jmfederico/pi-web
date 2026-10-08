import type { createEventBus } from "@earendil-works/pi-coding-agent";
import type { PluginBackend } from "../../shared/pluginApiTypes.js";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import type { PluginBackendRegistry } from "../plugins/pluginBackendRegistry.js";

export type CompanionBackendDispatcher = Pick<PluginBackendRegistry, "requestMachine">;

/** In-process service discovery only. The host registry owns all JSON dispatch and bounds. */
export function bindCompanionBackend(
  bus: ReturnType<typeof createEventBus>,
  backends: CompanionBackendDispatcher,
): () => void {
  const lifetime = new AbortController();
  const detach = bus.on("pi-web:companion-backend:v1", (query: unknown) => {
    if (!isBackendQuery(query)) return;
    const pluginId = query.pluginId;
    const backend = Object.freeze<PluginBackend>({
      version: 1,
      request: async (operation, input, options = {}) => {
        lifetime.signal.throwIfAborted();
        const signal = options.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, options.signal]);
        return await backends.requestMachine({ pluginId, operation, input }, signal);
      },
    });
    query.accept(backend);
  });
  return () => {
    detach();
    lifetime.abort(new Error("Hosted companion backend lifetime ended"));
  };
}

function isBackendQuery(value: unknown): value is { version: 1; pluginId: string; accept: (backend: PluginBackend) => void } {
  return typeof value === "object" && value !== null
    && "version" in value && value.version === 1
    && "pluginId" in value && typeof value.pluginId === "string" && isPiWebPluginId(value.pluginId)
    && "accept" in value && typeof value.accept === "function";
}
