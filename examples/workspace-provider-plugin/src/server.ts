import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderRequestContext,
  ProviderWorkspace,
  WorkspaceProvider,
} from "@jmfederico/pi-web/server-plugin-api";

const markerPath = ".pi-web/example-workspace-provider";

const plugin: PiWebServerPlugin = {
  apiVersion: 1,
  name: "Example Workspace Provider",
  activate({ pluginId, logger }) {
    logger.info("Activating example workspace provider", { pluginId });
    return { workspaceProvider: createWorkspaceProvider(pluginId) };
  },
};

export default plugin;

function createWorkspaceProvider(pluginId: string): WorkspaceProvider {
  return {
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      signal.throwIfAborted();
      try {
        await access(join(project.path, markerPath));
        signal.throwIfAborted();
        return "claim";
      } catch (error) {
        if (isMissingFile(error)) return "pass";
        throw error;
      }
    },
    async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      signal.throwIfAborted();
      return [{
        key: "main",
        path: project.path,
        label: project.name,
        isMain: true,
        // This object is visible to every browser script and API consumer.
        publicMetadata: { kind: "example", marker: markerPath },
      }];
    },
    request(context: ProviderRequestContext) {
      context.signal.throwIfAborted();
      if (context.operation !== "summary") {
        throw new Error(`Unsupported example workspace operation: ${context.operation}`);
      }
      return Promise.resolve(`${pluginId} owns ${context.workspace.label} at ${context.workspace.path}`);
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && Reflect.get(error, "code") === "ENOENT";
}
