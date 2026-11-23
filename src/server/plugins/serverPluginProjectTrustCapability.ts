import { ProjectTrustStore, SettingsManager } from "../../piSdk.js";
import { PI_WEB_HOST_PROJECT_TRUST_CAPABILITY, type PluginProjectTrustV1 } from "../../shared/pluginProjectTrustTypes.js";
import type { PluginWorkspaceSelection } from "../../shared/pluginCatalogTypes.js";
import { createServerPluginWorkspacesCapabilityFactory, type CreateServerPluginWorkspacesCapabilityOptions } from "./serverPluginWorkspacesCapability.js";
import type { ServerPluginHostCapabilityContext, ServerPluginHostCapabilityFactory } from "./serverPluginRuntime.js";

export function createServerPluginProjectTrustCapabilityFactory(
  options: CreateServerPluginWorkspacesCapabilityOptions & { readonly agentDir: string },
): ServerPluginHostCapabilityFactory<PluginProjectTrustV1> {
  const workspaces = createServerPluginWorkspacesCapabilityFactory(options);
  return Object.freeze({
    capability: PI_WEB_HOST_PROJECT_TRUST_CAPABILITY,
    create(context: ServerPluginHostCapabilityContext) {
      const disposal = new AbortController();
      const signal = AbortSignal.any([context.lifetimeSignal, disposal.signal]);
      const authority = workspaces.create({ ...context, lifetimeSignal: signal }).value;
      return Object.freeze({
        value: PI_WEB_HOST_PROJECT_TRUST_CAPABILITY.parse({
          version: 1,
          get: async (selection: PluginWorkspaceSelection): Promise<boolean> => {
            const { workspace } = await authority.resolve(selection);
            signal.throwIfAborted();
            const saved = new ProjectTrustStore(options.agentDir).get(workspace.path);
            if (saved !== null) return saved;
            return SettingsManager.create(workspace.path, options.agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
          },
        }),
        dispose: () => { disposal.abort(); },
      });
    },
  });
}
