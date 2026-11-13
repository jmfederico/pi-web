import type { PluginCapability } from "./pluginApiTypes.js";
import type { PluginWorkspaceSelection } from "./pluginCatalogTypes.js";

/** Explicit saved/default Pi project trust, without auto-trusting resource-free workspaces. */
export interface PluginProjectTrustV1 {
  readonly version: 1;
  readonly get: (selection: PluginWorkspaceSelection) => Promise<boolean>;
}

export const PI_WEB_HOST_PROJECT_TRUST_CAPABILITY: PluginCapability<PluginProjectTrustV1, 1> = Object.freeze({
  pluginId: "pi-web.host", id: "project-trust", version: 1,
  parse(value: unknown): PluginProjectTrustV1 {
    if (typeof value !== "object" || value === null || Reflect.get(value, "version") !== 1) throw new Error("Invalid project trust capability");
    const get: unknown = Reflect.get(value, "get");
    if (typeof get !== "function") throw new Error("Invalid project trust capability");
    return Object.freeze({ version: 1, get: async (selection: PluginWorkspaceSelection) => {
      const result: unknown = await Reflect.apply(get, value, [selection]);
      if (typeof result !== "boolean") throw new Error("Invalid project trust result");
      return result;
    } });
  },
});
